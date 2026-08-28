/**
 * POST /chat — RetrieveAndGenerate scoped to the caller's tenant.
 *
 * Flow (see README → API reference → POST /chat):
 *   1. Resolve TenantContext from trusted authorizer context / header; deny if
 *      missing (MISSING_TENANT). This is THE security boundary.
 *   2. Parse + validate the ChatRequest body (tenant is NEVER read from it).
 *   3. buildTenantFilter(ctx) → EXPLICIT equals filter, asserted scoped, passed
 *      to RetrieveAndGenerate(Stream). No call is ever made without the filter.
 *   4. Stream ChatStreamChunk over SSE when the streaming runtime is available;
 *      otherwise return a buffered ChatResponse with citations.
 *
 * Two entry points are exported:
 *   - `handler`        — buffered API Gateway HTTP API (v2) proxy handler.
 *   - `streamingHandler`— Function URL RESPONSE_STREAM handler (SSE), wrapped
 *                          with awslambda.streamifyResponse when available.
 *
 * All API contracts/helpers come from @bmkb/common.
 */

/// <reference path="./awslambda.d.ts" />
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import {
  assertFilterScopedToTenant,
  buildTenantFilter,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
} from '@bmkb/common';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { classifyError, parseChatRequest } from './http.js';
import { resolveTenantContext, type TenantResolvable } from './tenant.js';
import { RagClient } from './rag.js';

// Re-export the contract + boundary helpers for tests / downstream tooling.
export type { ChatRequest, ChatResponse, ChatStreamChunk };
export { assertFilterScopedToTenant, buildTenantFilter };
export { RagClient } from './rag.js';
export { resolveTenantContext } from './tenant.js';
export { parseChatRequest, classifyError } from './http.js';
export { mapCitation, mapCitations } from './citations.js';

const baseLogger = createLogger();

// CORS on the ACTUAL response. API Gateway's defaultCorsPreflightOptions only
// covers the OPTIONS preflight; the browser also requires
// Access-Control-Allow-Origin on the real (streamed or buffered) response or it
// blocks it ("Failed to fetch"). ACAO '*' — bearer-token auth, no cookies
// (allowCredentials=false).
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
} as const;

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'access-control-allow-origin': '*',
} as const;

/** Lazily-constructed singleton Rag client (reused across warm invocations). */
let ragClientSingleton: RagClient | undefined;
function getRagClient(logger: Logger): RagClient {
  if (ragClientSingleton === undefined) {
    ragClientSingleton = new RagClient(loadConfig(), logger);
  }
  return ragClientSingleton;
}

/** Test seam: clear the cached RAG client. */
export function resetRagClient(): void {
  ragClientSingleton = undefined;
}

/** Serialize one SSE event line for a ChatStreamChunk. */
function sseLine(chunk: ChatStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * True only inside the AWS Lambda RESPONSE_STREAM runtime, where the global
 * `awslambda` exposes real streaming helpers. Some AWS SDKs define an EMPTY
 * `globalThis.awslambda` object, so a plain `typeof` check is NOT sufficient —
 * we must confirm the helpers are actually functions.
 */
function hasStreamingRuntime(): boolean {
  return (
    typeof awslambda !== 'undefined' &&
    awslambda !== null &&
    typeof awslambda.streamifyResponse === 'function' &&
    typeof awslambda.HttpResponseStream?.from === 'function'
  );
}

// ===========================================================================
// Buffered handler (API Gateway HTTP API v2 proxy)
// ===========================================================================

export const handler = async (
  event: APIGatewayProxyEventV2,
  context?: Context,
): Promise<APIGatewayProxyResultV2> => {
  const requestId = context?.awsRequestId ?? 'local';
  const logger = baseLogger.child({ requestId });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const { statusCode, body } = classifyError(err);
    logger.error('config.failed', { error: (err as Error).message });
    return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
  }

  try {
    // 1. SECURITY BOUNDARY: resolve tenant server-side or deny.
    const ctx = resolveTenantContext(
      event as unknown as TenantResolvable,
      config.tenantHeaderName,
    );

    // 2. Validate input (tenant never sourced from the body).
    const request = parseChatRequest(event.body, event.isBase64Encoded ?? false);

    // 3. + 4. RetrieveAndGenerate with the explicit tenant filter.
    const rag = getRagClient(logger);
    const result = await rag.retrieveAndGenerate(
      ctx,
      request.message,
      request.history ?? [],
      request.sessionId,
      request.modelId,
    );

    const response: ChatResponse = {
      sessionId: result.sessionId,
      answer: result.answer,
      citations: result.citations,
      tenantId: ctx.tenantId,
    };
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(response) };
  } catch (err) {
    const { statusCode, body } = classifyError(err);
    logger[statusCode >= 500 ? 'error' : 'warn']('chat.failed', {
      statusCode,
      code: body.code,
      error: (err as Error)?.message,
    });
    return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
  }
};

