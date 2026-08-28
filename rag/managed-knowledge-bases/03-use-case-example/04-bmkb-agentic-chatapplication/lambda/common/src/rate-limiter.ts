/**
 * Rate limiter — token-bucket TPS gate + account-wide concurrency gate + batch
 * cap, all config-driven via env.
 *
 * Verified ceilings (HARD, non-adjustable — F1/F2/F4):
 *   - INGEST_BATCH_MAX        = 10  files per IngestKnowledgeBaseDocuments request (MKB).
 *   - INGEST_MAX_TPS          = 5   IngestKnowledgeBaseDocuments TPS (doc-only).
 *   - INGEST_MAX_CONCURRENCY  = 10  concurrent Ingest+Delete per ACCOUNT (shared).
 *
 * IMPORTANT: the concurrency cap is per ACCOUNT, not per Lambda. Lambda reserved
 * concurrency alone is insufficient — the real guard must use a SHARED store
 * (e.g. DynamoDB atomic counter). This module provides:
 *   1. A pure in-process TokenBucket (TPS shaping inside one worker invocation).
 *   2. The ConcurrencyGate INTERFACE that the ingest-worker implements against
 *      DynamoDB so the cap is enforced account-wide.
 * Both batch size and TPS are config-driven so we retune after the M3 benchmark.
 */

export const DEFAULT_INGEST_BATCH_MAX = 10; // F1 (MKB L-30E8CCBD)
export const DEFAULT_INGEST_MAX_TPS = 5; // F2 (doc-only)
export const DEFAULT_INGEST_MAX_CONCURRENCY = 10; // F4 (shared, per account)

export interface RateLimiterConfig {
  /** Max files per IngestKnowledgeBaseDocuments request. */
  readonly batchMax: number;
  /** Max IngestKnowledgeBaseDocuments transactions per second. */
  readonly maxTps: number;
  /** Max concurrent in-flight Ingest+Delete requests, account-wide. */
  readonly maxConcurrency: number;
}

export function rateLimiterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RateLimiterConfig {
  return {
    batchMax: clampPositive(env['INGEST_BATCH_MAX'], DEFAULT_INGEST_BATCH_MAX, DEFAULT_INGEST_BATCH_MAX),
    maxTps: clampPositive(env['INGEST_MAX_TPS'], DEFAULT_INGEST_MAX_TPS, DEFAULT_INGEST_MAX_TPS),
    maxConcurrency: clampPositive(
      env['INGEST_MAX_CONCURRENCY'],
      DEFAULT_INGEST_MAX_CONCURRENCY,
      DEFAULT_INGEST_MAX_CONCURRENCY,
    ),
  };
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly code: 'BATCH_TOO_LARGE' | 'RATE_LIMITED',
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Split a list of items into batches no larger than batchMax (default 10).
 * Never emits a batch above the cap; throws if batchMax exceeds the verified
 * hard ceiling to prevent accidental over-batching via misconfiguration.
 */
export function chunkIntoBatches<T>(
  items: readonly T[],
  batchMax: number = DEFAULT_INGEST_BATCH_MAX,
): T[][] {
  if (!Number.isInteger(batchMax) || batchMax < 1) {
    throw new RateLimitError(`invalid batchMax: ${batchMax}`, 'BATCH_TOO_LARGE');
  }
  if (batchMax > DEFAULT_INGEST_BATCH_MAX) {
    throw new RateLimitError(
      `batchMax ${batchMax} exceeds the verified MKB cap of ${DEFAULT_INGEST_BATCH_MAX} files/request`,
      'BATCH_TOO_LARGE',
    );
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchMax) {
    out.push(items.slice(i, i + batchMax));
  }
  return out;
}

/** Assert a single batch is within the cap. */
export function assertBatchWithinCap(
  size: number,
  batchMax: number = DEFAULT_INGEST_BATCH_MAX,
): void {
  if (size > batchMax) {
    throw new RateLimitError(
      `batch of ${size} exceeds the ${batchMax}-file cap`,
      'BATCH_TOO_LARGE',
    );
  }
}

/**
 * In-process token bucket for TPS shaping. Refills at `maxTps` tokens/sec up to
 * a burst capacity (defaults to maxTps). `tryRemove` is non-blocking;
 * `waitForToken` resolves once a token is available. Time is injectable for
 * deterministic tests.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly maxTps: number = DEFAULT_INGEST_MAX_TPS,
    private readonly capacity: number = maxTps,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (maxTps <= 0) throw new RateLimitError(`maxTps must be > 0`, 'RATE_LIMITED');
    this.tokens = capacity;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.maxTps);
    this.lastRefillMs = nowMs;
  }

  /** Available tokens right now (after refill). Mainly for tests/metrics. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Try to consume one token without waiting. Returns true if consumed. */
  tryRemove(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Milliseconds until `count` tokens would be available. */
  msUntilAvailable(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.maxTps) * 1000);
  }

  /**
   * Wait until a token is available, then consume it. Uses the injected sleep
   * (defaults to setTimeout) so tests can run without real time.
   */
  async waitForToken(
    count = 1,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ): Promise<void> {
    // Bounded loop guards against clock skew / fractional refills.
    for (let i = 0; i < 1000; i += 1) {
      if (this.tryRemove(count)) return;
      await sleep(Math.max(1, this.msUntilAvailable(count)));
    }
    throw new RateLimitError('token bucket wait exceeded retry bound', 'RATE_LIMITED');
  }
}

/**
 * Account-wide concurrency gate. The ingest-worker implements this against a
 * DynamoDB atomic counter so the F4 cap (10 concurrent) holds across all
 * concurrent Lambda invocations in the account — NOT just one process.
 */
export interface ConcurrencyGate {
  /** Atomically acquire a slot; false if the account is at maxConcurrency. */
  tryAcquire(): Promise<boolean>;
  /** Release a previously acquired slot. */
  release(): Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPositive(raw: string | undefined, fallback: number, hardMax: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, hardMax);
}
