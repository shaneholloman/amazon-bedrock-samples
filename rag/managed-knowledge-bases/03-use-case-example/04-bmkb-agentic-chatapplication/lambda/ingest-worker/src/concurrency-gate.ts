/**
 * Account-wide concurrency gate backed by a single DynamoDB counter item.
 *
 * F4: Concurrent Ingest+Delete is 10 per ACCOUNT (shared, non-adjustable).
 * Lambda reserved concurrency alone cannot enforce this because the cap is
 * shared with the delete path and any other ingestion caller in the account.
 * We use an atomic conditional ADD on a single item so the cap holds across
 * every concurrent invocation in the account.
 *
 * Item shape (table = RATE_TABLE):
 *   { pk: "concurrency#ingest", inflight: <number>, lastChangeMs: <epoch ms> }
 *
 * tryAcquire: conditional `ADD inflight :one` allowed only while
 *   `inflight < :max` (or the attribute is absent). Returns false when full.
 * release:    conditional `ADD inflight :negOne` guarded by `inflight > 0`
 *   so a double-release cannot drive the counter negative.
 *
 * Leases are short-lived (held only around a single Bedrock call) and released
 * in a finally block — but a Lambda hard timeout/OOM skips `finally`, leaking
 * the slot. Every acquire/release stamps lastChangeMs; when the counter sits
 * at/above max with no activity past a stale window, tryAcquire self-heals by
 * atomically resetting it (see tryReclaimStale) so leaked slots cannot
 * deadlock ingestion account-wide.
 */

import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ConcurrencyGate } from '@bmkb/common';

import { describeError, logger } from './logger.js';

const CONCURRENCY_PK = 'concurrency#ingest';

/**
 * If the counter has been pinned at/above max with NO acquire/release activity
 * for this long, the held slots are leaked (a worker died mid-lease — Lambda
 * hard timeout/OOM skips `finally`). Slots are held only around one Bedrock
 * call (seconds), and the worker's own timeout is 5 minutes, so 6 minutes of
 * total silence at the cap is unambiguous leakage.
 */
const STALE_COUNTER_MS = 6 * 60 * 1000;

export interface DynamoConcurrencyGateOptions {
  readonly doc: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly maxConcurrency: number;
  /** Partition key attribute name on the rate table. Defaults to "pk". */
  readonly partitionKey?: string;
}

export class DynamoConcurrencyGate implements ConcurrencyGate {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly maxConcurrency: number;
  private readonly pkName: string;

  constructor(opts: DynamoConcurrencyGateOptions) {
    if (!Number.isInteger(opts.maxConcurrency) || opts.maxConcurrency < 1) {
      throw new Error(`invalid maxConcurrency: ${opts.maxConcurrency}`);
    }
    this.doc = opts.doc;
    this.tableName = opts.tableName;
    this.maxConcurrency = opts.maxConcurrency;
    this.pkName = opts.partitionKey ?? 'pk';
  }

