/**
 * Environment-driven configuration for the chat lambda.
 *
 * All values are resolved once at module load and validated. Missing required
 * config fails fast (the handler turns this into an INTERNAL error) rather than
 * silently producing an unscoped or misconfigured Bedrock call.
 *
 * No secrets live here — only resource identifiers and ARNs, which are not
 * sensitive and are supplied by CDK outputs / the deployment environment.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ChatConfig {
  /** Bedrock Knowledge Base id queried by AgenticRetrieveStream. */
  readonly knowledgeBaseId: string;
  /** AWS region for the Bedrock Agent Runtime client. */
  readonly region: string;
  /**
   * AWS account id, used to build account-scoped inference-profile ARNs when a
   * user selects a specific generation model. Empty string when unset — the
   * model resolver then declines inference-profile models (falls back to Auto).
   */
  readonly accountId: string;
  /** Number of source chunks to retrieve per query (max 10 on managed KB). */
  readonly numberOfResults: number;
  /** Optional cap on agentic retrieval sub-query iterations. */
  readonly maxAgentIterations?: number;
  /**
   * Header the API authorizer/integration uses to carry the tenant id when no
   * structured authorizer context is present. Defaults to `x-tenant-id`.
   */
  readonly tenantHeaderName: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`required environment variable ${name} is missing or empty`);
  }
  return value.trim();
}

function optionalInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(
      `environment variable ${name} must be an integer in [${min}, ${max}], got "${raw}"`,
    );
  }
  return parsed;
}

let cached: ChatConfig | undefined;

/**
 * Load + validate config (cached). Throws ConfigError on the first missing /
 * invalid required value.
 */
export function loadConfig(): ChatConfig {
  if (cached !== undefined) {
    return cached;
  }
  const region =
    process.env['AWS_REGION']?.trim() ||
    process.env['CDK_DEFAULT_REGION']?.trim() ||
    '';
  if (region.length === 0) {
    throw new ConfigError('AWS_REGION (or CDK_DEFAULT_REGION) must be set');
  }

  const tenantHeaderName =
    process.env['VITE_TENANT_HEADER']?.trim().toLowerCase() ||
    process.env['TENANT_HEADER']?.trim().toLowerCase() ||
    'x-tenant-id';

  const maxAgentRaw = process.env['CHAT_MAX_AGENT_ITERATIONS'];
  cached = {
    knowledgeBaseId: required('KB_ID'),
    region,
    accountId: process.env['BEDROCK_ACCOUNT_ID']?.trim() ?? '',
    // Agentic retrieval caps maxNumberOfResults at 10 per retriever sub-query.
    numberOfResults: optionalInt('CHAT_NUMBER_OF_RESULTS', 10, 1, 10),
    tenantHeaderName,
    ...(maxAgentRaw !== undefined && maxAgentRaw.trim().length > 0
      ? { maxAgentIterations: optionalInt('CHAT_MAX_AGENT_ITERATIONS', 5, 1, 20) }
      : {}),
  };
  return cached;
}

/** Test seam: reset the cached config so a test can re-load with new env. */
export function resetConfigCache(): void {
  cached = undefined;
}
