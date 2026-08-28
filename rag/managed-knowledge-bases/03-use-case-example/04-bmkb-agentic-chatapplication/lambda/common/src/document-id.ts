/**
 * Deterministic, idempotent document id.
 *
 * Re-ingesting the SAME (tenant, filename, content) yields the SAME documentId,
 * so a retry/replay overwrites in place rather than creating duplicates
 * (resilience tier 6 in the test plan). The id is derived purely from inputs —
 * no clock, no randomness — so it is stable across processes and retries.
 *
 * Format: "doc_" + sha256(tenantId \n filename \n contentHash) truncated to a
 * fixed hex length. Includes tenant so two tenants uploading the same bytes do
 * not collide on a single shared id (defense in depth alongside metadata).
 */

import { createHash } from 'node:crypto';

import type { DocumentId, TenantId } from './types.js';

const ID_PREFIX = 'doc_';
const ID_HEX_LEN = 40; // 160 bits of the sha256 digest

export interface DocumentIdInput {
  readonly tenantId: TenantId;
  readonly filename: string;
  /**
   * A stable hash/fingerprint of the file contents. Callers pass a hex content
   * hash (e.g. sha256 of the bytes). For text they may pass the raw text and
   * use `hashContent` below.
   */
  readonly contentHash: string;
}

/** sha256 hex of arbitrary bytes/text — convenience for callers. */
export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Build the deterministic, idempotent document id. */
export function buildDocumentId(input: DocumentIdInput): DocumentId {
  if (!input || typeof input.tenantId !== 'string' || input.tenantId.trim() === '') {
    throw new Error('buildDocumentId: tenantId is required');
  }
  if (typeof input.filename !== 'string' || input.filename.trim() === '') {
    throw new Error('buildDocumentId: filename is required');
  }
  if (typeof input.contentHash !== 'string' || input.contentHash.trim() === '') {
    throw new Error('buildDocumentId: contentHash is required');
  }
  const digest = createHash('sha256')
    .update(input.tenantId)
    .update('\n')
    .update(input.filename)
    .update('\n')
    .update(input.contentHash)
    .digest('hex')
    .slice(0, ID_HEX_LEN);
  return `${ID_PREFIX}${digest}`;
}

/** True if a string looks like a document id this module would emit. */
export function isDocumentId(value: string): value is DocumentId {
  return (
    typeof value === 'string' &&
    value.startsWith(ID_PREFIX) &&
    new RegExp(`^${ID_PREFIX}[0-9a-f]{${ID_HEX_LEN}}$`).test(value)
  );
}
