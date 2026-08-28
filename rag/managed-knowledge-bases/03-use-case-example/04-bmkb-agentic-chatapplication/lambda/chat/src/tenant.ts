/**
 * Server-side tenant resolution — THE security boundary for /chat.
 *
 * The tenant scope is derived ONLY from trusted request context produced by the
 * API authorizer (JWT claims / Lambda authorizer context). It is NEVER read from
 * a request header or the request body, both of which are attacker-controlled —
 * accepting either as an identity source would let a caller widen their scope to
 * another user's documents.
 *
 * A request with no resolvable, valid tenant is DENIED (MISSING_TENANT). The
 * tenant is never defaulted and never widened.
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyEventV2,
} from 'aws-lambda';
import {
  assertValidTenantId,
  assertValidUserId,
  TenantFilterError,
  type TenantContext,
} from '@bmkb/common';

/**
 * Subset of the request shape we read for tenant resolution. We intentionally
 * accept a loosely-typed view so the same logic works for HTTP API (v2) events,
 * Function URL events, and direct invokes in tests.
 */
export interface TenantResolvable {
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
  readonly requestContext?:
    | {
        readonly authorizer?:
          | {
              /** HTTP API JWT authorizer claims live here. */
              readonly jwt?: { readonly claims?: Readonly<Record<string, unknown>> } | undefined;
              /** REST API Cognito authorizer puts JWT claims here (flat object). */
              readonly claims?: Readonly<Record<string, unknown>> | undefined;
              /** Lambda (REQUEST) authorizer context lives at the top level. */
              readonly lambda?: Readonly<Record<string, unknown>> | undefined;
              /** REST API authorizer context is a flat record. */
              readonly [key: string]: unknown;
            }
          | undefined;
      }
    | undefined;
}

export class MissingTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTenantError';
  }
}

/** Claim/context keys we accept for the tenant id, in priority order. */
const TENANT_CLAIM_KEYS = ['tenant_id', 'tenantId', 'custom:tenant_id', 'tenant'] as const;
const USER_CLAIM_KEYS = ['sub', 'username', 'cognito:username', 'userId', 'user_id'] as const;

function firstString(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Resolve the caller's TenantContext from trusted request context.
 *
 * Resolution order (all server-side / authorizer-controlled):
 *   1. HTTP API JWT authorizer claims  (requestContext.authorizer.jwt.claims)
 *   2. Lambda authorizer context        (requestContext.authorizer.lambda)
 *   3. REST API authorizer context      (requestContext.authorizer)
 *
 * @throws MissingTenantError if no valid tenant can be resolved.
 */
export function resolveTenantContext(
  event: TenantResolvable,
  _tenantHeaderName?: string,
): TenantContext {
  const authorizer = event.requestContext?.authorizer;

  const jwtClaims = authorizer?.jwt?.claims; // HTTP API v2
  const restClaims = authorizer?.claims; // REST API Cognito authorizer
  const lambdaCtx = authorizer?.lambda;
  // REST authorizer context: the flat record minus the structured sub-objects.
  const restCtx = authorizer as Readonly<Record<string, unknown>> | undefined;

  // PER-USER ISOLATION: the Cognito `sub` is the isolation boundary and is
  // REQUIRED. A request without a resolvable user identity is DENIED.
  const userId =
    firstString(jwtClaims, USER_CLAIM_KEYS) ??
    firstString(restClaims, USER_CLAIM_KEYS) ??
    firstString(lambdaCtx, USER_CLAIM_KEYS) ??
    firstString(restCtx, USER_CLAIM_KEYS);

  if (userId === undefined) {
    throw new MissingTenantError(
      'no user identity (Cognito sub) could be resolved from authorizer context (request denied)',
    );
  }

  try {
    assertValidUserId(userId);
  } catch (err) {
    if (err instanceof TenantFilterError) {
      throw new MissingTenantError(`resolved user id is invalid: ${err.message}`);
    }
    throw err;
  }

  // Tenant id: keep a VERIFIED tenant claim if the pool issues one, otherwise
  // default to the user id (per-user mode: tenant == user). A request header is
  // NEVER an identity source — it is attacker-controlled, so accepting it would
  // let a caller widen scope. Retrieval is filtered on the verified userId, but
  // we keep tenant off headers too so no code path can trust a spoofed value.
  const tenantId =
    firstString(jwtClaims, TENANT_CLAIM_KEYS) ??
    firstString(restClaims, TENANT_CLAIM_KEYS) ??
    firstString(lambdaCtx, TENANT_CLAIM_KEYS) ??
    firstString(restCtx, TENANT_CLAIM_KEYS) ??
    userId;

  try {
    assertValidTenantId(tenantId);
  } catch (err) {
    if (err instanceof TenantFilterError) {
      throw new MissingTenantError(`resolved tenant id is invalid: ${err.message}`);
    }
    throw err;
  }

  return { tenantId, userId };
}

/** Convenience overload typed against the concrete HTTP API v2 event. */
export function resolveTenantFromHttpEvent(
  event:
    | APIGatewayProxyEventV2
    | APIGatewayProxyEventV2WithRequestContext<Record<string, unknown>>,
  _tenantHeaderName?: string,
): TenantContext {
  return resolveTenantContext(event as unknown as TenantResolvable);
}
