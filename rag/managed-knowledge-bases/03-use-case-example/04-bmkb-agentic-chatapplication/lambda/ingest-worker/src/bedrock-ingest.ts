/**
 * Build and execute IngestKnowledgeBaseDocuments for a batch of IngestJobs.
 *
 * Verified constraints baked in here (F1–F5, F11/F12):
 *  - Batch already capped at 10 by chunkIntoBatches before this is called; we
 *    assert it again (assertBatchWithinCap) so a misbuilt batch can't slip by.
 *  - INLINE jobs carry base64/text bytes; TEXT for text/* mime types, BYTE
 *    (raw bytes) otherwise. Tenant scope is attached as an inline metadata
 *    attribute keyed "tenant_id" (plain key — never "_tenant_id", F12).
 *  - S3 jobs reference the object via a CUSTOM data source + S3_LOCATION source.
 *  - customDocumentIdentifier.id = our deterministic documentId, so a replay
 *    overwrites in place (idempotent, F-resilience).
 *
 * The response is mapped per-document back to IngestResult[] keyed by the
 * customDocumentIdentifier so a partial-batch failure isolates the bad doc.
 */

import {
  BedrockAgentClient,
  IngestKnowledgeBaseDocumentsCommand,
  type IngestKnowledgeBaseDocumentsCommandInput,
  type KnowledgeBaseDocument,
  type KnowledgeBaseDocumentDetail,
} from '@aws-sdk/client-bedrock-agent';
import {
  DocStatus,
  TENANT_METADATA_KEY,
  USER_METADATA_KEY,
  IngestPath,
  assertBatchWithinCap,
  assertValidMetadataKey,
  assertValidTenantId,
  type IngestJob,
  type IngestResult,
  type MetadataAttribute,
} from '@bmkb/common';

import { logger } from './logger.js';

/** KB statuses that are terminal failures for the document. */
const FAILURE_STATUSES = new Set<string>([
  'FAILED',
  'METADATA_UPDATE_FAILED',
  'NOT_FOUND',
]);

/** KB statuses that mean the document is fully queryable. */
const INDEXED_STATUSES = new Set<string>(['INDEXED']);

/** Text MIME types ingest as TEXT inline content; everything else as BYTE. */
function isTextMime(contentType: string): boolean {
  return contentType.startsWith('text/');
}

export interface BuildBatchOptions {
  readonly knowledgeBaseId: string;
  readonly dataSourceId: string;
  readonly bucketOwnerAccountId?: string;
  /** Idempotency token for the whole request (Bedrock dedupes retries). */
  readonly clientToken: string;
}

/**
 * Convert one IngestJob into a KnowledgeBaseDocument. Throws on a malformed job
 * (missing bytes/uri, bad tenant tag) so the caller can fail just that document
 * instead of the whole batch.
 */
export function buildKnowledgeBaseDocument(
  job: IngestJob,
  opts: BuildBatchOptions,
): KnowledgeBaseDocument {
  assertValidTenantId(job.tenantId);

  const inlineAttributes = buildInlineAttributes(job);

  if (job.ingestPath === IngestPath.INLINE) {
    if (!job.contentBase64 || job.contentBase64.trim() === '') {
      throw new Error(`INLINE job ${job.documentId} is missing contentBase64`);
    }
    const inlineContent = isTextMime(job.contentType)
      ? {
          type: 'TEXT' as const,
          textContent: { data: decodeBase64Utf8(job.contentBase64) },
        }
      : {
          type: 'BYTE' as const,
          byteContent: {
            mimeType: job.contentType,
            data: decodeBase64Bytes(job.contentBase64),
          },
        };

    return {
      metadata: {
        type: 'IN_LINE_ATTRIBUTE',
        inlineAttributes,
      },
      content: {
        dataSourceType: 'CUSTOM',
        custom: {
          customDocumentIdentifier: { id: job.documentId },
          sourceType: 'IN_LINE',
          inlineContent,
        },
      },
    };
  }

  // S3 reference path.
  if (!job.s3Uri || job.s3Uri.trim() === '') {
    throw new Error(`S3 job ${job.documentId} is missing s3Uri`);
  }
  return {
    metadata: {
      type: 'IN_LINE_ATTRIBUTE',
      inlineAttributes,
    },
    content: {
      dataSourceType: 'CUSTOM',
      custom: {
        customDocumentIdentifier: { id: job.documentId },
        sourceType: 'S3_LOCATION',
        s3Location: {
          uri: job.s3Uri,
          ...(opts.bucketOwnerAccountId !== undefined
            ? { bucketOwnerAccountId: opts.bucketOwnerAccountId }
            : {}),
        },
      },
    },
  };
}

/**
 * Build the inline metadata attributes for a job, guaranteeing the tenant
 * attribute is present and well-formed. Any caller-supplied attributes are
 * validated (no reserved underscore keys) and the tenant attribute is forced
 * to the job's tenant — it cannot be overridden by client metadata.
 */
