/**
 * POST /upload — Lambda handler (API Gateway proxy).
 *
 * Flow (see README → API reference → POST /upload):
 *  1. Resolve TenantContext from the authorizer/verified header; deny if missing.
 *  2. Strictly validate the UploadRequest body.
 *  3. routeBySize (@bmkb/common): INLINE (<=6 MB) vs S3 (<=50 MB); reject >50 MB.
 *  4. buildDocumentId (deterministic/idempotent) + buildTenantMetadataAttribute.
 *  5. Persist a PENDING DocStatusRecord to DynamoDB (idempotent put).
 *  6. INLINE: enqueue an IngestJob with contentBase64.
 *     S3:     issue a presigned PUT, enqueue an IngestJob with the s3Uri.
 *  7. Return UploadResponse (PENDING; uploadUrl+s3Key only for the S3 path).
 *
 * All shared contracts/helpers come from @bmkb/common; nothing is redefined.
 */
import { randomUUID } from 'node:crypto';

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import {
  DocStatus,
  IngestPath,
  SizeRouterError,
  buildDocumentId,
  buildTenantMetadataAttribute,
  buildUserMetadataAttribute,
  extensionOf,
  hashContent,
  routeBySize,
  sizeRouterConfigFromEnv,
  type DocStatusRecord,
  type IngestJob,
  type MetadataAttribute,
  type TenantContext,
  type UploadRequest,
  type UploadResponse,
} from '@bmkb/common';

import { HttpError, errorResponse, ok, parseJsonBody, resolveTenant } from './http.js';
import { log } from './logger.js';
import { validateUploadRequest } from './validate.js';

// --- Clients (instantiated once per container) ------------------------------
const REGION = process.env['AWS_REGION'] ?? 'us-west-2';
const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Presigned PUT URL lifetime (seconds). Client must upload within this window. */
const PRESIGN_TTL_SECONDS = 900; // 15 minutes

/**
 * Largest raw payload the IngestJob may carry through SQS. SQS caps a message
 * at 256 KiB; base64 inflates by 4/3 and the JSON envelope adds metadata, so
 * anything above this is staged to S3 by THIS lambda (server-side PUT of the
 * bytes it already holds) and enqueued as an S3-reference job instead. The
 * 6 MB INLINE routing ceiling is a Bedrock ingest-request limit, not an SQS
 * transport limit — the two are independent.
 */
const SQS_SAFE_INLINE_BYTES = 180 * 1024; // 184_320 raw → ~245 KB base64+JSON

interface UploadEnv {
  readonly statusTable: string;
  readonly queueUrl: string;
  readonly bucket: string;
}

