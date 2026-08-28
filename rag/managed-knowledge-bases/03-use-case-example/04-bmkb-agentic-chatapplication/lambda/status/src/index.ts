/**
 * GET /status — Lambda handler (API Gateway proxy).
 *
 * Flow (see README → API reference → GET /status):
 *  1. Resolve TenantContext; deny if missing (MISSING_TENANT).
 *  2. Single doc:  ?docId=...      → DocStatusRecord (StatusResponse).
 *     Batch poll:  ?docId=a&docId=b (or ?docIds=a,b) → BatchStatusResponse.
 *  3. Read row(s) from DynamoDB; enforce tenant ownership — a row for another
 *     tenant is reported as NOT_FOUND (never leaked).
 *  4. If a row is still PENDING, optionally reconcile against Bedrock
 *     (GetKnowledgeBaseDocuments) and lazily persist any terminal transition.
 *
 * All shared contracts/helpers come from @bmkb/common; nothing is redefined.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  BedrockAgentClient,
  GetKnowledgeBaseDocumentsCommand,
  type DocumentIdentifier,
} from '@aws-sdk/client-bedrock-agent';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  DocStatus,
  isDocumentId,
  type BatchStatusResponse,
  type DocStatusRecord,
  type StatusResponse,
  type TenantContext,
} from '@bmkb/common';

import { HttpError, errorResponse, ok, resolveTenant } from './http.js';
import { log } from './logger.js';
import { findDetailForDocument, mapKbStatus } from './reconcile.js';

const REGION = process.env['AWS_REGION'] ?? 'us-west-2';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const bedrock = new BedrockAgentClient({ region: REGION });

/** Hard cap on how many docs one batch-status request may poll. */
const MAX_BATCH_DOCS = 100;

interface StatusEnv {
  readonly statusTable: string;
  readonly tenantIndex: string;
  readonly kbId?: string;
  readonly dataSourceId?: string;
  /** Whether to reconcile PENDING rows against Bedrock on read. */
  readonly reconcile: boolean;
}

function readEnv(env: NodeJS.ProcessEnv = process.env): StatusEnv {
  const statusTable = env['STATUS_TABLE'];
  if (statusTable === undefined || statusTable === '') {
    throw new HttpError('INTERNAL', 'missing required env: STATUS_TABLE');
  }
  const tenantIndex = env['TENANT_INDEX'] ?? 'tenant-index';
  const kbId = env['KB_ID'];
  const dataSourceId = env['DATA_SOURCE_ID'];
  // Reconcile only when both KB ids are configured and not explicitly disabled.
  const reconcile =
    env['STATUS_RECONCILE'] !== 'false' &&
    kbId !== undefined &&
    kbId !== '' &&
    dataSourceId !== undefined &&
    dataSourceId !== '';
  return {
    statusTable,
    tenantIndex,
    ...(kbId !== undefined && kbId !== '' ? { kbId } : {}),
    ...(dataSourceId !== undefined && dataSourceId !== '' ? { dataSourceId } : {}),
    reconcile,
  };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const cfg = readEnv();
    const tenant = resolveTenant(event);

    // Route: GET /documents → list all documents for this tenant.
    if (event.resource === '/documents' && event.httpMethod === 'GET') {
      return listDocuments(cfg, tenant);
    }

    // Route: DELETE /documents?docId=X → delete from KB + DynamoDB.
    if (event.resource === '/documents' && event.httpMethod === 'DELETE') {
      return deleteDocument(cfg, tenant, event);
    }

    const { docIds, batchRequested } = parseDocIds(event);

    // The response SHAPE follows the request form, not the id count: a plain
    // `?docId=x` returns a single StatusResponse; `?docIds=…` (or repeated
    // docId keys) always returns a BatchStatusResponse, even for one id —
    // otherwise a batch poller with one pending doc gets the wrong shape.
    if (!batchRequested && docIds.length === 1) {
      const record = await getTenantScopedStatus(cfg, tenant, docIds[0]!);
      const response: StatusResponse = record;
      log.info('status read', {
        tenantId: tenant.tenantId,
        documentId: record.documentId,
        status: record.status,
      });
      return ok(response);
    }

    // Bounded parallelism: each PENDING row may reconcile against Bedrock, and
    // 100 concurrent GetKnowledgeBaseDocuments calls would throttle the
    // control plane. 5 at a time keeps a full batch fast without a burst.
    const records = await mapWithConcurrency(docIds, 5, (id) =>
      getTenantScopedStatusOrNull(cfg, tenant, id),
    );
    const documents = records.filter((r): r is DocStatusRecord => r !== null);
    const response: BatchStatusResponse = { tenantId: tenant.tenantId, documents };
    log.info('status batch read', {
      tenantId: tenant.tenantId,
      requested: docIds.length,
      found: documents.length,
    });
    return ok(response);
  } catch (err) {
    if (err instanceof HttpError) {
      const level = err.code === 'INTERNAL' ? 'error' : 'warn';
      log[level]('status error', { code: err.code, message: err.message });
      return errorResponse(err);
    }
    log.error('status unhandled error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
};

/** List all documents for the authenticated tenant, newest first. */
async function listDocuments(
  cfg: StatusEnv,
  tenant: TenantContext,
): Promise<APIGatewayProxyResult> {
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const out = await ddb.send(
    new QueryCommand({
      TableName: cfg.statusTable,
      IndexName: cfg.tenantIndex,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenant.tenantId },
      ScanIndexForward: false, // newest first (createdAt sort key DESC)
      Limit: 100,
    }),
  );
  const documents = (out.Items ?? []) as DocStatusRecord[];
  log.info('documents listed', {
    tenantId: tenant.tenantId,
    count: documents.length,
  });
  const response: BatchStatusResponse = { tenantId: tenant.tenantId, documents };
  return ok(response);
}

