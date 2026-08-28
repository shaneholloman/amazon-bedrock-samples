/**
 * bmkb-doc-chat — SHARED API CONTRACTS (single source of truth).
 *
 * Every package (lambdas, frontend, tests, benchmark, infra) imports these
 * types from `@bmkb/common`. Do not redefine these shapes anywhere else.
 *
 * Verified constraints baked into these contracts (see
 * the README (Verified quotas), and live Service Quotas):
 *   - Files per IngestKnowledgeBaseDocuments request = 10 (MKB L-30E8CCBD).
 *   - Inline payload ceiling per request = 6 MB (doc-only).
 *   - Per-file size on the S3 path = 50 MB.
 *   - Tenant metadata key = "tenant_id" (plain; underscore prefix reserved).
 *   - Retrieval isolation = EXPLICIT filter, operator "equals" (or "in").
 */

// ===========================================================================
// Primitive / shared aliases
// ===========================================================================

/** ISO-8601 UTC timestamp, e.g. "2026-06-19T12:34:56.000Z". */
export type IsoTimestamp = string;

/** Tenant identifier. Opaque, non-empty, never underscore-prefixed key value. */
export type TenantId = string;

/** Deterministic, idempotent document identifier (see document-id.ts). */
export type DocumentId = string;

// ===========================================================================
// Supported file formats (verified allowlist, F6)
// ===========================================================================

/** Allowlisted upload formats. Anything else is rejected at the upload edge. */
export const SUPPORTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.html',
  '.doc',
  '.docx',
  '.csv',
  '.xls',
  '.xlsx',
  '.pdf',
] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

/** MIME types we accept, mapped 1:1 from the extension allowlist. */
export const SUPPORTED_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/html',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

// ===========================================================================
// Document status (DynamoDB-backed lifecycle)
// ===========================================================================

/**
 * Document lifecycle status surfaced to the UI.
 * PENDING  → enqueued / submitted to Bedrock, not yet indexed.
 * INDEXED  → queryable via Retrieve/RetrieveAndGenerate.
 * FAILED   → terminal failure (validation, ingestion error, or DLQ).
 */
export enum DocStatus {
  PENDING = 'PENDING',
  INDEXED = 'INDEXED',
  FAILED = 'FAILED',
  DELETED = 'DELETED',
}

/** How a document's bytes reach Bedrock (decided by the size router). */
export enum IngestPath {
  /** Base64/text bytes sent inline in IngestKnowledgeBaseDocuments (<= 6 MB). */
  INLINE = 'INLINE',
  /** S3 object reference (large/binary, up to 50 MB). */
  S3 = 'S3',
}

// ===========================================================================
// Tenant context (resolved from the authenticated caller)
// ===========================================================================

/**
 * The authenticated caller's tenant scope. Produced by the API authorizer /
 * upload edge and threaded through ingest + chat. A request with no resolvable
 * TenantContext MUST be denied (never defaulted, never widened).
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  /** Optional sub-identity for auditing; NOT a security boundary by itself. */
  readonly userId?: string;
}

// ===========================================================================
// Bedrock retrieval filter (explicit tenant isolation — F11/F13)
// ===========================================================================

/**
 * The ONLY metadata operators MKB supports for filtering are equals/in
 * (plus greaterThan/lessThan/notIn). startsWith/stringContains are NOT
 * supported. Tenant isolation uses `equals` (single) or `in` (multi).
 */
export interface EqualsFilter {
  readonly equals: {
    readonly key: string;
    readonly value: string;
  };
}

export interface InFilter {
  readonly in: {
    readonly key: string;
    readonly value: readonly string[];
  };
}

/** The retrieval filter shape passed to Retrieve / RetrieveAndGenerate. */
export type RetrievalFilter = EqualsFilter | InFilter;

// ===========================================================================
// Inline metadata attribute (attached at ingest time — F11/F12)
// ===========================================================================

/**
 * A single inline metadata attribute attached to a document on ingest.
 * `key` MUST be a plain key (no leading underscore — reserved on managed KB).
 */
export interface MetadataAttribute {
  readonly key: string;
  readonly value: string;
}

// ===========================================================================
// POST /upload
// ===========================================================================

/**
 * Upload request. Either `contentBase64` (inline path) OR a client that will
 * PUT to the returned presigned URL (S3 path). The size router decides which,
 * driven by `sizeBytes` + `contentType`.
 */