/** Read + validate required environment configuration once. */
function readEnv(env: NodeJS.ProcessEnv = process.env): UploadEnv {
  const statusTable = env['STATUS_TABLE'];
  const queueUrl = env['INGEST_QUEUE_URL'];
  const bucket = env['DOCUMENTS_BUCKET'];
  const missing = [
    ['STATUS_TABLE', statusTable],
    ['INGEST_QUEUE_URL', queueUrl],
    ['DOCUMENTS_BUCKET', bucket],
  ]
    .filter(([, v]) => v === undefined || v === '')
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new HttpError('INTERNAL', `missing required env: ${missing.join(', ')}`);
  }
  // Narrowed by the check above.
  return { statusTable: statusTable!, queueUrl: queueUrl!, bucket: bucket! };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const cfg = readEnv();
    const tenant = resolveTenant(event);
    const body = parseJsonBody(event);
    const request = validateUploadRequest(body);

    const response = await processUpload(cfg, tenant, request);
    log.info('upload accepted', {
      tenantId: tenant.tenantId,
      documentId: response.documentId,
      ingestPath: response.ingestPath,
      sizeBytes: request.sizeBytes,
    });
    return ok(response);
  } catch (err) {
    if (err instanceof SizeRouterError) {
      // Map the router's domain errors onto the API envelope.
      const code = err.code === 'UNSUPPORTED_FORMAT' ? 'UNSUPPORTED_FORMAT' : 'FILE_TOO_LARGE';
      log.warn('upload rejected by size router', { code, message: err.message });
      return errorResponse(new HttpError(code, err.message));
    }
    if (err instanceof HttpError) {
      // Client / tenancy errors are warnings, server faults are errors.
      const level = err.code === 'INTERNAL' ? 'error' : 'warn';
      log[level]('upload error', { code: err.code, message: err.message });
      return errorResponse(err);
    }
    log.error('upload unhandled error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
};

async function processUpload(
  cfg: UploadEnv,
  tenant: TenantContext,
  request: UploadRequest,
): Promise<UploadResponse> {
  // 1. Route by size (validates format + 50 MB hard cap). Throws SizeRouterError.
  const decision = routeBySize(
    request.filename,
    request.contentType,
    request.sizeBytes,
    sizeRouterConfigFromEnv(),
  );

  // 2. Inline path requires the bytes up front; S3 path must NOT carry inline bytes.
  const inlineBytes = request.contentBase64;
  if (decision.path === IngestPath.INLINE && inlineBytes === undefined) {
    throw new HttpError(
      'INTERNAL',
      'inline-sized upload requires contentBase64 (the inline bytes)',
    );
  }
  if (decision.path === IngestPath.S3 && request.contentBase64 !== undefined) {
    throw new HttpError(
      'PAYLOAD_TOO_LARGE',
      'file exceeds the inline ceiling; omit contentBase64 and use the presigned S3 path',
    );
  }

  // 3. Deterministic, idempotent document id. For inline we hash the bytes; for
  //    S3 we hash a stable surrogate (tenant+filename+size) since we don't yet
  //    hold the bytes — re-requesting the same upload yields the same id/key.
  const contentHash =
    request.contentBase64 !== undefined
      ? hashContent(Buffer.from(request.contentBase64, 'base64'))
      : hashContent(`${tenant.tenantId}\n${request.filename}\n${request.sizeBytes}`);
  const documentId = buildDocumentId({
    tenantId: tenant.tenantId,
    filename: request.filename,
    contentHash,
  });

  // 4. Scope metadata attributes (validated against the reserved-key rule).
  //    PER-USER isolation: tag BOTH tenant_id (kept) AND user_id (= Cognito
  //    sub), both server-derived from the resolved context — never the body.
  const tenantAttr: MetadataAttribute = buildTenantMetadataAttribute(tenant);
  const userAttr: MetadataAttribute = buildUserMetadataAttribute(tenant);
  const metadata = mergeMetadata([tenantAttr, userAttr], request.attributes);

  const now = new Date().toISOString();

  // Inline bytes above the SQS transport ceiling are staged to S3 server-side
  // (we already hold them) and the job carries the reference instead — the SQS
  // message must stay under 256 KiB regardless of the 6 MB INLINE ingest cap.
  const stageInlineToS3 =
    decision.path === IngestPath.INLINE && request.sizeBytes > SQS_SAFE_INLINE_BYTES;
  const effectivePath = stageInlineToS3 ? IngestPath.S3 : decision.path;

  // 5. S3 key (tenant-prefixed) for any S3-backed job; presigned PUT only for
  //    the client-upload path (the staged-inline path is PUT by this lambda).
  const ext = extensionOf(request.filename) ?? '';
  const s3Key =
    effectivePath === IngestPath.S3
      ? `${tenant.tenantId}/${documentId}${ext}`
      : undefined;
  const s3Uri = s3Key !== undefined ? `s3://${cfg.bucket}/${s3Key}` : undefined;

  let uploadUrl: string | undefined;
  if (stageInlineToS3 && s3Key !== undefined) {
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: s3Key,
        Body: Buffer.from(inlineBytes as string, 'base64'),
        ContentType: request.contentType,
        Metadata: { tenant_id: tenant.tenantId },
      }),
    );
  } else if (decision.path === IngestPath.S3 && s3Key !== undefined) {
    uploadUrl = await presignPut(cfg.bucket, s3Key, request.contentType, tenant.tenantId);
  }

  // 6. Persist PENDING status BEFORE enqueueing so the UI can poll immediately
  //    and a successfully-enqueued job always has a backing row. Idempotent put
  //    keyed by documentId (re-upload overwrites in place).
  const record: DocStatusRecord = {
    documentId,
    tenantId: tenant.tenantId,
    filename: request.filename,
    status: DocStatus.PENDING,
    ingestPath: effectivePath,
    sizeBytes: request.sizeBytes,
    createdAt: now,
    updatedAt: now,
  };
  await putStatusRecord(cfg.statusTable, record);

  // 7. Enqueue the IngestJob. For the S3 path the worker reads bytes via s3Uri
  //    only after the bytes are in S3 (client PUT, or the staging PUT above).
  const job: IngestJob = {
    documentId,
    tenantId: tenant.tenantId,
    // Per-user scope flows to the worker so it tags the document's user_id.
    ...(tenant.userId !== undefined ? { userId: tenant.userId } : {}),
    filename: request.filename,
    contentType: decision.contentType,
    sizeBytes: request.sizeBytes,
    ingestPath: effectivePath,
    ...(effectivePath === IngestPath.INLINE
      ? { contentBase64: inlineBytes as string }
      : { s3Uri: s3Uri as string }),
    metadata,
    attempt: 1,
    enqueuedAt: new Date().toISOString(),
  };
  await enqueueIngestJob(cfg.queueUrl, job, documentId, tenant.tenantId);

  return {
    documentId,
    tenantId: tenant.tenantId,
    status: DocStatus.PENDING,
    ingestPath: effectivePath,
    ...(uploadUrl !== undefined ? { uploadUrl } : {}),
    // s3Key is surfaced only for the client-upload path; the staged-inline
    // object is internal.
    ...(uploadUrl !== undefined && s3Key !== undefined ? { s3Key } : {}),
    createdAt: now,
  };
}