function buildInlineAttributes(job: IngestJob): Array<{
  key: string;
  value: { type: 'STRING'; stringValue: string };
}> {
  const byKey = new Map<string, string>();

  for (const attr of job.metadata ?? []) {
    assertMetadataAttribute(attr);
    // tenant / user keys handled explicitly below; ignore any inbound value.
    if (attr.key === TENANT_METADATA_KEY || attr.key === USER_METADATA_KEY) continue;
    byKey.set(attr.key, attr.value);
  }

  // Force the authoritative tenant scope (server-derived, never client-trusted).
  byKey.set(TENANT_METADATA_KEY, job.tenantId);
  // Force the authoritative per-user scope (Cognito sub) when the job carries
  // it, so retrieval can isolate per-user. Server-derived, never client-trusted.
  if (job.userId !== undefined && job.userId.trim() !== '') {
    byKey.set(USER_METADATA_KEY, job.userId);
  }

  return [...byKey.entries()].map(([key, value]) => ({
    key,
    value: { type: 'STRING', stringValue: value },
  }));
}

function assertMetadataAttribute(attr: MetadataAttribute): void {
  assertValidMetadataKey(attr.key);
  if (typeof attr.value !== 'string') {
    throw new Error(`metadata attribute "${attr.key}" must have a string value`);
  }
}

function decodeBase64Bytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function decodeBase64Utf8(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf-8');
}

export interface BedrockIngesterOptions extends BuildBatchOptions {
  readonly client: BedrockAgentClient;
}

/**
 * Execute one IngestKnowledgeBaseDocuments call for an already-validated batch.
 * Returns an IngestResult per job. Jobs that fail to BUILD are reported FAILED
 * without poisoning the rest of the batch; the remaining jobs are sent and
 * their per-document statuses mapped from the response.
 */
export async function ingestBatch(
  jobs: readonly IngestJob[],
  opts: BedrockIngesterOptions,
): Promise<IngestResult[]> {
  assertBatchWithinCap(jobs.length);

  const results: IngestResult[] = [];
  const documents: KnowledgeBaseDocument[] = [];
  const sentJobIds: string[] = [];

  for (const job of jobs) {
    try {
      documents.push(buildKnowledgeBaseDocument(job, opts));
      sentJobIds.push(job.documentId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('failed to build KB document', {
        documentId: job.documentId,
        tenantId: job.tenantId,
        reason: message,
      });
      results.push({
        documentId: job.documentId,
        status: DocStatus.FAILED,
        failureReason: `build error: ${message}`,
      });
    }
  }

  if (documents.length === 0) {
    return results;
  }

  const input: IngestKnowledgeBaseDocumentsCommandInput = {
    knowledgeBaseId: opts.knowledgeBaseId,
    dataSourceId: opts.dataSourceId,
    clientToken: opts.clientToken,
    documents,
  };

  const response = await opts.client.send(
    new IngestKnowledgeBaseDocumentsCommand(input),
  );

  results.push(
    ...mapResponseToResults(sentJobIds, response.documentDetails ?? []),
  );
  return results;
}

/**
 * Map the response documentDetails back to the jobs we sent, by
 * customDocumentIdentifier.id. A job with no matching detail is reported
 * PENDING (the call was accepted; status reconciliation happens via the status
 * lambda's GetKnowledgeBaseDocuments) rather than guessed as failed.
 */
export function mapResponseToResults(
  sentJobIds: readonly string[],
  details: readonly KnowledgeBaseDocumentDetail[],
): IngestResult[] {
  const byId = new Map<string, KnowledgeBaseDocumentDetail>();
  for (const detail of details) {
    const id = detail.identifier?.custom?.id;
    if (id) byId.set(id, detail);
  }

  return sentJobIds.map((documentId): IngestResult => {
    const detail = byId.get(documentId);
    if (!detail) {
      // Call was accepted but Bedrock returned no detail for this id. Leave it
      // PENDING; the status lambda reconciles via GetKnowledgeBaseDocuments.
      return {
        documentId,
        status: DocStatus.PENDING,
        knowledgeBaseStatus: 'NO_DETAIL',
      };
    }
    const kbStatus = detail.status ?? 'UNKNOWN';
    if (FAILURE_STATUSES.has(kbStatus)) {
      return {
        documentId,
        status: DocStatus.FAILED,
        knowledgeBaseStatus: kbStatus,
        failureReason: detail.statusReason ?? `KB status ${kbStatus}`,
      };
    }
    if (INDEXED_STATUSES.has(kbStatus)) {
      return {
        documentId,
        status: DocStatus.INDEXED,
        knowledgeBaseStatus: kbStatus,
      };
    }
    // STARTING / IN_PROGRESS / PENDING / *PARTIALLY_INDEXED / IGNORED: accepted
    // and still progressing — keep PENDING for the status lambda to finalize.
    return {
      documentId,
      status: DocStatus.PENDING,
      knowledgeBaseStatus: kbStatus,
    };
  });
}
