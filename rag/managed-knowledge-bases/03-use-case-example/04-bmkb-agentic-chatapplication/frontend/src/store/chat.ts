import { create } from 'zustand';
import { AUTO_MODEL_ID, type ChatCitation, type ChatTurn } from '@bmkb/common';
import { chatStream, BmkbApiError } from '../lib/api.js';

/**
 * Max prior turns the client replays for multi-turn context. Kept at (or below)
 * the server's MAX_HISTORY_TURNS so nothing we send is silently dropped; the
 * server still enforces its own bound defensively.
 */
const MAX_HISTORY_TURNS = 20;

/**
 * Distill the existing conversation into replayable history turns (oldest→
 * newest). Only fully-received turns are included: an assistant turn that is
 * still streaming, errored, or empty carries no usable context and is skipped,
 * along with the user turn that prompted it, so the replayed history stays a
 * clean alternating transcript. Trimmed to the newest MAX_HISTORY_TURNS.
 */
function toHistory(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    const content = m.content.trim();
    if (m.streaming || m.error || content.length === 0) continue;
    turns.push({ role: m.role, content });
  }
  return turns.length > MAX_HISTORY_TURNS ? turns.slice(-MAX_HISTORY_TURNS) : turns;
}

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  readonly id: string;
  readonly role: Role;
  content: string;
  citations: ChatCitation[];
  /** Assistant message still receiving streamed tokens. */
  streaming?: boolean;
  error?: string;
}

interface ChatState {
  messages: ChatMessage[];
  sessionId: string | undefined;
  sending: boolean;
  abort: AbortController | undefined;
  /** Selected generation model id (AUTO_MODEL_ID = let Bedrock choose). */
  modelId: string;
  setModel: (modelId: string) => void;
  send: (message: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

let msgSeq = 0;
function nextId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${msgSeq}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionId: undefined,
  sending: false,
  abort: undefined,
  modelId: AUTO_MODEL_ID,

  setModel: (modelId) => set({ modelId }),

  send: async (rawMessage) => {
    const message = rawMessage.trim();
    if (!message || get().sending) return;

    // Snapshot the conversation BEFORE appending the new turns — this is the
    // prior context replayed to the server for multi-turn resolution.
    const history = toHistory(get().messages);

    const userMsg: ChatMessage = {
      id: nextId('u'),
      role: 'user',
      content: message,
      citations: [],
    };
    const assistantId = nextId('a');
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      citations: [],
      streaming: true,
    };

    const abort = new AbortController();
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      sending: true,
      abort,
    }));

    const patchAssistant = (fn: (m: ChatMessage) => ChatMessage): void =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantId ? fn(m) : m)),
      }));

    const priorSession = get().sessionId;
    const modelId = get().modelId;
    try {
      await chatStream(
        {
          message,
          ...(history.length > 0 ? { history } : {}),
          ...(priorSession ? { sessionId: priorSession } : {}),
          ...(modelId && modelId !== AUTO_MODEL_ID ? { modelId } : {}),
        },
        {
          signal: abort.signal,
          onChunk: (chunk) => {
            switch (chunk.type) {
              case 'token':
                if (chunk.token) {
                  patchAssistant((m) => ({ ...m, content: m.content + chunk.token }));
                }
                break;
              case 'citation':
                if (chunk.citation) {
                  const citation = chunk.citation;
                  patchAssistant((m) => ({ ...m, citations: [...m.citations, citation] }));
                }
                break;
              case 'done':
                if (chunk.sessionId) set({ sessionId: chunk.sessionId });
                patchAssistant((m) => ({ ...m, streaming: false }));
                break;
              case 'error':
                patchAssistant((m) => ({
                  ...m,
                  streaming: false,
                  error: chunk.error ?? 'stream error',
                }));
                break;
            }
          },
        },
      );
      patchAssistant((m) => ({ ...m, streaming: false }));
    } catch (err) {
      if (abort.signal.aborted) {
        patchAssistant((m) => ({
          ...m,
          streaming: false,
          content: m.content || '(stopped)',
        }));
      } else {
        const messageText =
          err instanceof BmkbApiError
            ? `${err.apiError?.code ?? err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'request failed';
        patchAssistant((m) => ({ ...m, streaming: false, error: messageText }));
      }
    } finally {
      set({ sending: false, abort: undefined });
    }
  },

  stop: () => {
    get().abort?.abort();
  },

  reset: () => {
    get().abort?.abort();
    set({ messages: [], sessionId: undefined, sending: false, abort: undefined });
  },
}));
