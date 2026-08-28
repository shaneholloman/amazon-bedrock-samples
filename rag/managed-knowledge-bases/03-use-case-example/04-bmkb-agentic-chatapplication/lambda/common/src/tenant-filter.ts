/**
 * Tenant isolation helpers.
 *
 * SECURITY BOUNDARY. Bedrock Managed KB does NOT support startsWith /
 * stringContains, and implicit (model-generated) filtering is Claude-only and
 * is NOT a security boundary (F11/F13). Tenant isolation MUST therefore be an
 * EXPLICIT filter using the `equals` (single) or `in` (multi) operator.
 *
 * Reserved-key rule (F12): managed KB reserves the underscore prefix
 * (_source_uri, _data_source_id, ...). The tenant key MUST be a plain key.
 * Never use "_tenant_id".
 */

import type {
  EqualsFilter,
  InFilter,
  MetadataAttribute,
  RetrievalFilter,
  TenantContext,
  TenantId,
} from './types.js';

/** The plain metadata key used for tenant scoping. Never underscore-prefixed. */
export const TENANT_METADATA_KEY = 'tenant_id';

/**
 * The plain metadata key used for PER-USER scoping. The value is the caller's
 * Cognito `sub` (a stable, opaque user id). This is the isolation boundary when
 * documents are private to the uploading user. Never underscore-prefixed (F12).
 */
export const USER_METADATA_KEY = 'user_id';

export class TenantFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantFilterError';
  }
}

/**
 * Validate a metadata key: non-empty after trim, and never reserved
 * (underscore-prefixed). Throws TenantFilterError on violation.
 */
export function assertValidMetadataKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TenantFilterError('metadata key must be a non-empty string');
  }
  if (key.startsWith('_')) {
    throw new TenantFilterError(
      `metadata key "${key}" is reserved: managed KB reserves the underscore prefix (F12)`,
    );
  }
}

/** Validate a tenant id value: non-empty after trim. */
export function assertValidTenantId(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TenantFilterError('tenant_id must be a non-empty string');
  }
}

/**
 * Build the EXPLICIT retrieval filter for a single tenant.
 * Rejects an empty/missing tenant. This is the only sanctioned way to scope
 * Retrieve / RetrieveAndGenerate to a caller.
 */
export function buildTenantFilter(ctx: TenantContext): EqualsFilter {
  if (ctx === null || ctx === undefined) {
    throw new TenantFilterError('tenant context is required (missing tenant → deny)');
  }
  assertValidTenantId(ctx.tenantId);
  assertValidMetadataKey(TENANT_METADATA_KEY);
  return {
    equals: {
      key: TENANT_METADATA_KEY,
      value: ctx.tenantId,
    },
  };
}

/**
 * Build an `in` filter for a non-empty set of tenants (e.g. admin/cross-tenant
 * tooling). Every value validated; empty set rejected.
 */
export function buildTenantInFilter(tenantIds: readonly TenantId[]): InFilter {
  if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
    throw new TenantFilterError('at least one tenant_id is required for an "in" filter');
  }
  for (const id of tenantIds) {
    assertValidTenantId(id);
  }
  assertValidMetadataKey(TENANT_METADATA_KEY);
  return {
    in: {
      key: TENANT_METADATA_KEY,
      value: [...tenantIds],
    },
  };
}

/**
 * Build the inline metadata attribute attached to a document at ingest time,
 * carrying the tenant scope. Validated against the reserved-key rule.
 */
export function buildTenantMetadataAttribute(ctx: TenantContext): MetadataAttribute {
  if (ctx === null || ctx === undefined) {
    throw new TenantFilterError('tenant context is required to tag a document');
  }
  assertValidTenantId(ctx.tenantId);
  assertValidMetadataKey(TENANT_METADATA_KEY);
  return { key: TENANT_METADATA_KEY, value: ctx.tenantId };
}

/**
 * Defense in depth: assert a built filter actually scopes to the expected
 * tenant before it is sent to Bedrock. Used by the chat lambda + isolation
 * tests to prove the filter cannot silently widen.
 */
export function assertFilterScopedToTenant(
  filter: RetrievalFilter,
  expected: TenantId,
): void {
  assertValidTenantId(expected);
  if ('equals' in filter) {
    if (filter.equals.key !== TENANT_METADATA_KEY || filter.equals.value !== expected) {
      throw new TenantFilterError('equals filter is not scoped to the expected tenant');
    }
    return;
  }
  if ('in' in filter) {
    if (
      filter.in.key !== TENANT_METADATA_KEY ||
      filter.in.value.length !== 1 ||
      filter.in.value[0] !== expected
    ) {
      throw new TenantFilterError('in filter is not scoped to exactly the expected tenant');
    }
    return;
  }
  throw new TenantFilterError('unrecognized filter shape');
}

// ===========================================================================
// PER-USER isolation (Cognito `sub`). Same rules as tenant scoping; the value
// is the authenticated user id rather than a tenant id. Documents are private
// to the uploading user.
// ===========================================================================

/** Validate a user id (Cognito sub) value: non-empty after trim. */
export function assertValidUserId(value: string | undefined): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TenantFilterError('user_id (Cognito sub) must be a non-empty string');
  }
}

/**
 * Build the EXPLICIT retrieval filter scoping to a single USER (Cognito sub).
 * Rejects a missing/empty user id. This is the sanctioned way to scope
 * retrieval to the authenticated caller when documents are per-user private.
 */
export function buildUserFilter(ctx: TenantContext): EqualsFilter {
  if (ctx === null || ctx === undefined) {
    throw new TenantFilterError('tenant context is required (missing user → deny)');
  }
  assertValidUserId(ctx.userId);
  assertValidMetadataKey(USER_METADATA_KEY);
  return { equals: { key: USER_METADATA_KEY, value: ctx.userId } };
}

/**
 * Build the inline metadata attribute attached to a document at ingest time,
 * carrying the per-user scope (Cognito sub).
 */
export function buildUserMetadataAttribute(ctx: TenantContext): MetadataAttribute {
  if (ctx === null || ctx === undefined) {
    throw new TenantFilterError('tenant context is required to tag a document');
  }
  assertValidUserId(ctx.userId);
  assertValidMetadataKey(USER_METADATA_KEY);
  return { key: USER_METADATA_KEY, value: ctx.userId };
}

/**
 * Defense in depth: assert a filter scopes to exactly the expected USER before
 * it is sent to Bedrock. Mirrors assertFilterScopedToTenant for the per-user
 * isolation path.
 */
export function assertFilterScopedToUser(
  filter: RetrievalFilter,
  expectedUserId: string,
): void {
  assertValidUserId(expectedUserId);
  if ('equals' in filter) {
    if (filter.equals.key !== USER_METADATA_KEY || filter.equals.value !== expectedUserId) {
      throw new TenantFilterError('equals filter is not scoped to the expected user');
    }
    return;
  }
  throw new TenantFilterError('per-user isolation requires an equals filter');
}
