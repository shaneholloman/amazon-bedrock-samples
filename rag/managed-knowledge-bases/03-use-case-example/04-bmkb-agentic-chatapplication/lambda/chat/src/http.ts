/**
 * HTTP edge helpers: request-body parsing/validation, ApiError construction,
 * and error classification → (status code, ApiError). Pure + unit-testable.
 */

import type { ApiError, ApiErrorCode, ChatRequest, ChatTurn } from '@bmkb/common';
import { TenantFilterError, getChatModel, isAutoModel } from '@bmkb/common';
import { ConfigError } from './config.js';
import { MissingTenantError } from './tenant.js';

/** Max accepted user message length (characters). Guards payload abuse. */
export const MAX_MESSAGE_LENGTH = 8_192;
/** Max accepted sessionId length. */
export const MAX_SESSION_ID_LENGTH = 256;
/**
 * Max prior turns replayed for multi-turn context. Bounds request size and
 * agentic-retrieval cost. Newest turns are kept when the client sends more (the
 * most relevant context for resolving a follow-up). 20 turns ≈ 10 Q/A rounds.
 */
export const MAX_HISTORY_TURNS = 20;

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export function apiError(code: ApiErrorCode, message: string, retryable = false): ApiError {
  return { code, message, retryable };
}

/**
 * Parse + validate a ChatRequest from a raw (possibly base64) HTTP body.
 * The body NEVER carries tenant info; any such field is ignored.
 *
 * @throws BadRequestError on malformed/invalid input.
 */
export function parseChatRequest(
  rawBody: string | null | undefined,
  isBase64Encoded = false,
): ChatRequest {
  if (rawBody === null || rawBody === undefined || rawBody.length === 0) {
    throw new BadRequestError('request body is required');
  }
  const text = isBase64Encoded ? Buffer.from(rawBody, 'base64').toString('utf-8') : rawBody;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequestError('request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('request body must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  const message = obj['message'];
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new BadRequestError('"message" is required and must be a non-empty string');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new BadRequestError(`"message" exceeds the ${MAX_MESSAGE_LENGTH}-character limit`);
  }

  const sessionIdRaw = obj['sessionId'];
  if (sessionIdRaw !== undefined && sessionIdRaw !== null) {
    if (typeof sessionIdRaw !== 'string') {
      throw new BadRequestError('"sessionId" must be a string when provided');
    }
    if (sessionIdRaw.length > MAX_SESSION_ID_LENGTH) {
      throw new BadRequestError(
        `"sessionId" exceeds the ${MAX_SESSION_ID_LENGTH}-character limit`,
      );
    }
  }

  const sessionId =
    typeof sessionIdRaw === 'string' && sessionIdRaw.trim().length > 0
      ? sessionIdRaw.trim()
      : undefined;

  // Optional multi-turn history (oldest→newest), EXCLUDING the current message.
  // Each turn must be { role: 'user'|'assistant', content: non-empty string }.
  // Over-long content is rejected (same ceiling as a message); the array is
  // trimmed to the newest MAX_HISTORY_TURNS to bound payload + retrieval cost.
  const history = parseHistory(obj['history']);

  // Optional generation-model selector. Validate type only; the value is an
  // OPAQUE allow-list id resolved server-side through CHAT_MODELS. Auto (unset /
  // sentinel / blank) is always accepted. A non-empty id that is NOT in the
  // catalog is rejected here so the caller learns the model is unavailable
  // rather than silently getting Auto.
  const modelIdRaw = obj['modelId'];
  if (modelIdRaw !== undefined && modelIdRaw !== null && typeof modelIdRaw !== 'string') {
    throw new BadRequestError('"modelId" must be a string when provided');
  }
  const modelId =
    typeof modelIdRaw === 'string' && !isAutoModel(modelIdRaw)
      ? modelIdRaw.trim()
      : undefined;
  if (modelId !== undefined && getChatModel(modelId) === undefined) {
    throw new BadRequestError(`"modelId" is not a supported model`);
  }

  // exactOptionalPropertyTypes: omit optional props entirely when absent.
  const base = { message: message.trim() };
  return {
    ...base,
    ...(history.length > 0 ? { history } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
  };
}

/**
 * Validate + normalize the optional `history` array. Absent/null → []. Each
 * element must be an object with role ∈ {user,assistant} and a non-empty
 * content string within the message-length ceiling. The result is truncated to
 * the newest MAX_HISTORY_TURNS turns (preserving order).
 *
 * @throws BadRequestError on a malformed element.
 */
function parseHistory(raw: unknown): ChatTurn[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestError('"history" must be an array when provided');
  }
  const turns: ChatTurn[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestError('each "history" entry must be an object');
    }
    const { role, content } = entry as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') {
      throw new BadRequestError('each "history" entry needs role "user" or "assistant"');
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new BadRequestError('each "history" entry needs a non-empty string "content"');
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestError(
        `a "history" entry exceeds the ${MAX_MESSAGE_LENGTH}-character limit`,
      );
    }
    turns.push({ role, content: content.trim() });
  }
  // Keep the NEWEST turns when the client sends more than we replay.
  return turns.length > MAX_HISTORY_TURNS ? turns.slice(-MAX_HISTORY_TURNS) : turns;
}

interface AwsLikeError {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
  readonly message?: string;
}

/** AWS SDK throttling-ish error names. */
const THROTTLE_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
]);

const ACCESS_NAMES = new Set(['AccessDeniedException', 'UnauthorizedException']);
const NOT_FOUND_NAMES = new Set(['ResourceNotFoundException']);
const VALIDATION_NAMES = new Set(['ValidationException']);

export interface ClassifiedError {
  readonly statusCode: number;
  readonly body: ApiError;
}

/**
 * Classify any thrown error into a safe (status, ApiError) pair. Internal
 * details are NOT leaked to the client for 5xx; a generic message is returned.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof MissingTenantError) {
    return {
      statusCode: 403,
      body: apiError('MISSING_TENANT', 'request is not scoped to a tenant', false),
    };
  }
  if (err instanceof TenantFilterError) {
    // A tenant-filter failure means we could not safely scope the query.
    return {
      statusCode: 403,
      body: apiError('MISSING_TENANT', 'request could not be scoped to a tenant', false),
    };
  }
  if (err instanceof BadRequestError) {
    return { statusCode: 400, body: apiError('INVALID_TENANT_KEY', err.message, false) };
  }
  if (err instanceof ConfigError) {
    // Misconfiguration — never expose specifics.
    return {
      statusCode: 500,
      body: apiError('INTERNAL', 'service is not configured correctly', false),
    };
  }

  const aws = err as AwsLikeError;
  const name = typeof aws?.name === 'string' ? aws.name : '';
  const status = aws?.$metadata?.httpStatusCode;

  if (THROTTLE_NAMES.has(name) || status === 429) {
    return {
      statusCode: 429,
      body: apiError('RATE_LIMITED', 'too many requests, retry shortly', true),
    };
  }
  if (ACCESS_NAMES.has(name) || status === 403) {
    return {
      statusCode: 403,
      body: apiError('UNAUTHORIZED', 'not authorized for this resource', false),
    };
  }
  if (NOT_FOUND_NAMES.has(name) || status === 404) {
    return { statusCode: 404, body: apiError('NOT_FOUND', 'resource not found', false) };
  }
  if (VALIDATION_NAMES.has(name) || status === 400) {
    return {
      statusCode: 400,
      body: apiError('INVALID_TENANT_KEY', 'request was rejected as invalid', false),
    };
  }

  return {
    statusCode: 500,
    body: apiError('INTERNAL', 'an unexpected error occurred', true),
  };
}
