/**
 * HTTP edge helpers for the upload Lambda (API Gateway proxy integration).
 *
 * Tenant scope is resolved SERVER-SIDE only. The request body NEVER carries the
 * tenant for trust purposes (see README → API reference). A request with no
 * resolvable tenant is denied with MISSING_TENANT — never defaulted, never
 * widened.
 */
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import type { ApiError, ApiErrorCode, TenantContext } from '@bmkb/common';

// CORS headers on the ACTUAL (proxy-integration) response. API Gateway's
// defaultCorsPreflightOptions only adds CORS to the OPTIONS preflight; the
// browser ALSO requires Access-Control-Allow-Origin on the real 2xx/4xx/5xx
// response or it blocks it (surfacing as an opaque "Failed to fetch"). ACAO is
// '*' because auth is a bearer token, not cookies (allowCredentials=false).
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

/** Map our internal error codes to HTTP status codes. */
const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  UNAUTHORIZED: 401,
  MISSING_TENANT: 401,
  INVALID_TENANT_KEY: 400,
  UNSUPPORTED_FORMAT: 415,
  FILE_TOO_LARGE: 413,
  BATCH_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

/** A handled error that maps cleanly onto the ApiError envelope. */
export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Resolve the caller's tenant context from a trusted source.
 *
 * PER-USER ISOLATION: the authenticated user id (Cognito `sub`) is REQUIRED.
 * Documents are private to the uploading user, so the `sub` is the isolation
 * boundary and must be present for any authenticated request. If it cannot be
 * resolved, this throws MISSING_TENANT (deny) — never defaulted, never widened.
 *
 * The user identity comes ONLY from the API Gateway authorizer context
 * (JWT-verified claims the client cannot forge). Request headers are NEVER a
 * source of user identity — an `x-user-id` header is attacker-controlled and
 * accepting it would let any caller impersonate any user if the authorizer
 * context were ever absent.
 *
 * The tenant id is optional in per-user mode: when no tenant claim is present
 * it defaults to the user id (tenant == user is fine for per-user isolation).
 * A tenant header is tolerated only as a grouping hint — it can never widen
 * identity, since isolation is keyed on the user id.
 */
export function resolveTenant(
  event: APIGatewayProxyEvent,
  _env: NodeJS.ProcessEnv = process.env,
): TenantContext {
  const authClaims = extractAuthorizerClaims(event);

  // The Cognito `sub` is the stable per-user isolation boundary and is REQUIRED.
  const userId =
    firstNonEmpty(authClaims['sub']) ??
    firstNonEmpty(authClaims['username']) ??
    firstNonEmpty(authClaims['cognito:username']);

  if (userId === undefined) {
    throw new HttpError(
      'MISSING_TENANT',
      'request has no resolvable user identity (Cognito sub); denied',
    );
  }

  // Tenant id: keep a VERIFIED tenant claim if the pool issues one, otherwise
  // default to the user id. A request header is NEVER a source of tenant: since
  // documents are scoped and read by tenantId, accepting `x-tenant-id` would let
  // a caller write/read under another user's id. Identity comes only from the
  // JWT claims the authorizer verified.
  const tenantId =
    firstNonEmpty(authClaims['tenant_id']) ??
    firstNonEmpty(authClaims['custom:tenant_id']) ??
    userId;

  return { tenantId, userId };
}

/** Pull authorizer claims off the event in a shape-tolerant way. */
function extractAuthorizerClaims(
  event: APIGatewayProxyEvent,
): Record<string, unknown> {
  const authorizer = event.requestContext?.authorizer;
  if (authorizer === null || authorizer === undefined) return {};
  // REST API (Cognito/JWT) puts verified claims under `.claims`; custom
  // authorizers put them flat on `.authorizer`.
  const claims = (authorizer as Record<string, unknown>)['claims'];
  if (claims !== null && typeof claims === 'object') {
    return claims as Record<string, unknown>;
  }
  return authorizer as Record<string, unknown>;
}

function firstNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parse + JSON-decode the request body, throwing INTERNAL/validation on bad input. */
export function parseJsonBody(event: APIGatewayProxyEvent): unknown {
  const raw = event.body;
  if (raw === null || raw === undefined || raw.length === 0) {
    // Client error (missing body) → 400, not a 500.
    throw new HttpError('INVALID_TENANT_KEY', 'request body is required');
  }
  const decoded = event.isBase64Encoded
    ? Buffer.from(raw, 'base64').toString('utf8')
    : raw;
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new HttpError('INVALID_TENANT_KEY', 'request body is not valid JSON');
  }
}

export function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(body),
  };
}

export function errorResponse(err: unknown): APIGatewayProxyResult {
  const apiError = toApiError(err);
  return {
    statusCode: STATUS_BY_CODE[apiError.code],
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(apiError),
  };
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof HttpError) {
    // Never leak internal/infra detail (env var names, stack info, decoded
    // sizes) to the client. INTERNAL faults always get a generic message; the
    // specifics are logged server-side only.
    if (err.code === 'INTERNAL') {
      return { code: 'INTERNAL', message: 'internal error', retryable: true };
    }
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return {
    code: 'INTERNAL',
    message: 'internal error',
    retryable: true,
  };
}
