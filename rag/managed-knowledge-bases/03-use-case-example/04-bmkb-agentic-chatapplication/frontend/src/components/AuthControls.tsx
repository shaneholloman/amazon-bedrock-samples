import { useAuthStore } from '../store/auth.js';
import { useChatStore } from '../store/chat.js';
import { useDocumentsStore } from '../store/documents.js';
import { IS_AUTH_CONFIGURED } from '../lib/config.js';
import { LogoutIcon, SpinnerIcon } from './icons.js';

/**
 * Real Cognito sign-in / sign-out controls for the header.
 *
 *  - Unauthenticated → a "Sign in" button that redirects to the Cognito hosted
 *    UI (Authorization Code + PKCE).
 *  - Authenticated → the signed-in user's email plus a "Sign out" button that
 *    clears local tokens and ends the hosted-UI session.
 *
 * Identity (the Cognito `sub`) is never trusted from the client: it is shown
 * only for display. The JWT sent on each request is the security boundary.
 */
export function AuthControls() {
  const status = useAuthStore((s) => s.status);
  const email = useAuthStore((s) => s.email);
  const signIn = useAuthStore((s) => s.signIn);
  const signOut = useAuthStore((s) => s.signOut);
  const resetChat = useChatStore((s) => s.reset);
  const resetDocs = useDocumentsStore((s) => s.reset);

  const handleSignOut = (): void => {
    // Clear any in-memory data before the session ends / redirect happens.
    resetChat();
    resetDocs();
    void signOut();
  };

  if (status === 'loading') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <SpinnerIcon className="h-4 w-4" /> Loading…
      </span>
    );
  }

  if (status === 'authenticated') {
    return (
      <div className="flex items-center gap-2">
        <span
          className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 sm:inline-flex"
          title="Signed in"
        >
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          <span className="max-w-[16rem] truncate font-medium">{email ?? 'Signed in'}</span>
        </span>
        <button
          type="button"
          onClick={handleSignOut}
          className="bmkb-btn-ghost h-9"
          title="Sign out"
        >
          <LogoutIcon className="h-4 w-4" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    );
  }

  // Unauthenticated or error.
  return (
    <button
      type="button"
      onClick={() => void signIn()}
      className="bmkb-btn-primary h-9 whitespace-nowrap"
      disabled={!IS_AUTH_CONFIGURED}
      title={IS_AUTH_CONFIGURED ? 'Sign in with Cognito' : 'Cognito is not configured'}
    >
      Sign in
    </button>
  );
}