export interface UploadRequest {
  readonly filename: string;
  readonly contentType: SupportedMimeType;
  readonly sizeBytes: number;
  /**
   * Base64-encoded bytes for the inline fast path. Present only when the
   * client already holds the (small) file; omit to receive a presigned URL.
   */
  readonly contentBase64?: string;
  /** Optional client-supplied opaque metadata (NOT trusted for tenancy). */
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface UploadResponse {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly status: DocStatus;
  readonly ingestPath: IngestPath;
  /** Present when ingestPath === S3 and the client must PUT the bytes. */
  readonly uploadUrl?: string;
  /** S3 key reserved for this document (S3 path only). */
  readonly s3Key?: string;
  readonly createdAt: IsoTimestamp;
}

// ===========================================================================
// Internal ingest contract (SQS message → ingest-worker lambda)
// ===========================================================================

/**
 * One document queued for ingestion. The worker batches up to INGEST_BATCH_MAX
 * (=10) of these into a single IngestKnowledgeBaseDocuments call, honoring the
 * token-bucket TPS + account concurrency caps.
 */
export interface IngestJob {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  /**
   * Per-user scope (Cognito `sub`), server-derived from the authenticated
   * caller. When present the worker tags the document with a `user_id` inline
   * metadata attribute so retrieval can be scoped per-user. Optional so existing
   * messages/tests stay valid; the upload edge always populates it.
   */
  readonly userId?: string;
  readonly filename: string;
  readonly contentType: SupportedMimeType;
  readonly sizeBytes: number;
  readonly ingestPath: IngestPath;
  /** INLINE path: base64 bytes (decoded by the worker). */
  readonly contentBase64?: string;
  /** S3 path: object reference for a KnowledgeBaseDocument S3 location. */
  readonly s3Uri?: string;
  /**
   * Inline metadata attributes attached to the document. MUST include the
   * tenant attribute { key: "tenant_id", value: tenantId }.
   */
  readonly metadata: readonly MetadataAttribute[];
  /** Idempotency / retry bookkeeping. */
  readonly attempt: number;
  readonly enqueuedAt: IsoTimestamp;
}

/** Per-document outcome from a batch ingest call (used for status + DLQ). */
export interface IngestResult {
  readonly documentId: DocumentId;
  readonly status: DocStatus;
  readonly knowledgeBaseStatus?: string;
  readonly failureReason?: string;
}

// ===========================================================================
// GET /status?docId=...
// ===========================================================================

export interface StatusRequest {
  readonly docId: DocumentId;
}

/** A single document's status row (mirrors the DynamoDB status item). */
export interface DocStatusRecord {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly filename: string;
  readonly status: DocStatus;
  readonly ingestPath: IngestPath;
  readonly sizeBytes: number;
  readonly failureReason?: string;
  /** Raw Bedrock document status for granular UI feedback (e.g. STARTING, IN_PROGRESS, TEXT_INDEXED, INDEXED). */
  readonly knowledgeBaseStatus?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type StatusResponse = DocStatusRecord;

/** Batch status (UI polls many docs at once after a multi-file upload). */
export interface BatchStatusResponse {
  readonly tenantId: TenantId;
  readonly documents: readonly DocStatusRecord[];
}

// ===========================================================================
// POST /chat  (RetrieveAndGenerate scoped to caller's tenant)
// ===========================================================================

export interface ChatCitationReference {
  readonly documentId?: DocumentId;
  readonly s3Uri?: string;
  readonly snippet?: string;
}

export interface ChatCitation {
  readonly text: string;
  readonly references: readonly ChatCitationReference[];
}

/** A speaker role in a chat conversation turn. */
export type ChatRole = 'user' | 'assistant';

/**
 * One prior conversation turn carried by the client so the server can supply
 * multi-turn context to the Agentic Retrieval API. The Agentic Retrieval API is
 * stateless — it has NO sessionId — so follow-up questions ("what did he say?",
 * "what was my first question?") only work when the preceding turns are replayed
 * in AgenticRetrieveStreamRequest.messages. History carries NO tenancy: the
 * retrieval filter is always derived server-side from TenantContext.
 */
export interface ChatTurn {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatRequest {
  /** The user's natural-language question. */
  readonly message: string;
  /**
   * Recent prior turns (oldest→newest), EXCLUDING the current `message`. The
   * server appends the current message as the final user turn and passes the
   * whole conversation to Agentic Retrieval for multi-turn context. Bounded
   * server-side (MAX_HISTORY_TURNS) to cap payload size.
   */
  readonly history?: readonly ChatTurn[];
  /**
   * Optional opaque session id used CLIENT-SIDE to correlate a conversation.
   * NOT sent to Bedrock (the Agentic Retrieval API is stateless; context comes
   * from `history`). The tenant scope is ALWAYS derived server-side from
   * TenantContext, never from here.
   */
  readonly sessionId?: string;
  /**
   * Optional generation-model selector for the Agentic Retrieval call. It is an
   * id from the shared CHAT_MODELS catalog (see models.ts), or the AUTO_MODEL_ID
   * sentinel / omitted for the default MANAGED behavior. The server resolves it
   * THROUGH the allow-list catalog; an unknown id safely falls back to Auto.
   */
  readonly modelId?: string;
}

export interface ChatResponse {
  readonly sessionId: string;
  readonly answer: string;
  readonly citations: readonly ChatCitation[];
  readonly tenantId: TenantId;
}

/** One Server-Sent-Events / streaming chunk for the chat surface. */
export interface ChatStreamChunk {
  readonly type: 'token' | 'citation' | 'done' | 'error';
  readonly token?: string;
  readonly citation?: ChatCitation;
  readonly sessionId?: string;
  readonly error?: string;
}

// ===========================================================================
// Standard API error envelope
// ===========================================================================

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'MISSING_TENANT'
  | 'INVALID_TENANT_KEY'
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'BATCH_TOO_LARGE'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
}
