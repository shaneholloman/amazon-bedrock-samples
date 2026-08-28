/**
 * MKB chat via the Agentic Retrieval API (AgenticRetrieveStream).
 *
 * The Agentic Retriever decomposes a query into sub-queries and iteratively
 * retrieves across the knowledge base, then (generateResponse=true) synthesizes
 * a cited answer — one call, no separate generation step. It is the flagship
 * Managed-KB retrieval path.
 *
 * SECURITY: PER-USER isolation is the EXPLICIT `equals` filter from @bmkb/common
 * scoping on the caller's Cognito `sub` (user_id), passed in
 * retrievers[].configuration.knowledgeBase.retrievalOverrides.filter, and
 * re-asserted via assertFilterScopedToUser before the call. As a second layer,
 * any retrieved item whose user_id metadata is not exactly the caller's user id
 * is DROPPED (never surfaced) — verified live, but defense-in-depth.
 */

import {
  BedrockAgentRuntimeClient,
  AgenticRetrieveStreamCommand,
  type RetrievalFilter as BedrockRetrievalFilter,
  type AgenticRetrieveMessage,
  type AgenticRetrieveStreamRequest,
  type AgenticRetrieveResultItem,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
  assertFilterScopedToUser,
  assertValidUserId,
  buildUserFilter,
  resolveModelArn,
  USER_METADATA_KEY,
  type ChatCitation,
  type ChatTurn,
  type TenantContext,
} from '@bmkb/common';
import type { AgenticRetrieveConfiguration } from '@aws-sdk/client-bedrock-agent-runtime';
import type { ChatConfig } from './config.js';
import type { Logger } from './logger.js';

/** Result of a non-streaming chat turn. */
export interface RagResult {
  readonly sessionId: string;
  readonly answer: string;
  readonly citations: readonly ChatCitation[];
}

/** A normalized event emitted while streaming a chat answer. */
export type RagStreamEvent =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'citation'; readonly citation: ChatCitation }
  | { readonly kind: 'sessionId'; readonly sessionId: string };

/**
 * Build the Agentic Retrieval `messages[]` conversation: prior turns
 * (oldest→newest) followed by the current user message as the final turn. This
 * is the ONLY channel for multi-turn context — the API is stateless (no
 * sessionId) — so "what did he say?" / "what was my first question?" only work
 * because the history is replayed here.
 *
 * Consecutive same-role turns are coalesced: some model backends behind agentic
 * retrieval reject a messages array that doesn't strictly alternate roles, and
 * a client that already stored the current question in history could otherwise
 * produce two trailing user turns. The current message is always appended as
 * the last user turn (merged into a trailing user turn if one exists).
 */
function buildMessages(
  history: readonly ChatTurn[],
  current: string,
): AgenticRetrieveMessage[] {
  const turns: ChatTurn[] = [...history, { role: 'user', content: current }];
  const messages: AgenticRetrieveMessage[] = [];
  for (const turn of turns) {
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === role) {
      // Coalesce a consecutive same-role turn to preserve strict alternation.
      last.content = { text: `${last.content?.text ?? ''}\n\n${turn.content}` };
      continue;
    }
    messages.push({ role, content: { text: turn.content } });
  }
  return messages;
}

/** Map an agentic result item to a ChatCitation (matches @bmkb/common shape). */
function toCitation(item: AgenticRetrieveResultItem): ChatCitation {
  const text = item.content?.text ?? '';
  const meta = item.metadata ?? {};
  // Custom connector documents: _document_id is the system metadata field.
  const documentId =
    typeof meta['_document_id'] === 'string'
      ? (meta['_document_id'] as string)
      : undefined;
  const s3Uri =
    typeof meta['x-amz-bedrock-kb-source-uri'] === 'string'
      ? (meta['x-amz-bedrock-kb-source-uri'] as string)
      : undefined;
  const reference: { documentId?: string; s3Uri?: string; snippet?: string } = {
    ...(documentId !== undefined ? { documentId } : {}),
    ...(s3Uri !== undefined ? { s3Uri } : {}),
    snippet: text.slice(0, 300),
  };
  return { text: text.slice(0, 300), references: [reference] };
}

