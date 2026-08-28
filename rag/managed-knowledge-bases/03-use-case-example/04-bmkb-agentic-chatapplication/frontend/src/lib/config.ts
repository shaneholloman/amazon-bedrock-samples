/**
 * Public app configuration, resolved from RUNTIME config (see runtime-config.ts).
 *
 * These values come from `/config.json`, which `cdk deploy` writes from the live
 * stack outputs — NOT from `import.meta.env.VITE_*` baked into the bundle. That
 * is deliberate: build-time inlining freezes the API/Cognito coordinates into
 * the shipped JS, so a rebuild from a stale env silently points the app at a
 * pool/API that no longer exists. Runtime config makes bundle-vs-stack drift
 * structurally impossible (see runtime-config.ts for the full rationale).
 *
 * The browser is allowed to know the public API base and the (non-secret)
 * Cognito SPA configuration. There are NO credentials here: a Cognito SPA app
 * client has no client secret, and the only sensitive material — the user's
 * tokens — is obtained at runtime via Authorization Code + PKCE and is never
 * embedded. Per-user isolation is enforced server-side from the verified JWT
 * `sub`; nothing the client sends can widen that scope.
 *
 * IMPORTANT: this module reads config at evaluation time via getRuntimeConfig().
 * main.tsx awaits loadRuntimeConfig() BEFORE dynamically importing App, so the
 * singleton is always populated before this module is first evaluated.
 */
import { getRuntimeConfig } from './runtime-config.js';

const runtime = getRuntimeConfig();

/** Public API base, e.g. https://abc123.execute-api.us-west-2.amazonaws.com/prod */
export const API_BASE: string = runtime.apiBase;

/** True when the app has a configured API base. */
export const IS_API_CONFIGURED: boolean = API_BASE.length > 0;

/**
 * Cognito OIDC configuration for the hosted UI (Authorization Code + PKCE).
 *
 *  - `authority`   — the issuer URL, e.g.
 *      https://cognito-idp.<region>.amazonaws.com/<userPoolId>
 *  - `clientId`    — the Cognito app client id (public SPA client, no secret).
 *  - `redirectUri` — where the hosted UI returns the auth code; must be a
 *      registered callback URL on the app client (e.g. the CloudFront origin).
 *  - `domain`      — the Cognito hosted UI domain, e.g.
 *      https://<prefix>.auth.<region>.amazoncognito.com. Used to drive the
 *      hosted-UI logout endpoint (RP-initiated logout).
 */
export interface CognitoConfig {
  readonly authority: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly domain: string;
}

export const COGNITO: CognitoConfig = {
  authority: runtime.cognito.authority,
  clientId: runtime.cognito.clientId,
  // The app's own origin (with a trailing slash) is the redirect target; it is
  // registered as a Cognito callback URL by the stack (both slash variants).
  // Cognito matches redirect_uri by EXACT string, so keep this stable.
  redirectUri: typeof window !== 'undefined' ? window.location.origin + '/' : '',
  domain: runtime.cognito.domain,
};

/** True when enough Cognito config is present to attempt a sign-in. */
export const IS_AUTH_CONFIGURED: boolean =
  COGNITO.authority.length > 0 && COGNITO.clientId.length > 0;