// ===========================================================================
// Streaming core (shared by the streamified Function URL handler)
// ===========================================================================

/**
 * Run the streaming chat flow, writing SSE ChatStreamChunk events to `write`.
 * Returns the HTTP status code to use for the response prelude (resolved before
 * any body byte is written, so errors during setup map cleanly).
 */
async function runChatStream(
  event: TenantResolvable & { body?: string | null; isBase64Encoded?: boolean },
  logger: Logger,
  write: (chunk: string) => void,
): Promise<void> {
  const config = loadConfig();
  const ctx = resolveTenantContext(event, config.tenantHeaderName);
  const request = parseChatRequest(event.body, event.isBase64Encoded ?? false);

  const rag = getRagClient(logger);
  let sessionId = request.sessionId ?? '';
  try {
    for await (const ev of rag.retrieveAndGenerateStream(
      ctx,
      request.message,
      request.history ?? [],
      request.sessionId,
      request.modelId,
    )) {
      if (ev.kind === 'sessionId') {
        sessionId = ev.sessionId;
      } else if (ev.kind === 'token') {
        write(sseLine({ type: 'token', token: ev.token }));
      } else {
        write(sseLine({ type: 'citation', citation: ev.citation }));
      }
    }
    write(sseLine({ type: 'done', sessionId }));
  } catch (err) {
    const { body } = classifyError(err);
    logger[body.code === 'INTERNAL' ? 'error' : 'warn']('chat.stream_failed', {
      code: body.code,
      error: (err as Error)?.message,
    });
    // Errors mid-stream are surfaced as an SSE error chunk (headers are sent).
    write(sseLine({ type: 'error', error: body.message }));
  }
}

// ===========================================================================
// Streaming handler (Lambda RESPONSE_STREAM / Function URL)
// ===========================================================================

/**
 * Raw streaming handler. When the AWS streaming runtime is present it is
 * wrapped by `awslambda.streamifyResponse`; otherwise it is exported as-is so
 * it can be unit-tested against a plain Writable-like sink.
 */
async function streamingHandlerImpl(
  event: APIGatewayProxyEventV2,
  responseStream: ResponseStream,
  context?: Context,
): Promise<void> {
  const requestId = context?.awsRequestId ?? 'local';
  const logger = baseLogger.child({ requestId });

  // Determine the status code BEFORE writing any body. We resolve config +
  // tenant + body validation up front so a denial returns a clean status.
  let statusCode = 200;
  let setupError: unknown;
  try {
    const config = loadConfig();
    resolveTenantContext(event as unknown as TenantResolvable, config.tenantHeaderName);
    parseChatRequest(event.body, event.isBase64Encoded ?? false);
  } catch (err) {
    setupError = err;
    statusCode = classifyError(err).statusCode;
  }

  const headers = statusCode === 200 ? SSE_HEADERS : JSON_HEADERS;
  const stream = hasStreamingRuntime()
    ? awslambda!.HttpResponseStream.from(responseStream, { statusCode, headers })
    : responseStream;

  try {
    if (setupError !== undefined) {
      const { body } = classifyError(setupError);
      logger[statusCode >= 500 ? 'error' : 'warn']('chat.stream_setup_failed', {
        statusCode,
        code: body.code,
      });
      stream.write(JSON.stringify(body));
      return;
    }
    await runChatStream(
      event as unknown as TenantResolvable & {
        body?: string | null;
        isBase64Encoded?: boolean;
      },
      logger,
      (chunk) => stream.write(chunk),
    );
  } finally {
    stream.end();
  }
}

export { streamingHandlerImpl };

/**
 * Exported streaming entry point. Uses the runtime's streamifyResponse wrapper
 * when available (production Function URL), else falls back to the raw impl.
 */
export const streamingHandler = hasStreamingRuntime()
  ? awslambda!.streamifyResponse(streamingHandlerImpl)
  : streamingHandlerImpl;
