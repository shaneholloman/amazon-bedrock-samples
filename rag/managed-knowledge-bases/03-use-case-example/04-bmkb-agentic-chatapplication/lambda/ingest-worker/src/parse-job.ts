/**
 * Parse + validate an SQS record body into a trusted IngestJob.
 *
 * The queue is an internal trust boundary, but we still validate every field:
 * a malformed/poisoned message must be rejected deterministically (and sent to
 * the DLQ) rather than crashing the worker or producing a bad Bedrock call.
 */

import {
  IngestPath,
  TENANT_METADATA_KEY,
  USER_METADATA_KEY,
  SUPPORTED_MIME_TYPES,
  assertValidTenantId,
  isDocumentId,
  type IngestJob,
  type MetadataAttribute,
  type SupportedMimeType,
} from '@bmkb/common';

export class JobParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobParseError';
  }
}

const MIME_SET = new Set<string>(SUPPORTED_MIME_TYPES);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new JobParseError(`field "${key}" must be a non-empty string`);
  }
  return v;
}

function parseMetadata(raw: unknown): MetadataAttribute[] {
  if (!Array.isArray(raw)) {
    throw new JobParseError('field "metadata" must be an array');
  }
  return raw.map((entry, i): MetadataAttribute => {
    if (!isObject(entry)) {
      throw new JobParseError(`metadata[${i}] must be an object`);
    }
    const key = entry['key'];
    const value = entry['value'];
    if (typeof key !== 'string' || key.trim() === '') {
      throw new JobParseError(`metadata[${i}].key must be a non-empty string`);
    }
    if (typeof value !== 'string') {
      throw new JobParseError(`metadata[${i}].value must be a string`);
    }
    return { key, value };
  });
}

/** Parse a raw SQS body (JSON string) into a validated IngestJob. */
export function parseIngestJob(body: string): IngestJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new JobParseError('body is not valid JSON');
  }
  if (!isObject(parsed)) {
    throw new JobParseError('body must be a JSON object');
  }

  const documentId = requireString(parsed, 'documentId');
  if (!isDocumentId(documentId)) {
    throw new JobParseError(`documentId "${documentId}" is not a valid document id`);
  }

  const tenantId = requireString(parsed, 'tenantId');
  assertValidTenantId(tenantId);

  const filename = requireString(parsed, 'filename');

  const contentType = requireString(parsed, 'contentType');
  if (!MIME_SET.has(contentType)) {
    throw new JobParseError(`contentType "${contentType}" is not a supported MIME type`);
  }

  const sizeBytes = parsed['sizeBytes'];
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new JobParseError('sizeBytes must be a non-negative number');
  }

  const ingestPathRaw = requireString(parsed, 'ingestPath');
  if (ingestPathRaw !== IngestPath.INLINE && ingestPathRaw !== IngestPath.S3) {
    throw new JobParseError(`ingestPath "${ingestPathRaw}" is invalid`);
  }
  const ingestPath = ingestPathRaw as IngestPath;

  const metadata = parseMetadata(parsed['metadata']);
  // Tenant attribute must be present and must match the job tenant.
  const tenantAttr = metadata.find((m) => m.key === TENANT_METADATA_KEY);
  if (!tenantAttr) {
    throw new JobParseError(`metadata is missing the "${TENANT_METADATA_KEY}" attribute`);
  }
  if (tenantAttr.value !== tenantId) {
    throw new JobParseError(
      `metadata "${TENANT_METADATA_KEY}" (${tenantAttr.value}) does not match tenantId (${tenantId})`,
    );
  }

  // Per-user scope (Cognito sub). Optional on the job, but if present it MUST be
  // consistent with the user_id metadata attribute the worker will tag.
  const userIdRaw = parsed['userId'];
  let userId: string | undefined;
  if (userIdRaw !== undefined) {
    if (typeof userIdRaw !== 'string' || userIdRaw.trim() === '') {
      throw new JobParseError('userId, when present, must be a non-empty string');
    }
    userId = userIdRaw;
  }
  const userAttr = metadata.find((m) => m.key === USER_METADATA_KEY);
  if (userId !== undefined && userAttr && userAttr.value !== userId) {
    throw new JobParseError(
      `metadata "${USER_METADATA_KEY}" (${userAttr.value}) does not match userId (${userId})`,
    );
  }
  // Backfill userId from the metadata attribute if the field was omitted.
  if (userId === undefined && userAttr) {
    userId = userAttr.value;
  }

  const attempt = parsed['attempt'];
  const enqueuedAt = parsed['enqueuedAt'];

  const contentBase64 = parsed['contentBase64'];
  const s3Uri = parsed['s3Uri'];

  if (ingestPath === IngestPath.INLINE) {
    if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') {
      throw new JobParseError('INLINE job requires a non-empty contentBase64');
    }
  } else {
    if (typeof s3Uri !== 'string' || !s3Uri.startsWith('s3://')) {
      throw new JobParseError('S3 job requires an s3Uri starting with s3://');
    }
  }

  const job: IngestJob = {
    documentId,
    tenantId,
    ...(userId !== undefined ? { userId } : {}),
    filename,
    contentType: contentType as SupportedMimeType,
    sizeBytes,
    ingestPath,
    metadata,
    attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : 1,
    enqueuedAt:
      typeof enqueuedAt === 'string' && enqueuedAt.trim() !== ''
        ? enqueuedAt
        : new Date().toISOString(),
    ...(ingestPath === IngestPath.INLINE
      ? { contentBase64: contentBase64 as string }
      : { s3Uri: s3Uri as string }),
  };
  return job;
}
