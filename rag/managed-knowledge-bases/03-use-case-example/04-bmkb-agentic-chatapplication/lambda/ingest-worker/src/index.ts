/**
 * SQS-triggered ingest worker.
 *
 * Flow (see README → API reference → Internal ingest):
 *  1. Parse + validate each SQS record into an IngestJob (poisoned messages →
 *     marked FAILED, NOT retried — they would never succeed).
 *  2. De-duplicate by deterministic documentId within the invocation
 *     (idempotency: a replayed job is a no-op overwrite).
 *  3. chunkIntoBatches(jobs, batchMax=10) — F1.
 *  4. Per batch: acquire a TokenBucket token (≤5 TPS, F2) and the account-wide
 *     DynamoDB ConcurrencyGate slot (≤10, F4), then call
 *     IngestKnowledgeBaseDocuments with inline tenant_id metadata (F11/F12).
 *  5. Map per-document outcomes → update DynamoDB status (INDEXED / FAILED;
 *     in-progress stays PENDING for the status lambda to finalize).
 *  6. Partial-batch handling: only RETRYABLE failures (throttle, gate-full,
 *     network, transient KB errors) are returned in batchItemFailures so SQS
 *     redelivers just those messages; after maxReceiveCount they land in the
 *     DLQ. Terminal failures are recorded FAILED and acked (not retried).
 *
 * All shared contracts/helpers come from @bmkb/common.
 */

import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SQSBatchResponse, SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import {
  DocStatus,
  IngestPath,
  TokenBucket,
  chunkIntoBatches,
  hashContent,
  type IngestJob,
  type IngestResult,
} from '@bmkb/common';

import { ingestBatch } from './bedrock-ingest.js';
import { loadConfig, type WorkerConfig } from './config.js';
import { DynamoConcurrencyGate, DynamoTpsGate } from './concurrency-gate.js';
import { describeError, logger } from './logger.js';
import { parseIngestJob } from './parse-job.js';
import { StatusStore, type StatusUpdate } from './status-store.js';

// --- Cold-start singletons (reused across invocations) ---------------------
interface WorkerDeps {
  readonly config: WorkerConfig;
  readonly bedrock: BedrockAgentClient;
  readonly s3: S3Client;
  readonly status: StatusStore;
  readonly gate: DynamoConcurrencyGate;
  readonly tpsGate: DynamoTpsGate;
}

let cached: WorkerDeps | undefined;

function bootstrap(): WorkerDeps {
  if (cached) return cached;
  const config = loadConfig();
  const bedrock = new BedrockAgentClient({ region: config.region });
  const s3 = new S3Client({ region: config.region });
  const ddoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  cached = {
    config,
    bedrock,
    s3,
    status: new StatusStore({ doc: ddoc, tableName: config.statusTable }),
    gate: new DynamoConcurrencyGate({
      doc: ddoc,
      tableName: config.rateTable,
      // The RateTable's partition key is `counterId` (see StorageConstruct);
      // the gate default ('pk') would mismatch the schema and fail UpdateItem.
      partitionKey: 'counterId',
      maxConcurrency: config.rate.maxConcurrency,
    }),
    // F2 is per ACCOUNT: the shared per-second counter is the real TPS gate;
    // the in-process TokenBucket only smooths within one invocation.
    tpsGate: new DynamoTpsGate({
      doc: ddoc,
      tableName: config.rateTable,
      partitionKey: 'counterId',
      maxConcurrency: config.rate.maxConcurrency,
      maxTps: config.rate.maxTps,
    }),
  };
  return cached;
}

/** A parsed job tagged with its originating SQS message id (partial-fail key). */
interface JobRecord {
  readonly job: IngestJob;
  readonly messageId: string;
}

interface ParseFailure {
  readonly messageId: string;
  readonly reason: string;
  readonly documentId?: string;
  readonly tenantId?: string;
}

/** How many times to retry acquiring the account-wide concurrency slot. */
const GATE_ACQUIRE_ATTEMPTS = 8;
const GATE_BACKOFF_BASE_MS = 100;

