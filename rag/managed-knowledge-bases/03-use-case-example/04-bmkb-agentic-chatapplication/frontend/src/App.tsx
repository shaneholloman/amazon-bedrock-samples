import { useEffect } from 'react';
import { useAuthStore } from './store/auth.js';
import { useDocumentsStore } from './store/documents.js';
import { AuthControls } from './components/AuthControls.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { Uploader } from './components/Uploader.js';
import { DocumentList } from './components/DocumentList.js';
import { ChatPanel } from './components/ChatPanel.js';
import { ConfigBanner } from './components/ConfigBanner.js';
import { SparkIcon, SpinnerIcon } from './components/icons.js';

/** Poll cadence for reconciling PENDING documents against GET /status. */
const POLL_INTERVAL_MS = 4000;

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            <SparkIcon className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <h1 className="text-base font-semibold">BMKB - Document Chat App</h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Knowledge Base Chat
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AuthControls />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function Loading() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center text-slate-500 dark:text-slate-400">
      <SpinnerIcon className="h-6 w-6" />
      <p className="text-sm">Checking your session…</p>
    </div>
  );
}

function SignedOut() {
  const error = useAuthStore((s) => s.error);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 py-20 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white">
        <SparkIcon className="h-7 w-7" />
      </span>
      <div>
        <h2 className="text-xl font-semibold">Welcome to bmkb</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Sign in to upload documents and chat over them. You only ever see and query your own
          documents — isolation is enforced server-side from your verified identity.
        </p>
      </div>
      <AuthControls />
      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Workspace() {
  return (
    <main className="mx-auto grid max-w-6xl flex-1 grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-2 lg:gap-6">
      <section className="bmkb-card flex flex-col gap-5 p-5" aria-label="Documents">
        <div>
          <h2 className="text-sm font-semibold">Upload documents</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Drag in files to ingest them into your private knowledge base.
          </p>
        </div>
        <Uploader />
        <DocumentList />
      </section>
      <div className="min-h-[60vh] lg:min-h-0">
        <ChatPanel />
      </div>
    </main>
  );
}

export function App() {
  const status = useAuthStore((s) => s.status);
  const initialize = useAuthStore((s) => s.initialize);
  const poll = useDocumentsStore((s) => s.poll);
  const loadDocuments = useDocumentsStore((s) => s.loadDocuments);

  // Complete any OAuth redirect callback / restore an existing session once.
  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Load existing documents from the server once authenticated.
  useEffect(() => {
    if (status === 'authenticated') void loadDocuments();
  }, [status, loadDocuments]);

  // Background reconciliation loop: while signed in, poll status for any
  // non-terminal documents. The store no-ops when there's nothing to reconcile.
  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void poll();
    };
    tick();
    const handle = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [status, poll]);

  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <ConfigBanner />
      {status === 'loading' ? (
        <Loading />
      ) : status === 'authenticated' ? (
        <Workspace />
      ) : (
        <SignedOut />
      )}
      <footer className="border-t border-slate-200 px-4 py-3 text-center text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
        Access is authenticated with Cognito; per-user isolation is enforced server-side from the
        verified token.
      </footer>
    </div>
  );
}
