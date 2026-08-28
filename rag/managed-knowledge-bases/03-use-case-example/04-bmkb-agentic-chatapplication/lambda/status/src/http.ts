/**
 * HTTP edge helpers for the status Lambda (API Gateway proxy integration).
 *
 * Tenant scope is resolved SERVER-SIDE only (authorizer claims / verified
 * header). A status row is returned ONLY if it belongs to the caller's tenant;
 * a request with no resolvable tenant is denied with MISSING_TENANT.
 */
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import type { ApiError, ApiErrorCode, TenantContext } from '@bmkb/common';

// CORS on the ACTUAL proxy-integration response. defaultCorsPreflightOptions
// only covers the OPTIONS preflight; the browser also needs
// Access-Control-Allow-Origin on the real response or it blocks it ("Failed to
// fetch"). ACAO '*' is correct — bearer-token auth, no cookies
// (allowCredentials=false).
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

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

/** Resolve the caller's tenant context from a trusted source, or deny. */
export function resolveTenant(
  event: APIGatewayProxyEvent,
  _env: NodeJS.ProcessEnv = process.env,
): TenantContext {
  const claims = extractAuthorizerClaims(event);

  // PER-USER ISOLATION: the Cognito `sub` is the required identity, sourced
  // ONLY from the authorizer's verified claims — never from a request header,
  // which is attacker-controlled. A request without a resolvable user is denied.
  const userId =
    firstNonEmpty(claims['sub']) ?? firstNonEmpty(claims['username']);

  if (userId === undefined) {
    throw new HttpError(
      'MISSING_TENANT',
      'request has no resolvable user identity (Cognito sub); denied',
    );
  }

  // Tenant id: keep a VERIFIED tenant claim if the pool issues one, else default
  // to the user id (per-user mode: tenant == user). A request header is NEVER a
  // source of tenant — accepting `x-tenant-id` would let any caller read another
  // user's documents by setting it to the victim's id, since ownership is keyed
  // on tenantId. Identity must come only from the JWT the authorizer verified.
  const tenantId =
    firstNonEmpty(claims['tenant_id']) ??
    firstNonEmpty(claims['custom:tenant_id']) ??
    userId;

  return { tenantId, userId };
}

function extractAuthorizerClaims(
  event: APIGatewayProxyEvent,
): Record<string, unknown> {
  const authorizer = event.requestContext?.authorizer;
  if (authorizer === null || authorizer === undefined) return {};
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
    // Never leak internal/infra detail (e.g. missing env var names) to the
    // client. INTERNAL faults get a generic message; specifics are logged only.
    if (err.code === 'INTERNAL') {
      return { code: 'INTERNAL', message: 'internal error', retryable: true };
    }
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  return { code: 'INTERNAL', message: 'internal error', retryable: true };
}