export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const deps = bootstrap();
  const bucket = new TokenBucket(deps.config.rate.maxTps, deps.config.rate.maxTps);
  const failedMessageIds = new Set<string>();

  // 1 + 2: parse, validate, de-duplicate by documentId.
  const { jobRecords, parseFailures } = parseRecords(event.Records);

  for (const failure of parseFailures) {
    // Poisoned message: record FAILED if we know the doc, then ACK (no retry —
    // it can never succeed). The message is consumed, not redriven.
    if (failure.documentId && failure.tenantId) {
      await safeMarkFailed(deps.status, failure.documentId, failure.tenantId, failure.reason);
    }
    logger.error('dropping unparseable message (acked, not retried)', {
      messageId: failure.messageId,
      reason: failure.reason,
    });
  }

  logger.info('processing ingest invocation', {
    records: event.Records.length,
    jobs: jobRecords.length,
    parseFailures: parseFailures.length,
  });

  if (jobRecords.length === 0) {
    return toBatchResponse(failedMessageIds);
  }

  const messageIdByDoc = new Map<string, string>(
    jobRecords.map((r) => [r.job.documentId, r.messageId] as const),
  );

  // 3: chunk into Bedrock-sized batches (≤10).
  const batches = chunkIntoBatches(
    jobRecords.map((r) => r.job),
    deps.config.rate.batchMax,
  );

  // 4 + 5: process batches sequentially (TPS shaping + bounded concurrency).
  for (const batch of batches) {
    const retryDocIds = await processBatch(batch, deps, bucket);
    for (const documentId of retryDocIds) {
      const messageId = messageIdByDoc.get(documentId);
      if (messageId) failedMessageIds.add(messageId);
    }
  }

  // FIFO group-ordering rule: once a message from a group fails, every LATER
  // message of the same group in this event must fail too — SQS redelivers
  // the failed message, and acking a later one would commit out of order.
  // Replays are idempotent (deterministic documentId; Bedrock overwrites), so
  // the extra retries are safe.
  failLaterGroupMessages(event.Records, failedMessageIds);

  return toBatchResponse(failedMessageIds);
};

/** Add to `failed` every record that follows a failed record in its group. */
function failLaterGroupMessages(
  records: readonly SQSRecord[],
  failed: Set<string>,
): void {
  const failedGroups = new Set<string>();
  for (const record of records) {
    const group = record.attributes?.MessageGroupId ?? '';
    if (failed.has(record.messageId)) {
      failedGroups.add(group);
    } else if (failedGroups.has(group)) {
      failed.add(record.messageId);
    }
  }
}

function toBatchResponse(ids: ReadonlySet<string>): SQSBatchResponse {
  return { batchItemFailures: [...ids].map((id) => ({ itemIdentifier: id })) };
}

/**
 * Process one ≤10-document batch. Returns the documentIds whose SQS messages
 * must be retried (transient failure). Terminal failures are written FAILED and
 * NOT returned. Successful / still-progressing docs are not returned either.
 */
