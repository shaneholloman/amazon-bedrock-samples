/**
 * Typed API client for the bmkb backend. Every shape comes from `@bmkb/common`
 * — this module NEVER redefines request/response contracts.
 *
 * Security model:
 *  - Authentication is a Cognito JWT sent as `Authorization: Bearer <token>` on
 *    every request. The API Gateway Cognito authorizer verifies it, and the
 *    server derives the user identity (the `sub`) from the *verified* token.
 *  - There is NO client-supplied tenant/user header: the JWT is the boundary,
 *    so a client cannot widen its scope. Per-user isolation is enforced
 *    server-side from the JWT `sub`.
 *  - No credentials/secrets are stored or sent from here beyond the runtime
 *    bearer token obtained via the OAuth Authorization Code + PKCE flow.
 */
import type {
  ApiError,
  BatchStatusResponse,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  StatusResponse,
  UploadRequest,
  UploadResponse,
} from '@bmkb/common';
import { API_BASE, IS_API_CONFIGURED } from './config.js';

/**
 * Provider for the current bearer token. The auth store registers this so the
 * API layer never imports the store (avoids a cycle) and always reads the
 * freshest token (e.g. after a silent renew).
 */
type TokenProvider = () => string | undefined;
let tokenProvider: TokenProvider = () => undefined;

/** Register the function that yields the current bearer token (or undefined). */
export function setAuthTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/**
 * Handler invoked when the API returns 401 Unauthorized. The auth store
 * registers this to recover an expired session (attempt a silent token renew,
 * else drop to signed-out) so the user re-authenticates instead of seeing every
 * request fail forever. Registered here (not imported) to avoid a store↔api
 * cycle and to mirror the token-provider pattern.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => undefined;

/** Register the function called when the API responds 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

/** Error thrown by the client; carries the structured `ApiError` when present. */
export class BmkbApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiError?: ApiError,
  ) {
    super(message);
    this.name = 'BmkbApiError';
  }

  get retryable(): boolean {
    return this.apiError?.retryable ?? this.status >= 500;
  }
}

function assertConfigured(): void {
  if (!IS_API_CONFIGURED) {
    throw new BmkbApiError(
      'API base URL is not configured (config.json missing apiBase). Redeploy to regenerate it.',
      0,
    );
  }
}

/** Authorization header for the current session, or empty if signed out. */
function authHeaders(): Record<string, string> {
  const token = tokenProvider();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function parseError(res: Response): Promise<BmkbApiError> {
  let apiError: ApiError | undefined;
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as Partial<ApiError> | undefined;
    if (body && typeof body.code === 'string' && typeof body.message === 'string') {
      apiError = body as ApiError;
      message = body.message;
    }
  } catch {
    /* non-JSON error body; keep the status line */
  }
  return new BmkbApiError(message, res.status, apiError);
}

async function jsonRequest<TResponse>(
  path: string,
  init: RequestInit,
): Promise<TResponse> {
  assertConfigured();
  const { headers, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(),
      ...(headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    // A 401 means the bearer token is missing/expired/invalid: signal the auth
    // layer to recover the session (silent renew or sign-out) so the user
    // re-authenticates rather than retrying against a dead token.
    if (res.status === 401) onUnauthorized();
    throw await parseError(res);
  }
  return (await res.json()) as TResponse;
}

/** POST /upload — submit a document for ingestion (INLINE or S3 path). */
export async function uploadDocument(request: UploadRequest): Promise<UploadResponse> {
  return jsonRequest<UploadResponse>('/upload', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

/**
 * PUT the raw bytes to a presigned S3 URL (S3 ingest path). The URL is
 * returned by /upload; no Authorization header is sent (the S3 presigned URL is
 * itself the credential).
 */
export async function putToPresignedUrl(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    throw new BmkbApiError(`presigned upload failed (${res.status})`, res.status);
  }
}

/** GET /status?docId=… — single document status row. */
export async function getStatus(docId: string): Promise<StatusResponse> {
  return jsonRequest<StatusResponse>(`/status?docId=${encodeURIComponent(docId)}`, {
    method: 'GET',
  });
}

/**
 * Batch status poll for the authenticated user. The server returns only the
 * caller's documents. `docIds` is an optional narrowing hint.
 */
export async function getBatchStatus(
  docIds?: readonly string[],
): Promise<BatchStatusResponse> {
  const qs =
    docIds && docIds.length > 0
      ? `?docIds=${encodeURIComponent(docIds.join(','))}`
      : '';
  return jsonRequest<BatchStatusResponse>(`/status${qs}`, {
    method: 'GET',
  });
}

/** GET /documents — list all documents for the authenticated user. */
export async function listDocuments(): Promise<BatchStatusResponse> {
  return jsonRequest<BatchStatusResponse>('/documents', {
    method: 'GET',
  });
}

/** DELETE /documents?docId=X — delete a document from the KB. */
export async function deleteDocumentApi(docId: string): Promise<void> {
  await jsonRequest(`/documents?docId=${encodeURIComponent(docId)}`, {
    method: 'DELETE',
  });
}

/** POST /chat (non-streaming) — agentic retrieval scoped to the user. */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  return jsonRequest<ChatResponse>('/chat', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export interface ChatStreamHandlers {
  readonly onChunk: (chunk: ChatStreamChunk) => void;
  readonly signal?: AbortSignal;
}

/**
 * POST /chat with streaming. Consumes a `text/event-stream` (or NDJSON) body of
 * `ChatStreamChunk` objects. Falls back to a single non-streaming response if
 * the server does not stream. Resolves when the stream completes.
 */
export async function chatStream(
  request: ChatRequest,
  { onChunk, signal }: ChatStreamHandlers,
): Promise<void> {
  assertConfigured();
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) throw await parseError(res);

  const contentType = res.headers.get('content-type') ?? '';
  const isStream =
    contentType.includes('text/event-stream') ||
    contentType.includes('application/x-ndjson');

  // Non-streaming server: read the whole ChatResponse and synthesize chunks.
  if (!isStream || !res.body) {
    const data = (await res.json()) as ChatResponse;
    if (data.answer) onChunk({ type: 'token', token: data.answer });
    for (const citation of data.citations ?? []) {
      onChunk({ type: 'citation', citation });
    }
    onChunk({ type: 'done', sessionId: data.sessionId });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushLine = (raw: string): void => {
    // Support both SSE ("data: {…}") and bare NDJSON lines.
    let line = raw.trim();
    if (line.length === 0) return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line === '[DONE]') {
      onChunk({ type: 'done' });
      return;
    }
    try {
      onChunk(JSON.parse(line) as ChatStreamChunk);
    } catch {
      // Tolerate keep-alive comments / partial noise.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      flushLine(line);
    }
  }
  if (buffer.trim().length > 0) flushLine(buffer);
}