export class RagClient {
  private readonly runtime: BedrockAgentRuntimeClient;

  constructor(
    private readonly config: ChatConfig,
    private readonly logger: Logger,
    runtime?: BedrockAgentRuntimeClient,
  ) {
    this.runtime = runtime ?? new BedrockAgentRuntimeClient({ region: config.region });
  }

  /**
   * Resolve the agentic generation-model config from a client-supplied modelId.
   *
   * Auto (undefined / sentinel / unknown id) → foundationModelType=MANAGED:
   * Bedrock picks the optimal generation model. A chosen catalog model →
   * foundationModelType=CUSTOM with the resolved ARN. The id is resolved ONLY
   * through the @bmkb/common CHAT_MODELS allow-list (resolveModelArn) — a raw
   * client string is never interpolated into an ARN, so an unknown/forged id
   * safely degrades to Auto rather than reaching an arbitrary model.
   */
  private modelConfig(modelId: string | undefined): AgenticRetrieveConfiguration {
    const base: AgenticRetrieveConfiguration = {
      rerankingModelType: 'MANAGED',
      ...(this.config.maxAgentIterations !== undefined
        ? { maxAgentIteration: this.config.maxAgentIterations }
        : {}),
    };
    const modelArn = resolveModelArn(this.config.region, this.config.accountId, modelId);
    if (modelArn === undefined) {
      // Auto: let Bedrock pick the model + reranker for agentic retrieval.
      return { ...base, foundationModelType: 'MANAGED' };
    }
    return {
      ...base,
      foundationModelType: 'CUSTOM',
      foundationModelConfiguration: {
        type: 'BEDROCK_FOUNDATION_MODEL',
        bedrockFoundationModelConfiguration: {
          modelConfiguration: { modelArn },
        },
      },
    };
  }

  /**
   * Build the user-scoped AgenticRetrieveStream request. THE security boundary:
   * the explicit `equals` user filter (user_id = Cognito sub) is built +
   * re-asserted and passed via retrievalOverrides.filter; there is no path
   * without it.
   */
  private buildRequest(
    ctx: TenantContext,
    message: string,
    history: readonly ChatTurn[],
    modelId: string | undefined,
  ): AgenticRetrieveStreamRequest {
    assertValidUserId(ctx.userId);
    const userFilter = buildUserFilter(ctx);
    assertFilterScopedToUser(userFilter, ctx.userId);
    const filter: BedrockRetrievalFilter = {
      equals: { key: userFilter.equals.key, value: userFilter.equals.value },
    };

    return {
      messages: buildMessages(history, message),
      retrievers: [
        {
          description: "The caller's user-scoped documents",
          configuration: {
            knowledgeBase: {
              knowledgeBaseId: this.config.knowledgeBaseId,
              retrievalOverrides: {
                filter,
                maxNumberOfResults: this.config.numberOfResults,
              },
            },
          },
        },
      ],
      agenticRetrieveConfiguration: this.modelConfig(modelId),
      generateResponse: true,
    };
  }

  /**
   * Defense-in-depth, FAIL-CLOSED: surface an item only when its user_id
   * metadata strictly equals the caller's user id. Items with a missing or
   * non-string user_id are dropped too — every document this system ingests is
   * tagged with user_id, so an untagged item is by definition not provably the
   * caller's and must never be shown.
   */
  private safeItems(
    ctx: TenantContext,
    items: readonly AgenticRetrieveResultItem[],
  ): AgenticRetrieveResultItem[] {
    const safe: AgenticRetrieveResultItem[] = [];
    let dropped = 0;
    for (const item of items) {
      const uid = (item.metadata ?? {})[USER_METADATA_KEY];
      if (uid !== ctx.userId) {
        dropped += 1;
        continue;
      }
      safe.push(item);
    }
    if (dropped > 0) {
      this.logger.warn('chat.dropped_foreign_user', {
        userId: ctx.userId,
        dropped,
        kept: safe.length,
      });
    }
    return safe;
  }

