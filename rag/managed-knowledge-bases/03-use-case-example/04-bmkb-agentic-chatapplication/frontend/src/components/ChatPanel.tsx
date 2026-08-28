import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { AUTO_MODEL_ID, CHAT_MODELS } from '@bmkb/common';
import { useChatStore, type ChatMessage } from '../store/chat.js';
import { Citations } from './Citations.js';
import { AlertIcon, SendIcon, SparkIcon, SpinnerIcon } from './icons.js';

/**
 * Generation-model picker for the chat surface. "Auto" (the default) sends no
 * modelId, so the server uses foundationModelType=MANAGED and Bedrock picks the
 * model; any other option sends that catalog id, which the server maps to
 * foundationModelType=CUSTOM + the model ARN. Options are grouped by family.
 */
function ModelPicker() {
  const modelId = useChatStore((s) => s.modelId);
  const setModel = useChatStore((s) => s.setModel);
  const sending = useChatStore((s) => s.sending);

  // Group the flat catalog by family, preserving catalog order.
  const groups = useMemo(() => {
    const byFamily = new Map<string, typeof CHAT_MODELS[number][]>();
    for (const m of CHAT_MODELS) {
      const list = byFamily.get(m.family) ?? [];
      list.push(m);
      byFamily.set(m.family, list);
    }
    return [...byFamily.entries()];
  }, []);

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
      <span className="sr-only">Generation model</span>
      <SparkIcon className="h-3.5 w-3.5" aria-hidden="true" />
      <select
        className="bmkb-input h-7 w-auto max-w-[12rem] py-0 pl-1.5 pr-6 text-[11px]"
        value={modelId}
        disabled={sending}
        aria-label="Generation model"
        title="Choose the model that answers your questions"
        onChange={(e) => setModel(e.target.value)}
      >
        <option value={AUTO_MODEL_ID}>Auto (recommended)</option>
        {groups.map(([family, models]) => (
          <optgroup key={family} label={family}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-brand-600 text-white'
            : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100',
        ].join(' ')}
      >
        {message.content ? (
          isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none break-words">
              <Markdown>{message.content}</Markdown>
            </div>
          )
        ) : message.streaming ? (
          <span className="inline-flex items-center gap-1 text-slate-400">
            <SpinnerIcon className="h-3.5 w-3.5" /> thinking…
          </span>
        ) : null}
        {message.streaming && message.content && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current align-middle" />
        )}
        {message.error && (
          <p
            className="mt-1 flex items-center gap-1 text-xs text-rose-200 dark:text-rose-300"
            role="alert"
          >
            <AlertIcon className="h-3.5 w-3.5" /> {message.error}
          </p>
        )}
        {!isUser && <Citations citations={message.citations} />}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
        <SparkIcon className="h-6 w-6" />
      </span>
      <div>
        <p className="text-sm font-medium">Ask anything about your documents</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Answers are generated from your indexed files and scoped to your account.
        </p>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const reset = useChatStore((s) => s.reset);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || sending) return;
    void send(text);
    setDraft('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  return (
    <section className="bmkb-card flex h-full min-h-0 flex-col" aria-label="Chat">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold">Chat</h2>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            New conversation
          </button>
        )}
      </header>

      <div ref={scrollRef} className="bmkb-scroll flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            className="bmkb-input max-h-40 min-h-[2.5rem] resize-none"
            placeholder="Ask a question about your documents…"
            rows={1}
            value={draft}
            aria-label="Message"
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {sending ? (
            <button
              type="button"
              onClick={stop}
              className="bmkb-btn-ghost h-10 whitespace-nowrap"
              title="Stop generating"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0}
              className="bmkb-btn-primary h-10 w-10 !px-0"
              aria-label="Send message"
            >
              <SendIcon className="h-5 w-5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            Enter to send · Shift+Enter for a new line
          </p>
          <ModelPicker />
        </div>
      </div>
    </section>
  );
}