  async tryAcquire(): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [this.pkName]: CONCURRENCY_PK },
          UpdateExpression: 'ADD inflight :one SET lastChangeMs = :now',
          // Acquire only while there is headroom. attribute_not_exists covers
          // the first-ever acquire (item not yet created).
          ConditionExpression:
            'attribute_not_exists(inflight) OR inflight < :max',
          ExpressionAttributeValues: {
            ':one': 1,
            ':max': this.maxConcurrency,
            ':now': Date.now(),
          },
        }),
      );
      return true;
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) {
        // At the cap. If the counter is provably stale (leaked slots from a
        // crashed worker), self-heal and take the first slot; otherwise back off.
        return this.tryReclaimStale();
      }
      // Unexpected error: treat as "could not acquire" and surface it.
      logger.error('concurrency gate acquire failed', {
        table: this.tableName,
        error: describeError(err),
      });
      throw err;
    }
  }

  /**
   * Self-heal leaked slots: a Lambda hard timeout / OOM terminates the process
   * without running `finally`, so `release()` never fires and the counter can
   * pin at max forever, deadlocking ingestion account-wide. When the counter is
   * at/above max AND untouched for STALE_COUNTER_MS, atomically reset it to 1
   * (this caller takes the first slot). The reset is conditioned on the exact
   * lastChangeMs we read, so concurrent healers cannot double-reset.
   */
  private async tryReclaimStale(): Promise<boolean> {
    try {
      const res = await this.doc.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { [this.pkName]: CONCURRENCY_PK },
        }),
      );
      const item = res.Item as { inflight?: number; lastChangeMs?: number } | undefined;
      if (item === undefined) return false;
      const lastChange = typeof item.lastChangeMs === 'number' ? item.lastChangeMs : 0;
      if (Date.now() - lastChange < STALE_COUNTER_MS) return false;

      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [this.pkName]: CONCURRENCY_PK },
          UpdateExpression: 'SET inflight = :one, lastChangeMs = :now',
          ConditionExpression: 'lastChangeMs = :seen OR attribute_not_exists(lastChangeMs)',
          ExpressionAttributeValues: {
            ':one': 1,
            ':now': Date.now(),
            ':seen': lastChange,
          },
        }),
      );
      logger.warn('concurrency gate self-healed a stale counter (leaked slots reclaimed)', {
        table: this.tableName,
        staleInflight: item.inflight,
        staleSinceMs: Date.now() - lastChange,
      });
      return true;
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) return false; // another healer won
      logger.error('concurrency gate stale-reclaim failed', {
        table: this.tableName,
        error: describeError(err),
      });
      return false;
    }
  }

  async release(): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [this.pkName]: CONCURRENCY_PK },
          UpdateExpression: 'ADD inflight :negOne SET lastChangeMs = :now',
          // Never drive the counter below zero (double-release safety).
          ConditionExpression: 'inflight > :zero',
          ExpressionAttributeValues: {
            ':negOne': -1,
            ':zero': 0,
            ':now': Date.now(),
          },
        }),
      );
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) {
        // Already at zero — nothing to release. Not an error worth failing on.
        logger.warn('concurrency gate release skipped (counter already at 0)', {
          table: this.tableName,
        });
        return;
      }
      // A failed release leaks a slot; log loudly but do not crash the worker.
      logger.error('concurrency gate release failed', {
        table: this.tableName,
        error: describeError(err),
      });
    }
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'ConditionalCheckFailedException' ||
      err.name === 'TransactionCanceledException')
  );
}

/**
 * Account-wide TPS gate backed by a per-second DynamoDB counter.
 *
 * F2: IngestKnowledgeBaseDocuments is capped at 5 TPS per ACCOUNT. An
 * in-process token bucket only shapes ONE invocation; with up to 10 concurrent
 * workers the aggregate would breach the cap. Each Bedrock call first takes a
 * token from the current wall-clock second's item:
 *   { pk: "tps#ingest#<epochSecond>", count, expiresAt }
 * via a conditional ADD (count < maxTps). When the second is exhausted the
 * caller sleeps to the next second boundary and retries. Items carry a
 * one-hour TTL (expiresAt) so the table does not accumulate.
 */
export class DynamoTpsGate {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly maxTps: number;
  private readonly pkName: string;

  constructor(opts: DynamoConcurrencyGateOptions & { readonly maxTps: number }) {
    if (!Number.isInteger(opts.maxTps) || opts.maxTps < 1) {
      throw new Error(`invalid maxTps: ${opts.maxTps}`);
    }
    this.doc = opts.doc;
    this.tableName = opts.tableName;
    this.maxTps = opts.maxTps;
    this.pkName = opts.partitionKey ?? 'pk';
  }

  /** Block until a token for the current (or a future) second is acquired. */
  async waitForToken(maxWaitMs = 60_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const nowMs = Date.now();
      const second = Math.floor(nowMs / 1000);
      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { [this.pkName]: `tps#ingest#${second}` },
            UpdateExpression: 'ADD #count :one SET expiresAt = :ttl',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
            ExpressionAttributeNames: { '#count': 'count' },
            ExpressionAttributeValues: {
              ':one': 1,
              ':max': this.maxTps,
              ':ttl': second + 3600,
            },
          }),
        );
        return;
      } catch (err: unknown) {
        if (!isConditionalCheckFailed(err)) {
          // Fail open on infrastructure errors: the per-invocation pacing and
          // Bedrock's own throttling responses (retried via SQS) still bound
          // the rate; refusing to ingest would be worse.
          logger.warn('TPS gate errored — proceeding without shared token', {
            table: this.tableName,
            error: describeError(err),
          });
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error('TPS gate wait exceeded bound');
        }
        // This second is exhausted; sleep to the next boundary (+ jitter).
        const nextSecondMs = (second + 1) * 1000 - Date.now();
        await new Promise((r) =>
          setTimeout(r, Math.max(5, nextSecondMs) + Math.floor(Math.random() * 50)),
        );
      }
    }
  }
}
