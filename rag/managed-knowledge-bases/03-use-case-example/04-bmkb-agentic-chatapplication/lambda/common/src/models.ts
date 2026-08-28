/**
 * Chat generation-model catalog — the SINGLE source of truth shared by the
 * frontend picker and the chat lambda.
 *
 * The chat path uses Bedrock's Agentic Retrieval API. Its
 * `agenticRetrieveConfiguration.foundationModelType` is either:
 *   - MANAGED — Bedrock picks the generation model (our "Auto" option), or
 *   - CUSTOM  — a caller-specified model via `foundationModelConfiguration`.
 *
 * Every entry below was verified LIVE against a managed-embedding KB through
 * AgenticRetrieveStream (each produced a grounded, cited answer). Two ARN forms
 * are used, per what the service actually accepts:
 *   - inference-profile (account-scoped) for Anthropic + Amazon cross-region
 *     `us.` system profiles, and
 *   - foundation-model (account-less) for on-demand open-weight models.
 * A foundation-model ARN for the Anthropic/Amazon `us.` profiles is REJECTED,
 * and vice-versa — so the form is pinned per entry, not guessed.
 *
 * SECURITY: this is an ALLOW-LIST. The chat lambda resolves a client-supplied
 * model id THROUGH this catalog and never interpolates a raw client string into
 * an ARN. An id not present here falls back to Auto (MANAGED), never an
 * arbitrary model.
 */

/** Sentinel id for the default "let Bedrock choose" (MANAGED) behavior. */
export const AUTO_MODEL_ID = 'auto';

/** How a catalog entry's ARN is built (differs by model provider). */
export type ModelArnKind = 'inference-profile' | 'foundation-model';

export interface ChatModelOption {
  /** Stable id the client sends in ChatRequest.modelId. */
  readonly id: string;
  /** Human-facing label for the picker. */
  readonly label: string;
  /** Provider/family group, for optional UI grouping. */
  readonly family: string;
  /**
   * ARN form the service accepts for this model:
   *  - 'inference-profile' → account-scoped `us.` system profile
   *  - 'foundation-model'  → account-less on-demand model
   */
  readonly kind: ModelArnKind;
  /** The identifier after the ARN prefix (profile id or model id). */
  readonly bedrockId: string;
}

/**
 * Curated selectable models. Scoped to models launched in 2026 (Anthropic),
 * Amazon Nova 2 Lite, and the newest open-weight models on Bedrock that were
 * verified to actually generate an answer via AgenticRetrieveStream. Ordered
 * best-general-default first within each family.
 */
export const CHAT_MODELS: readonly ChatModelOption[] = [
  // --- Anthropic (2026), via us. cross-region inference profiles ----------
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    family: 'Anthropic',
    kind: 'inference-profile',
    bedrockId: 'us.anthropic.claude-sonnet-5',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    family: 'Anthropic',
    kind: 'inference-profile',
    bedrockId: 'us.anthropic.claude-opus-4-8',
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    family: 'Anthropic',
    kind: 'inference-profile',
    bedrockId: 'us.anthropic.claude-fable-5',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    family: 'Anthropic',
    kind: 'inference-profile',
    bedrockId: 'us.anthropic.claude-opus-4-7',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    family: 'Anthropic',
    kind: 'inference-profile',
    bedrockId: 'us.anthropic.claude-sonnet-4-6',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    family: 'Anthropic',
    kind: 'inference-profile',
    bedrockId: 'us.anthropic.claude-opus-4-6-v1',
  },
  // --- Amazon Nova 2 (via us. inference profile) --------------------------
  {
    id: 'nova-2-lite',
    label: 'Amazon Nova 2 Lite',
    family: 'Amazon',
    kind: 'inference-profile',
    bedrockId: 'us.amazon.nova-2-lite-v1:0',
  },
  // --- Newest open-weight models (on-demand foundation models) ------------
  {
    id: 'qwen3-235b',
    label: 'Qwen3 235B (2507)',
    family: 'Open weight',
    kind: 'foundation-model',
    bedrockId: 'qwen.qwen3-235b-a22b-2507-v1:0',
  },
  {
    id: 'deepseek-v3-2',
    label: 'DeepSeek V3.2',
    family: 'Open weight',
    kind: 'foundation-model',
    bedrockId: 'deepseek.v3.2',
  },
  {
    id: 'mistral-large-3',
    label: 'Mistral Large 3',
    family: 'Open weight',
    kind: 'foundation-model',
    bedrockId: 'mistral.mistral-large-3-675b-instruct',
  },
  {
    id: 'gpt-oss-20b',
    label: 'OpenAI gpt-oss 20B',
    family: 'Open weight',
    kind: 'foundation-model',
    bedrockId: 'openai.gpt-oss-20b-1:0',
  },
];

/** Look up a catalog entry by client-supplied id (undefined if not found). */
export function getChatModel(id: string | undefined): ChatModelOption | undefined {
  if (id === undefined) return undefined;
  return CHAT_MODELS.find((m) => m.id === id);
}

/** True when the id selects Auto (MANAGED): unset, blank, or the sentinel. */
export function isAutoModel(id: string | undefined): boolean {
  return id === undefined || id.trim().length === 0 || id === AUTO_MODEL_ID;
}

/**
 * Resolve a client-supplied model id into a Bedrock model ARN, or undefined for
 * Auto/unknown ids (caller then uses foundationModelType=MANAGED). ARNs are
 * built ONLY from catalog entries — a raw client string is never interpolated.
 *
 * @param region  the Bedrock region (e.g. us-west-2)
 * @param account the AWS account id (required for inference-profile ARNs)
 * @param id      the ChatRequest.modelId value
 */
export function resolveModelArn(
  region: string,
  account: string,
  id: string | undefined,
): string | undefined {
  if (isAutoModel(id)) return undefined;
  const model = getChatModel(id);
  if (model === undefined) return undefined;
  if (model.kind === 'inference-profile') {
    // Inference-profile ARNs are account-scoped.
    if (account.length === 0) return undefined;
    return `arn:aws:bedrock:${region}:${account}:inference-profile/${model.bedrockId}`;
  }
  // Foundation-model ARNs are account-less.
  return `arn:aws:bedrock:${region}::foundation-model/${model.bedrockId}`;
}