/** DELETE /documents?docId=X — delete from the KB and remove the DynamoDB row. */
async function deleteDocument(
  cfg: StatusEnv,
  tenant: TenantContext,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const docId = event.queryStringParameters?.['docId']?.trim();
  if (!docId || !isDocumentId(docId)) {
    throw new HttpError('NOT_FOUND', 'docId query parameter is required');
  }

  // Verify ownership before deleting.
  const { GetCommand: Get, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  const existing = await ddb.send(new Get({ TableName: cfg.statusTable, Key: { documentId: docId } }));
  if (!existing.Item || (existing.Item as DocStatusRecord).tenantId !== tenant.tenantId) {
    throw new HttpError('NOT_FOUND', 'document not found');
  }

  // Delete from Bedrock KB.
  if (cfg.kbId && cfg.dataSourceId) {
    const { DeleteKnowledgeBaseDocumentsCommand } = await import('@aws-sdk/client-bedrock-agent');
    try {
      await bedrock.send(
        new DeleteKnowledgeBaseDocumentsCommand({
          knowledgeBaseId: cfg.kbId,
          dataSourceId: cfg.dataSourceId,
          documentIdentifiers: [{ dataSourceType: 'CUSTOM', custom: { id: docId } }],
        }),
      );
    } catch (err) {
      log.warn('KB delete failed; continuing with DDB removal', {
        documentId: docId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Delete from DynamoDB.
  await ddb.send(new DeleteCommand({ TableName: cfg.statusTable, Key: { documentId: docId } }));

  log.info('document deleted', { tenantId: tenant.tenantId, documentId: docId });
  return ok({ deleted: true, documentId: docId });
}

/** Parse + validate docId(s) from the query string. */
function parseDocIds(event: APIGatewayProxyEvent): {
  docIds: string[];
  /** True when the caller used a batch form (docIds= or repeated docId). */
  batchRequested: boolean;
} {
  const single = event.queryStringParameters?.['docId'];
  const multiCsv = event.queryStringParameters?.['docIds'];
  // API Gateway surfaces repeated keys via multiValueQueryStringParameters.
  const multi = event.multiValueQueryStringParameters?.['docId'];

  const collected = new Set<string>();
  if (typeof single === 'string') addId(collected, single);
  if (typeof multiCsv === 'string') {
    for (const part of multiCsv.split(',')) addId(collected, part);
  }
  if (Array.isArray(multi)) {
    for (const part of multi) addId(collected, part);
  }

  const ids = [...collected];
  if (ids.length === 0) {
    // Client input error: the required parameter is absent (400, not 404).
    throw new HttpError('INVALID_TENANT_KEY', 'docId query parameter is required');
  }
  if (ids.length > MAX_BATCH_DOCS) {
    throw new HttpError('BATCH_TOO_LARGE', `at most ${MAX_BATCH_DOCS} docIds per request`);
  }
  const batchRequested =
    typeof multiCsv === 'string' || (Array.isArray(multi) && multi.length > 1);
  return { docIds: ids, batchRequested };
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function addId(set: Set<string>, raw: string): void {
  const id = raw.trim();
  if (id.length === 0) return;
  // Reject anything that does not look like an id we issue: avoids unbounded /
  // injected key reads against DynamoDB.
  if (!isDocumentId(id)) {
    throw new HttpError('NOT_FOUND', `malformed docId "${id}"`);
  }
  set.add(id);
}

/** Single-doc read that throws NOT_FOUND when absent or cross-tenant. */
async function getTenantScopedStatus(
  cfg: StatusEnv,
  tenant: TenantContext,
  documentId: string,
): Promise<DocStatusRecord> {
  const record = await getTenantScopedStatusOrNull(cfg, tenant, documentId);
  if (record === null) {
    throw new HttpError('NOT_FOUND', 'document not found');
  }
  return record;
}

/**
 * Read a status row by documentId and enforce tenant ownership. Returns null
 * (not another tenant's data) if the row is missing or belongs to a different
 * tenant. Reconciles PENDING rows against Bedrock when configured.
 */
async function getTenantScopedStatusOrNull(
  cfg: StatusEnv,
  tenant: TenantContext,
  documentId: string,
): Promise<DocStatusRecord | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: cfg.statusTable,
      Key: { documentId },
    }),
  );
  const item = res.Item;
  if (item === undefined) return null;

  const record = item as DocStatusRecord;
  // Tenant isolation: never return another tenant's row. Treated as NOT_FOUND
  // upstream so existence of another tenant's doc is not leaked.
  if (record.tenantId !== tenant.tenantId) {
    log.warn('status cross-tenant access blocked', {
      tenantId: tenant.tenantId,
      documentId,
    });
    return null;
  }

  // Only PENDING rows are worth reconciling; INDEXED/FAILED are terminal.
  if (record.status === DocStatus.PENDING && cfg.reconcile) {
    return reconcilePending(cfg, record);
  }
  return record;
}

/**
 * Reconcile a PENDING row against Bedrock. Always checks the current Bedrock
 * status and returns it (including intermediate states like STARTING, IN_PROGRESS)
 * so the UI can show progression. Persists terminal transitions (INDEXED/FAILED).
 */
async function reconcilePending(
  cfg: StatusEnv,
  record: DocStatusRecord,
): Promise<DocStatusRecord> {
  if (cfg.kbId === undefined || cfg.dataSourceId === undefined) return record;
  try {
    const identifier: DocumentIdentifier = {
      dataSourceType: 'CUSTOM',
      custom: { id: record.documentId },
    };
    const out = await bedrock.send(
      new GetKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: cfg.kbId,
        dataSourceId: cfg.dataSourceId,
        documentIdentifiers: [identifier],
      }),
    );
    const detail = findDetailForDocument(out.documentDetails, record.documentId);
    const mapped = mapKbStatus(detail?.status, detail?.statusReason, record.createdAt);

    // Always include the raw Bedrock status so the UI can show progression.
    const withKbStatus: DocStatusRecord = {
      ...record,
      knowledgeBaseStatus: mapped.knowledgeBaseStatus,
    };

    // If still in-flight, return the record with the live knowledgeBaseStatus
    // but don't persist (it will advance on next poll).
    if (mapped.status === DocStatus.PENDING) return withKbStatus;

    const now = new Date().toISOString();
    const updated: DocStatusRecord = {
      ...record,
      status: mapped.status,
      knowledgeBaseStatus: mapped.knowledgeBaseStatus,
      updatedAt: now,
      ...(mapped.failureReason !== undefined
        ? { failureReason: mapped.failureReason }
        : {}),
    };
    await persistTransition(cfg.statusTable, updated);
    log.info('status reconciled', {
      tenantId: record.tenantId,
      documentId: record.documentId,
      from: DocStatus.PENDING,
      to: mapped.status,
      knowledgeBaseStatus: mapped.knowledgeBaseStatus,
    });
    return updated;
  } catch (err) {
    log.warn('status reconcile failed; serving stored row', {
      tenantId: record.tenantId,
      documentId: record.documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return record;
  }
}

/**
 * Persist a terminal status transition. Conditioned on the row still belonging
 * to the same tenant and still being PENDING so we never clobber a concurrent
 * update from the ingest-worker.
 */
async function persistTransition(
  table: string,
  updated: DocStatusRecord,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { documentId: updated.documentId },
        UpdateExpression:
          'SET #status = :status, updatedAt = :updatedAt' +
          (updated.failureReason !== undefined ? ', failureReason = :failureReason' : ''),
        ConditionExpression: 'tenantId = :tenantId AND #status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': updated.status,
          ':updatedAt': updated.updatedAt,
          ':tenantId': updated.tenantId,
          ':pending': DocStatus.PENDING,
          ...(updated.failureReason !== undefined
            ? { ':failureReason': updated.failureReason }
            : {}),
        },
      }),
    );
  } catch (err) {
    // ConditionalCheckFailed means the worker already moved it — benign.
    const name = err instanceof Error ? err.name : '';
    if (name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }
}