  /** Non-streaming chat: drain the agentic stream into a full answer + citations. */
  async retrieveAndGenerate(
    ctx: TenantContext,
    message: string,
    history: readonly ChatTurn[],
    sessionId: string | undefined,
    modelId?: string,
  ): Promise<RagResult> {
    this.logger.info('chat.agentic.start', {
      tenantId: ctx.tenantId,
      knowledgeBaseId: this.config.knowledgeBaseId,
      streaming: false,
      modelId: modelId ?? 'auto',
      historyTurns: history.length,
    });
    const out = await this.runtime.send(
      new AgenticRetrieveStreamCommand(this.buildRequest(ctx, message, history, modelId)),
    );

    let answer = '';
    const items: AgenticRetrieveResultItem[] = [];
    for await (const ev of out.stream ?? []) {
      this.throwIfError(ev);
      if (ev.responseEvent?.text) answer += ev.responseEvent.text;
      if (ev.result?.results) items.push(...ev.result.results);
    }
    const citations = this.safeItems(ctx, items).map(toCitation);

    this.logger.info('chat.agentic.done', {
      tenantId: ctx.tenantId,
      streaming: false,
      answerLength: answer.length,
      citationCount: citations.length,
    });
    return { sessionId: sessionId?.trim() ?? '', answer, citations };
  }

  /** Streaming chat: emit answer tokens + citations as the agentic stream arrives. */
  async *retrieveAndGenerateStream(
    ctx: TenantContext,
    message: string,
    history: readonly ChatTurn[],
    sessionId: string | undefined,
    modelId?: string,
  ): AsyncGenerator<RagStreamEvent, void, void> {
    this.logger.info('chat.agentic.start', {
      tenantId: ctx.tenantId,
      knowledgeBaseId: this.config.knowledgeBaseId,
      streaming: true,
      modelId: modelId ?? 'auto',
      historyTurns: history.length,
    });
    if (sessionId !== undefined && sessionId.trim().length > 0) {
      yield { kind: 'sessionId', sessionId: sessionId.trim() };
    }

    const out = await this.runtime.send(
      new AgenticRetrieveStreamCommand(this.buildRequest(ctx, message, history, modelId)),
    );

    let tokenCount = 0;
    let citationCount = 0;
    for await (const ev of out.stream ?? []) {
      this.throwIfError(ev);
      if (ev.responseEvent?.text) {
        tokenCount += 1;
        yield { kind: 'token', token: ev.responseEvent.text };
      }
      if (ev.result?.results) {
        for (const item of this.safeItems(ctx, ev.result.results)) {
          citationCount += 1;
          yield { kind: 'citation', citation: toCitation(item) };
        }
      }
    }
    this.logger.info('chat.agentic.done', {
      tenantId: ctx.tenantId,
      streaming: true,
      tokenChunks: tokenCount,
      citationCount,
    });
  }

  /** Rethrow any modeled exception member surfaced in a stream event. */
  private throwIfError(ev: {
    accessDeniedException?: unknown;
    validationException?: unknown;
    resourceNotFoundException?: unknown;
    throttlingException?: unknown;
    serviceQuotaExceededException?: unknown;
    internalServerException?: unknown;
    conflictException?: unknown;
    dependencyFailedException?: unknown;
    badGatewayException?: unknown;
  }): void {
    const err =
      ev.accessDeniedException ??
      ev.validationException ??
      ev.resourceNotFoundException ??
      ev.throttlingException ??
      ev.serviceQuotaExceededException ??
      ev.internalServerException ??
      ev.conflictException ??
      ev.dependencyFailedException ??
      ev.badGatewayException;
    if (err !== undefined) {
      throw err;
    }
  }
}
