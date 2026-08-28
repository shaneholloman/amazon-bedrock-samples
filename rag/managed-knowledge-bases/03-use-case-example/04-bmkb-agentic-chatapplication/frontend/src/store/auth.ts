import { create } from 'zustand';
import {
  UserManager,
  WebStorageStateStore,
  type User,
  type UserManagerSettings,
} from 'oidc-client-ts';
import { COGNITO, IS_AUTH_CONFIGURED } from '../lib/config.js';
import { setAuthTokenProvider, setUnauthorizedHandler } from '../lib/api.js';

/**
 * Real authentication backed by Amazon Cognito (hosted UI, OAuth 2.0
 * Authorization Code + PKCE). This is the security boundary: every API request
 * carries the resulting JWT as `Authorization: Bearer <token>`, and the server
 * derives the user's identity (the Cognito `sub`) from the *verified* token.
 * Nothing in this client can widen a user's scope — per-user isolation is
 * enforced server-side from the JWT `sub`.
 *
 * No client secret is used (correct for a public SPA client) and no long-lived
 * secret is ever stored: only the OIDC user (id/access tokens) lives in
 * localStorage so a page refresh stays signed in.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AuthState {
  status: AuthStatus;
  /** Cognito `sub` — the stable per-user id used server-side for isolation. */
  userId: string | undefined;
  /** Best-effort display name (email / preferred_username / sub). */
  email: string | undefined;
  /** Last sign-in/callback error message, if any. */
  error: string | undefined;
  /** Begin sign-in (redirect to the Cognito hosted UI). */
  signIn: () => Promise<void>;
  /** Sign out locally and via the Cognito hosted-UI logout endpoint. */
  signOut: () => Promise<void>;
  /** Initialise: complete a redirect callback if present, else load any session. */
  initialize: () => Promise<void>;
}

/**
 * The OIDC redirect callback URL. Cognito appends `?code=…&state=…`. We detect
 * the callback by the presence of those params on the configured redirect path.
 */
function hasAuthCallbackParams(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.has('code') && params.has('state');
}

function buildUserManager(): UserManager | undefined {
  if (!IS_AUTH_CONFIGURED || typeof window === 'undefined') return undefined;
  const settings: UserManagerSettings = {
    authority: COGNITO.authority,
    client_id: COGNITO.clientId,
    redirect_uri: COGNITO.redirectUri,
    post_logout_redirect_uri: COGNITO.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    // Persist the session across reloads; PKCE means no secret is stored.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    stateStore: new WebStorageStateStore({ store: window.localStorage }),
    // Silently renew the access token before it expires; sign out on failure.
    automaticSilentRenew: true,
    // Cognito does not expose a standards metadata `end_session_endpoint`; we
    // perform RP-initiated logout against the hosted-UI /logout endpoint
    // ourselves (see signOut), so disable the library's metadata-based logout.
    monitorSession: false,
  };
  return new UserManager(settings);
}

const userManager = buildUserManager();

/** Extract a human-friendly display name from OIDC profile claims. */
function displayName(user: User): string | undefined {
  const profile = user.profile as Record<string, unknown>;
  const email = typeof profile.email === 'string' ? profile.email : undefined;
  const preferred =
    typeof profile.preferred_username === 'string' ? profile.preferred_username : undefined;
  return email ?? preferred ?? (typeof profile.sub === 'string' ? profile.sub : undefined);
}

/**
 * Choose the bearer token. An API Gateway COGNITO_USER_POOLS authorizer only
 * accepts the ID token (token_use=id, whose `aud` is this app client) — the
 * hosted-UI ACCESS token (token_use=access, no `aud`, scope
 * aws.cognito.signin.user.admin) is REJECTED with 401. Verified live against
 * this deployment: access token → 401 at the authorizer (upload lambda never
 * invoked), ID token → 200. So send the ID token; fall back to the access token
 * only if no ID token is present (better than sending nothing).
 */
function bearerToken(user: User): string | undefined {
  return user.id_token || user.access_token || undefined;
}

/** Build the Cognito hosted-UI logout URL (RP-initiated logout). */
function hostedLogoutUrl(): string | undefined {
  if (!COGNITO.domain || !COGNITO.clientId) return undefined;
  const params = new URLSearchParams({
    client_id: COGNITO.clientId,
    logout_uri: COGNITO.redirectUri,
  });
  return `${COGNITO.domain}/logout?${params.toString()}`;
}

export const useAuthStore = create<AuthState>((set) => {
  /** Push a signed-in user into state and register its token with the API. */
  const adoptUser = (user: User | null): void => {
    if (!user || user.expired) {
      setAuthTokenProvider(() => undefined);
      set({ status: 'unauthenticated', userId: undefined, email: undefined });
      return;
    }
    const sub = typeof user.profile.sub === 'string' ? user.profile.sub : undefined;
    setAuthTokenProvider(() => bearerToken(user));
    set({
      status: 'authenticated',
      userId: sub,
      email: displayName(user),
      error: undefined,
    });
  };

  // React to token lifecycle events from the UserManager.
  if (userManager) {
    userManager.events.addUserLoaded((user) => adoptUser(user));
    userManager.events.addUserUnloaded(() => adoptUser(null));
    userManager.events.addAccessTokenExpired(() => {
      // Renewal failed / token expired: drop the session and require sign-in.
      void userManager.removeUser().finally(() => adoptUser(null));
    });
    userManager.events.addSilentRenewError(() => {
      void userManager.removeUser().finally(() => adoptUser(null));
    });

    // When the API returns 401 (token expired/rejected mid-session), try one
    // silent renew; if that fails, drop the session so the UI prompts a fresh
    // sign-in instead of retrying against a dead token. Guard against loops with
    // a single in-flight renew.
    let renewing = false;
    setUnauthorizedHandler(() => {
      if (renewing) return;
      renewing = true;
      void userManager
        .signinSilent()
        .then((user) => adoptUser(user))
        .catch(() => userManager.removeUser().finally(() => adoptUser(null)))
        .finally(() => {
          renewing = false;
        });
    });
  }

  return {
    status: 'loading',
    userId: undefined,
    email: undefined,
    error: undefined,

    initialize: async () => {
      if (!userManager) {
        // Auth not configured: surface as unauthenticated (ConfigBanner warns).
        set({ status: 'unauthenticated' });
        return;
      }
      try {
        if (hasAuthCallbackParams()) {
          const user = await userManager.signinRedirectCallback();
          // Strip the auth code/state from the URL so a refresh is clean.
          window.history.replaceState({}, document.title, COGNITO.redirectUri);
          adoptUser(user);
          return;
        }
        const user = await userManager.getUser();
        adoptUser(user);
      } catch (err) {
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'sign-in failed',
        });
      }
    },

    signIn: async () => {
      if (!userManager) {
        set({ status: 'error', error: 'Cognito is not configured.' });
        return;
      }
      try {
        await userManager.signinRedirect();
      } catch (err) {
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'sign-in failed',
        });
      }
    },

    signOut: async () => {
      setAuthTokenProvider(() => undefined);
      set({ status: 'unauthenticated', userId: undefined, email: undefined });
      if (userManager) {
        try {
          await userManager.removeUser();
        } catch {
          /* ignore */
        }
      }
      // RP-initiated logout: clears the Cognito hosted-UI session too, so the
      // next sign-in genuinely re-authenticates rather than silently resuming.
      const logoutUrl = hostedLogoutUrl();
      if (logoutUrl && typeof window !== 'undefined') {
        window.location.assign(logoutUrl);
      }
    },
  };
});