// ===========================================================================
// Scheduled self-heal sweep (EventBridge → sweepHandler)
// ===========================================================================

/** Max PENDING rows reconciled per sweep invocation (bounds control-plane calls). */
const SWEEP_MAX_ROWS = 500;
/** Bounded concurrency for per-row Bedrock reconciliation during a sweep. */
const SWEEP_CONCURRENCY = 5;

/**
 * Scheduled reconciliation sweep. The on-read path only reconciles rows a client
 * is ACTIVELY polling — a document whose UI session ended (or was never polled)
 * can sit PENDING forever even after Bedrock has terminally NOT_FOUND/FAILED it.
 * This EventBridge-driven handler scans the status table for PENDING rows and
 * runs the SAME reconcile logic, so a NOT_FOUND-past-grace row transitions to
 * FAILED without any client involvement. Within the grace window it is a no-op
 * (the row stays PENDING), so a freshly-uploaded doc is never mis-marked.
 *
 * The scan is a full table scan filtered to PENDING; the table is small (one row
 * per document) and the sweep runs infrequently, so this is intentionally simple
 * rather than GSI-backed. Bounded to SWEEP_MAX_ROWS per run.
 */
export const sweepHandler = async (): Promise<{
  scanned: number;
  reconciled: number;
  transitioned: number;
}> => {
  const cfg = readEnv();
  if (!cfg.reconcile) {
    log.warn('status sweep skipped; reconcile disabled or KB ids missing');
    return { scanned: 0, reconciled: 0, transitioned: 0 };
  }

  const pending = await scanPending(cfg.statusTable, SWEEP_MAX_ROWS);
  let transitioned = 0;
  const results = await mapWithConcurrency(pending, SWEEP_CONCURRENCY, async (record) => {
    const updated = await reconcilePending(cfg, record);
    return updated.status !== DocStatus.PENDING;
  });
  for (const changed of results) if (changed) transitioned += 1;

  log.info('status sweep complete', {
    scanned: pending.length,
    reconciled: pending.length,
    transitioned,
  });
  return { scanned: pending.length, reconciled: pending.length, transitioned };
};

/**
 * Scan up to `max` PENDING rows from the status table. Paginates the Scan (with
 * a PENDING FilterExpression) until the cap is hit or the table is exhausted.
 * FilterExpression is applied server-side AFTER the read, so we page until we
 * have enough matches rather than assuming one page suffices.
 */
async function scanPending(table: string, max: number): Promise<DocStatusRecord[]> {
  const rows: DocStatusRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': DocStatus.PENDING },
        ...(exclusiveStartKey !== undefined
          ? { ExclusiveStartKey: exclusiveStartKey }
          : {}),
      }),
    );
    for (const item of out.Items ?? []) {
      rows.push(item as DocStatusRecord);
      if (rows.length >= max) return rows;
    }
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return rows;
}
