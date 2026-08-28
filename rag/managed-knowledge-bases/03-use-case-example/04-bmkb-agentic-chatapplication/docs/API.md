# API Reference

All request/response shapes are defined in `@bmkb/common` (`src/common/src/types.ts`) — that file is the single source of truth. Transport is JSON over HTTPS via API Gateway.

## Authentication

Identity is resolved **server-side** from the Cognito authorizer's verified JWT claims. The request body never carries identity for trust purposes. A request with no resolvable user identity is denied (HTTP 401 or 403).

## Error envelope

All errors use the `ApiError` shape:

```json
{
  "code": "UNAUTHORIZED | MISSING_TENANT | UNSUPPORTED_FORMAT | FILE_TOO_LARGE | RATE_LIMITED | NOT_FOUND | INTERNAL",
  "message": "Human-readable description",
  "retryable": false
}
```

## Endpoints

### POST /upload

Upload a document for ingestion.

**Request:** `UploadRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | string | Yes | Original filename with extension |
| `contentType` | string | Yes | MIME type (must be in the allowlist) |
| `sizeBytes` | number | Yes | File size in bytes |
| `contentBase64` | string | No | Base64-encoded bytes for inline path (≤ 6 MB) |
| `attributes` | object | No | Client metadata (not used for scope) |

**Response:** `UploadResponse`

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Deterministic document identifier |
| `tenantId` | string | Caller's tenant |
| `status` | string | Always `"PENDING"` at upload time |
| `ingestPath` | string | `"INLINE"` or `"S3"` |
| `uploadUrl` | string | Presigned PUT URL (S3 path only) |
| `s3Key` | string | S3 object key (S3 path only) |
| `createdAt` | string | ISO-8601 timestamp |

If `contentBase64` is omitted, the response includes `uploadUrl` — the client must PUT the file bytes there.

---

### GET /status

Check the indexing status of a document.

**Query parameters:**
- `docId` — single document ID
- `docIds` — comma-separated list for batch status

**Response:** `StatusResponse` (single) or `BatchStatusResponse` (batch)

| Field | Type | Description |
|-------|------|-------------|
| `documentId` | string | Document identifier |
| `tenantId` | string | Owning tenant |
| `filename` | string | Original filename |
| `status` | string | `PENDING`, `INDEXED`, or `FAILED` |
| `ingestPath` | string | `INLINE` or `S3` |
| `sizeBytes` | number | File size |
| `failureReason` | string | Present only when `FAILED` |
| `createdAt` | string | ISO-8601 timestamp |
| `updatedAt` | string | ISO-8601 timestamp |

A document belonging to another user returns `NOT_FOUND`.

---

### POST /chat

Ask a question over your indexed documents.

**Request:** `ChatRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The user's question |
| `history` | array | No | Prior conversation turns `[{ role, content }]` (oldest → newest) |
| `sessionId` | string | No | Client-side conversation correlator (not sent to Bedrock) |
| `modelId` | string | No | Generation model from the `CHAT_MODELS` catalog, or omit for Auto |

**Response:** `ChatResponse`

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Conversation correlator |
| `answer` | string | Generated answer |
| `citations` | array | Source passages with document references |
| `tenantId` | string | Caller's tenant |

**Streaming:** When the client accepts `text/event-stream`, the response is a stream of `ChatStreamChunk` events (`type: token | citation | done | error`).

> **Note on conversation state:** The `AgenticRetrieveStream` API is stateless — it does not persist conversation history between calls. In this sample, `sessionId` and `history` are managed entirely client-side (in browser state). The client replays recent turns with each request so the model can resolve follow-up questions. If the user refreshes the page or switches devices, the conversation context is lost. For production applications, consider persisting conversation history server-side (e.g., in DynamoDB keyed by `userId` + `sessionId`) and loading it on each request.

## Supported file formats

For the current list of supported file formats, see the [Amazon Bedrock Knowledge Bases documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported-doc-types.html).