/**
 * Merge the (trusted) scope attributes with the caller's (untrusted) attributes.
 * The trusted attributes (tenant_id, user_id) always win; a client attempt to
 * set either key is dropped here, and validation already rejected reserved
 * (underscore-prefixed) keys.
 */
function mergeMetadata(
  trusted: readonly MetadataAttribute[],
  attributes: Readonly<Record<string, string>> | undefined,
): readonly MetadataAttribute[] {
  const out: MetadataAttribute[] = [...trusted];
  const reserved = new Set(trusted.map((a) => a.key));
  if (attributes !== undefined) {
    for (const [key, value] of Object.entries(attributes)) {
      if (reserved.has(key)) continue;
      out.push({ key, value });
    }
  }
  return out;
}

async function presignPut(
  bucket: string,
  key: string,
  contentType: string,
  tenantId: string,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    // Tag the object with its tenant for defense-in-depth / lifecycle policy.
    Metadata: { tenant_id: tenantId },
  });
  return getSignedUrl(s3, command, {
    expiresIn: PRESIGN_TTL_SECONDS,
    // Lock the signature to ContentType so the client cannot upload a
    // different declared type than was validated/routed.
    signableHeaders: new Set(['content-type']),
  });
}

async function putStatusRecord(
  table: string,
  record: DocStatusRecord,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: { ...record },
    }),
  );
}

async function enqueueIngestJob(
  queueUrl: string,
  job: IngestJob,
  documentId: string,
  tenantId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(job),
      // The ingest queue is FIFO: MessageGroupId is REQUIRED. Group PER DOCUMENT
      // (not per user) so a single user's uploads fan out across many groups and
      // process in parallel up to the worker's concurrency + TPS caps — a shared
      // per-user group serializes the whole batch behind one message at a time
      // (FIFO delivers one in-flight message per group). Distinct documents have
      // no ordering relationship; re-submitting the SAME document collapses via
      // content-based dedup (the body is the deterministic IngestJob), so no
      // explicit MessageDeduplicationId and no lost ordering guarantee. The real
      // safety rails are the worker's ≤5 TPS gate and ≤10 concurrency (F2/F4),
      // which this lets us actually reach instead of being stuck at 1.
      MessageGroupId: documentId,
      MessageAttributes: {
        documentId: { DataType: 'String', StringValue: documentId },
        tenantId: { DataType: 'String', StringValue: tenantId },
        ingestPath: { DataType: 'String', StringValue: job.ingestPath },
      },
    }),
  );
}

/** Deterministic id helper exposed for tests (pure, no AWS calls). */
export function deriveDocumentId(
  tenantId: string,
  filename: string,
  contentBase64: string | undefined,
  sizeBytes: number,
): string {
  const contentHash =
    contentBase64 !== undefined
      ? hashContent(Buffer.from(contentBase64, 'base64'))
      : hashContent(`${tenantId}\n${filename}\n${sizeBytes}`);
  return buildDocumentId({ tenantId, filename, contentHash });
}

// Surface a stable container id in logs to aid debugging cold starts.
log.info('upload container init', { containerId: randomUUID(), region: REGION });
