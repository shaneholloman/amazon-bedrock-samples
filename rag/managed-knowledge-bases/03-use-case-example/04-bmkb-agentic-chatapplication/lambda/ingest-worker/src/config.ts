/**
 * Worker configuration resolved from the Lambda environment.
 *
 * Rate-limit ceilings are owned by @bmkb/common (rateLimiterConfigFromEnv) so
 * the HARD verified caps (10 files/request, 5 TPS, 10 concurrent) cannot be
 * silently raised here. This module adds the resource handles the worker needs
 * (KB id, data source id, tables) and validates them at cold start — failing
 * fast on misconfiguration rather than mid-batch.
 */

import { rateLimiterConfigFromEnv, type RateLimiterConfig } from '@bmkb/common';

export interface WorkerConfig {
  readonly knowledgeBaseId: string;
  readonly dataSourceId: string;
  readonly statusTable: string;
  readonly rateTable: string;
  /** Optional bucket owner account id for cross-account S3 reference safety. */
  readonly bucketOwnerAccountId?: string;
  readonly region: string;
  readonly rate: RateLimiterConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const bucketOwnerAccountId = optional(env, 'BUCKET_OWNER_ACCOUNT_ID');
  return {
    knowledgeBaseId: required(env, 'KB_ID'),
    dataSourceId: required(env, 'DATA_SOURCE_ID'),
    statusTable: required(env, 'STATUS_TABLE'),
    rateTable: required(env, 'RATE_TABLE'),
    ...(bucketOwnerAccountId !== undefined ? { bucketOwnerAccountId } : {}),
    region: optional(env, 'AWS_REGION') ?? 'us-west-2',
    rate: rateLimiterConfigFromEnv(env),
  };
}