async function processBatch(
  fullBatch: readonly IngestJob[],
  deps: WorkerDeps,
  bucket: TokenBucket,
): Promise<string[]> {
  // 4pre: S3-path jobs whose object has not landed yet (the client PUTs the
  // bytes AFTER /upload enqueues the job) are deferred back to SQS without
  // burning a Bedrock call — the ingest would deterministically fail with
  // "S3 path could not be found".
  const notYetUploaded = await filterMissingS3Objects(fullBatch, deps);
  const batch = fullBatch.filter((j) => !notYetUploaded.has(j.documentId));
  const deferredDocIds = [...notYetUploaded];
  if (batch.length === 0) return deferredDocIds;

  const allDocIds = batch.map((j) => j.documentId);

  // 4a: TPS gate (≤5 TPS). In-process smoothing first, then the shared
  // account-wide per-second counter (F2 is an ACCOUNT cap — ten concurrent
  // workers each with a local bucket would breach it tenfold).
  await bucket.waitForToken();
  await deps.tpsGate.waitForToken();

  // 4b: account-wide concurrency gate (≤10). When full after backoff, retry the
  // whole batch via SQS (transient).
  if (!(await acquireGateWithBackoff(deps.gate))) {
    logger.warn('concurrency gate full after retries — deferring batch to SQS', {
      batchSize: batch.length,
    });
    return [...deferredDocIds, ...allDocIds];
  }

  let results: IngestResult[];
  try {
    results = await ingestBatch(batch, {
      client: deps.bedrock,
      knowledgeBaseId: deps.config.knowledgeBaseId,
      dataSourceId: deps.config.dataSourceId,
      clientToken: buildClientToken(batch),
      ...(deps.config.bucketOwnerAccountId !== undefined
        ? { bucketOwnerAccountId: deps.config.bucketOwnerAccountId }
        : {}),
    });
  } catch (err: unknown) {
    // Whole-call failure. Throttling / 5xx / network → retry the batch.
    // Non-retryable validation/auth → mark every doc FAILED and ack.
    const retryable = isRetryableBedrockError(err);
    logger.error('IngestKnowledgeBaseDocuments call failed', {
      batchSize: batch.length,
      retryable,
      error: describeError(err),
    });
    if (retryable) return [...deferredDocIds, ...allDocIds];
    const reason = `ingest call failed: ${describeError(err).message}`;
    await Promise.all(
      batch.map((j) => safeMarkFailed(deps.status, j.documentId, j.tenantId, reason)),
    );
    return deferredDocIds;
  } finally {
    await deps.gate.release();
  }

  // 5: apply per-document outcomes to the status table.
  const tenantByDoc = new Map(batch.map((j) => [j.documentId, j.tenantId] as const));
  const jobByDoc = new Map(batch.map((j) => [j.documentId, j] as const));
  const retryDocIds: string[] = [];

  await Promise.all(
    results.map(async (result) => {
      const tenantId = tenantByDoc.get(result.documentId);
      if (!tenantId) {
        logger.error('result for unknown documentId (skipped)', {
          documentId: result.documentId,
        });
        return;
      }
      // S3-path race: /upload enqueues the job BEFORE the client PUTs the
      // bytes, so the first ingest attempt can beat the upload and Bedrock
      // reports FAILED "S3 path ... could not be found". That is transient,
      // not terminal — leave the row PENDING and send the message back to SQS
      // for redelivery (maxReceiveCount attempts, then DLQ).
      if (
        result.status === DocStatus.FAILED &&
        jobByDoc.get(result.documentId)?.ingestPath === IngestPath.S3 &&
        isMissingS3Object(result.failureReason)
      ) {
        logger.warn('S3 object not yet uploaded — retrying via SQS', {
          documentId: result.documentId,
          tenantId,
        });
        retryDocIds.push(result.documentId);
        return;
      }
      if (result.status === DocStatus.INDEXED || result.status === DocStatus.FAILED) {
        const update: StatusUpdate = {
          documentId: result.documentId,
          tenantId,
          status: result.status,
          ...(result.failureReason !== undefined
            ? { failureReason: result.failureReason }
            : {}),
          ...(result.knowledgeBaseStatus !== undefined
            ? { knowledgeBaseStatus: result.knowledgeBaseStatus }
            : {}),
        };
        await safeUpdate(deps.status, update);
      } else {
        // PENDING / in-progress: leave the row PENDING; the status lambda
        // reconciles via GetKnowledgeBaseDocuments. No retry needed.
        logger.info('document accepted, still progressing', {
          documentId: result.documentId,
          tenantId,
          knowledgeBaseStatus: result.knowledgeBaseStatus,
        });
      }
    }),
  );

  // Document-level transient failures (e.g. S3 object not yet uploaded) are
  // redriven via SQS; everything else was finalized above.
  return [...deferredDocIds, ...retryDocIds];
}

/** How long to wait in-invocation for a missing S3 object before deferring. */
const S3_WAIT_TOTAL_MS = 45_000;
const S3_WAIT_POLL_MS = 3_000;

/**
 * Return the documentIds of S3-path jobs whose object does not exist yet.
 * The client PUTs the bytes to the presigned URL only AFTER /upload returns,
 * so the first delivery usually races the upload. HeadObject is cheap; we poll
 * briefly in-invocation (uploads typically land within seconds) and only when
 * the object still has not appeared do we defer the message back to SQS
 * (redelivery after the visibility timeout, maxReceiveCount attempts → DLQ).
 * Errors other than a missing object (permissions, transient) do NOT defer —
 * the ingest call is the authority in that case.
 */
async function filterMissingS3Objects(
  batch: readonly IngestJob[],
  deps: WorkerDeps,
): Promise<Set<string>> {
  const missing = new Set<string>();
  const s3Jobs = batch.filter((j) => j.ingestPath === IngestPath.S3 && j.s3Uri !== undefined);
  if (s3Jobs.length === 0) return missing;

  const objectExists = async (job: IngestJob): Promise<boolean | undefined> => {
    const parsed = parseS3Uri(job.s3Uri as string);
    if (parsed === undefined) return undefined; // let ingest report the bad URI
    try {
      await deps.s3.send(new HeadObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }));
      return true;
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : '';
      const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || code === 404) return false;
      return undefined; // unknown error → do not defer
    }
  };

  await Promise.all(
    s3Jobs.map(async (job) => {
      const deadline = Date.now() + S3_WAIT_TOTAL_MS;
      for (;;) {
        const exists = await objectExists(job);
        if (exists !== false) return; // present, or indeterminate → proceed
        if (Date.now() >= deadline) break;
        await sleep(S3_WAIT_POLL_MS);
      }
      missing.add(job.documentId);
      logger.info('S3 object not yet present after wait — deferring to SQS', {
        documentId: job.documentId,
        tenantId: job.tenantId,
      });
    }),
  );
  return missing;
}

