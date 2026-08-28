/**
 * Reconcile a stored status row against Bedrock's authoritative document status.
 *
 * The DynamoDB row is written PENDING at upload time and flipped to
 * INDEXED/FAILED by the ingest-worker. As a safety net (and to catch the worker
 * lagging), the status endpoint may call GetKnowledgeBaseDocuments and map the
 * Bedrock DocumentStatus onto our 3-state DocStatus.
 *
 * We use a CUSTOM data source, so a document is addressed by its custom id
 * (our deterministic documentId).
 */
import {
  DocumentStatus,
  type KnowledgeBaseDocumentDetail,
} from '@aws-sdk/client-bedrock-agent';
import { DocStatus } from '@bmkb/common';

export interface ReconcileResult {
  readonly status: DocStatus;
  readonly knowledgeBaseStatus: string;
  readonly failureReason?: string;
}

/**
 * Grace window during which a NOT_FOUND from Bedrock is treated as "still in
 * flight" rather than a terminal failure. A freshly-uploaded document sits in
 * SQS until the ingest-worker sends it to Bedrock, so GetKnowledgeBaseDocuments
 * legitimately returns NOT_FOUND for a while after the PENDING row is written.
 * Mapping that to FAILED would permanently mis-mark the document (FAILED rows
 * are never reconciled again). After the window, NOT_FOUND is terminal: the
 * message would have been ingested or DLQ'd long since.
 */
export const NOT_FOUND_GRACE_MS = 15 * 60 * 1000;

/**
 * Map a Bedrock DocumentStatus to our DocStatus.
 *   INDEXED / PARTIALLY_INDEXED / METADATA_PARTIALLY_INDEXED → INDEXED
 *   FAILED / METADATA_UPDATE_FAILED / IGNORED                 → FAILED
 *   NOT_FOUND → PENDING within the grace window (doc may still be queued),
 *               FAILED after it
 *   everything in-flight (PENDING/STARTING/IN_PROGRESS/...)    → PENDING
 *
 * @param rowCreatedAt ISO timestamp the PENDING row was written (upload time);
 *   drives the NOT_FOUND grace decision. Missing/unparseable → grace applies.
 */
export function mapKbStatus(
  kbStatus: DocumentStatus | undefined,
  statusReason?: string,
  rowCreatedAt?: string,
  now: () => number = () => Date.now(),
): ReconcileResult {
  switch (kbStatus) {
    case DocumentStatus.INDEXED:
    case DocumentStatus.PARTIALLY_INDEXED:
    case DocumentStatus.METADATA_PARTIALLY_INDEXED:
      return { status: DocStatus.INDEXED, knowledgeBaseStatus: kbStatus };

    case DocumentStatus.NOT_FOUND: {
      const created = rowCreatedAt !== undefined ? Date.parse(rowCreatedAt) : Number.NaN;
      const withinGrace =
        Number.isNaN(created) || now() - created < NOT_FOUND_GRACE_MS;
      if (withinGrace) {
        return { status: DocStatus.PENDING, knowledgeBaseStatus: kbStatus };
      }
      return {
        status: DocStatus.FAILED,
        knowledgeBaseStatus: kbStatus,
        failureReason:
          statusReason !== undefined && statusReason.length > 0
            ? statusReason
            : 'document was never ingested into the knowledge base',
      };
    }

    case DocumentStatus.FAILED:
    case DocumentStatus.METADATA_UPDATE_FAILED:
    case DocumentStatus.IGNORED:
      return {
        status: DocStatus.FAILED,
        knowledgeBaseStatus: kbStatus,
        ...(statusReason !== undefined && statusReason.length > 0
          ? { failureReason: statusReason }
          : {}),
      };

    case DocumentStatus.PENDING:
    case DocumentStatus.STARTING:
    case DocumentStatus.IN_PROGRESS:
    case DocumentStatus.DELETING:
    case DocumentStatus.DELETE_IN_PROGRESS:
      return { status: DocStatus.PENDING, knowledgeBaseStatus: kbStatus };

    case undefined:
      // No detail returned for this id yet → still in flight.
      return { status: DocStatus.PENDING, knowledgeBaseStatus: 'UNKNOWN' };

    default: {
      // Exhaustiveness guard: any new Bedrock status is treated as in-flight
      // rather than silently mis-reported as INDEXED.
      return { status: DocStatus.PENDING, knowledgeBaseStatus: String(kbStatus) };
    }
  }
}

/** Pull the detail for a given custom document id out of a Get response. */
export function findDetailForDocument(
  details: readonly KnowledgeBaseDocumentDetail[] | undefined,
  documentId: string,
): KnowledgeBaseDocumentDetail | undefined {
  if (details === undefined) return undefined;
  return details.find((d) => d.identifier?.custom?.id === documentId);
}
