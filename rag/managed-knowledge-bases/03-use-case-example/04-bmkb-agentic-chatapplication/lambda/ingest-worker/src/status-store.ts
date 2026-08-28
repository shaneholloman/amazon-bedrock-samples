/**
 * DynamoDB status store for the document lifecycle.
 *
 * The upload edge writes the PENDING row (keyed by documentId, carrying the
 * tenant). The worker transitions that row to INDEXED or FAILED based on the
 * IngestKnowledgeBaseDocuments outcome. Updates are:
 *
 *  - Idempotent: keyed solely by documentId; a replay of the same job updates
 *    the same row in place (the documentId is deterministic — see
 *    @bmkb/common buildDocumentId).
 *  - Tenant-safe: the worker NEVER trusts a status row to widen a tenant; it
 *    only writes the status/reason/timestamp and asserts the persisted
 *    tenant_id matches the job's tenant (defense in depth).
 *
 * Row shape mirrors DocStatusRecord (see @bmkb/common):
 *   { documentId, tenantId, filename, status, ingestPath, sizeBytes,
 *     failureReason?, createdAt, updatedAt }
 */

import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DocStatus, type DocumentId, type TenantId } from '@bmkb/common';

import { logger } from './logger.js';

export interface StatusStoreOptions {
  readonly doc: DynamoDBDocumentClient;
  readonly tableName: string;
  /** Partition key attribute name. Defaults to "documentId". */
  readonly partitionKey?: string;
}

export interface StatusUpdate {
  readonly documentId: DocumentId;
  readonly tenantId: TenantId;
  readonly status: DocStatus.INDEXED | DocStatus.FAILED;
  readonly failureReason?: string;
  /** Raw KB status string for observability (e.g. "PARTIALLY_INDEXED"). */
  readonly knowledgeBaseStatus?: string;
}

export class StatusStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly pkName: string;

  constructor(opts: StatusStoreOptions) {
    this.doc = opts.doc;
    this.tableName = opts.tableName;
    this.pkName = opts.partitionKey ?? 'documentId';
  }

  /**
   * Transition a document's status. Guarded by a tenant-match condition so a
   * worker can never overwrite a row that does not belong to the job's tenant
   * (defense in depth against a poisoned/forged queue message). The row must
   * already exist (created PENDING by the upload edge).
   */
  async update(update: StatusUpdate): Promise<void> {
    const now = new Date().toISOString();
    const names: Record<string, string> = {
      '#status': 'status',
      '#tenantId': 'tenantId',
      '#updatedAt': 'updatedAt',
    };
    const values: Record<string, unknown> = {
      ':status': update.status,
      ':tenantId': update.tenantId,
      ':updatedAt': now,
    };
    const sets = ['#status = :status', '#updatedAt = :updatedAt'];

    if (update.failureReason !== undefined) {
      names['#failureReason'] = 'failureReason';
      values[':failureReason'] = truncateReason(update.failureReason);
      sets.push('#failureReason = :failureReason');
    } else {
      // Clear any stale failure reason on a successful transition.
      names['#failureReason'] = 'failureReason';
      sets.push('#failureReason = :nullReason');
      values[':nullReason'] = null;
    }

    if (update.knowledgeBaseStatus !== undefined) {
      names['#kbStatus'] = 'knowledgeBaseStatus';
      values[':kbStatus'] = update.knowledgeBaseStatus;
      sets.push('#kbStatus = :kbStatus');
    }

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [this.pkName]: update.documentId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          // Row must exist AND belong to this tenant.
          ConditionExpression:
            'attribute_exists(#tenantId) AND #tenantId = :tenantId',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      logger.info('status updated', {
        documentId: update.documentId,
        tenantId: update.tenantId,
        status: update.status,
        knowledgeBaseStatus: update.knowledgeBaseStatus,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        // Either the row is missing (lost upload write) or the tenant does not
        // match (forged/poisoned message). Both are anomalies worth surfacing.
        logger.error('status update rejected (missing row or tenant mismatch)', {
          documentId: update.documentId,
          tenantId: update.tenantId,
          status: update.status,
        });
      }
      throw err;
    }
  }
}

/** Keep failure reasons bounded so a giant message can't bloat the row. */
function truncateReason(reason: string): string {
  const MAX = 1024;
  return reason.length > MAX ? `${reason.slice(0, MAX)}…` : reason;
}