function parseS3Uri(uri: string): { bucket: string; key: string } | undefined {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return { bucket: match[1], key: match[2] };
}

/** Match Bedrock's "S3 path ... could not be found" ingest failure. */
function isMissingS3Object(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  const r = reason.toLowerCase();
  return r.includes('s3') && (r.includes('could not be found') || r.includes('not found'));
}

function parseRecords(records: readonly SQSRecord[]): {
  jobRecords: JobRecord[];
  parseFailures: ParseFailure[];
} {
  const seen = new Set<string>();
  const jobRecords: JobRecord[] = [];
  const parseFailures: ParseFailure[] = [];

  for (const record of records) {
    try {
      const job = parseIngestJob(record.body);
      if (seen.has(job.documentId)) {
        // Duplicate documentId within this invocation — idempotent; skip the
        // extra copy. SQS will ack it alongside the first (same redrive fate).
        logger.info('skipping duplicate documentId within batch', {
          documentId: job.documentId,
          messageId: record.messageId,
        });
        continue;
      }
      seen.add(job.documentId);
      jobRecords.push({ job, messageId: record.messageId });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      const partial = extractIdsBestEffort(record.body);
      parseFailures.push({
        messageId: record.messageId,
        reason,
        ...(partial.documentId !== undefined ? { documentId: partial.documentId } : {}),
        ...(partial.tenantId !== undefined ? { tenantId: partial.tenantId } : {}),
      });
    }
  }

  return { jobRecords, parseFailures };
}

/** Best-effort id extraction for logging/status on an unparseable message. */
function extractIdsBestEffort(body: string): { documentId?: string; tenantId?: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const documentId = typeof obj['documentId'] === 'string' ? obj['documentId'] : undefined;
      const tenantId = typeof obj['tenantId'] === 'string' ? obj['tenantId'] : undefined;
      return {
        ...(documentId !== undefined ? { documentId } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      };
    }
  } catch {
    /* not JSON — nothing to extract */
  }
  return {};
}

async function acquireGateWithBackoff(gate: DynamoConcurrencyGate): Promise<boolean> {
  for (let attempt = 0; attempt < GATE_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (await gate.tryAcquire()) return true;
    const backoff =
      GATE_BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * GATE_BACKOFF_BASE_MS);
    await sleep(backoff);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic client token for a batch so a retried invocation that sends the
 * exact same set of documents is deduplicated by Bedrock. Derived from a HASH
 * of the sorted documentIds: Bedrock's clientToken must match
 * `[a-zA-Z0-9](-*[a-zA-Z0-9]){0,256}` (no commas, no underscores), so the raw
 * joined ids are not valid — a hex hash is. Stable across replays of the batch.
 */
function buildClientToken(batch: readonly IngestJob[]): string {
  const joined = batch.map((j) => j.documentId).sort().join(',');
  return `b${hashContent(joined)}`;
}

async function safeUpdate(store: StatusStore, update: StatusUpdate): Promise<void> {
  try {
    await store.update(update);
  } catch (err: unknown) {
    logger.error('status update failed (continuing)', {
      documentId: update.documentId,
      error: describeError(err),
    });
  }
}

async function safeMarkFailed(
  store: StatusStore,
  documentId: string,
  tenantId: string,
  reason: string,
): Promise<void> {
  await safeUpdate(store, {
    documentId,
    tenantId,
    status: DocStatus.FAILED,
    failureReason: reason,
  });
}

/**
 * Classify a Bedrock SDK error as retryable (throttling / 5xx / network) vs
 * terminal (validation / auth / not-found). Retryable → back to SQS for redrive.
 */
function isRetryableBedrockError(err: unknown): boolean {
  if (!(err instanceof Error)) return true; // unknown shape → be safe, retry
  const name = err.name;
  if (
    name === 'ThrottlingException' ||
    name === 'ServiceQuotaExceededException' ||
    name === 'InternalServerException' ||
    name === 'TooManyRequestsException' ||
    name === 'ServiceUnavailableException' ||
    name === 'RequestTimeout' ||
    name === 'TimeoutError'
  ) {
    return true;
  }
  if (
    name === 'ValidationException' ||
    name === 'AccessDeniedException' ||
    name === 'ResourceNotFoundException'
  ) {
    return false;
  }
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const code = meta?.httpStatusCode;
  if (typeof code === 'number') {
    if (code === 429 || code >= 500) return true;
    if (code >= 400) return false;
  }
  return true; // default: retry transient-looking failures
}
