/**
 * Runtime configuration loader.
 *
 * WHY THIS EXISTS: Vite inlines `import.meta.env.VITE_*` into the bundle at
 * BUILD time, freezing the API/Cognito coordinates into the shipped JavaScript.
 * A rebuilt-from-stale-env bundle then points at resources (Cognito pool, API
 * stage) that no longer exist — a silent, per-user runtime failure that only
 * shows up when someone clicks "Sign in" or uploads a file.
 *
 * INSTEAD: the bundle is environment-agnostic. At startup we fetch `/config.json`
 * — a file that `cdk deploy` writes from the REAL stack outputs into the same
 * bucket as the SPA (see infra HostingConstruct). Config and bundle are shipped
 * together by one deploy, so they cannot drift. Promote the same immutable
 * bundle across dev/staging/prod; each environment serves its own config.json.
 *
 * There are NO secrets here: the Cognito SPA client has no secret and per-user
 * isolation is enforced server-side from the verified JWT `sub`. `config.json`
 * carries only values that are already public in the browser.
 *
 * Load order matters: `config.ts`, `store/auth.ts`, and `lib/api.ts` all read
 * config at MODULE-EVALUATION time. `main.tsx` therefore awaits
 * loadRuntimeConfig() and then DYNAMICALLY imports App, guaranteeing this
 * singleton is populated before any consumer module is evaluated.
 */

/** Shape of the config the app needs at runtime (mirrors CDK's config.json). */
export interface RuntimeConfig {
  /** REST API base, e.g. https://abc123.execute-api.us-west-2.amazonaws.com/prod */
  readonly apiBase: string;
  readonly cognito: {
    /** OIDC issuer: https://cognito-idp.<region>.amazonaws.com/<userPoolId> */
    readonly authority: string;
    /** Cognito app client id (public SPA client, no secret). */
    readonly clientId: string;
    /** Hosted-UI domain: https://<prefix>.auth.<region>.amazoncognito.com */
    readonly domain: string;
  };
}

/** Outcome of loading — always resolves (never throws) so callers can render. */
export interface RuntimeConfigResult {
  readonly config: RuntimeConfig;
  /** 'runtime' = /config.json, 'dev-env' = VITE_* fallback (dev only). */
  readonly source: 'runtime' | 'dev-env';
  /** Missing/empty required fields (empty => fully configured). */
  readonly missing: readonly string[];
  /** Set when the fetch/parse itself failed (distinct from missing fields). */
  readonly loadError?: string;
}

const EMPTY: RuntimeConfig = {
  apiBase: '',
  cognito: { authority: '', clientId: '', domain: '' },
};

let resolved: RuntimeConfigResult | undefined;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Normalize/trim a loosely-typed config object into a RuntimeConfig. */
function normalize(raw: unknown): RuntimeConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const cognito = (obj.cognito ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    apiBase: stripTrailingSlash(str(obj.apiBase)),
    cognito: {
      authority: stripTrailingSlash(str(cognito.authority)),
      clientId: str(cognito.clientId),
      domain: stripTrailingSlash(str(cognito.domain)),
    },
  };
}

/** List required fields that are still empty (drives the fail-loud banner). */
function missingFields(cfg: RuntimeConfig): string[] {
  const missing: string[] = [];
  if (!cfg.apiBase) missing.push('apiBase');
  if (!cfg.cognito.authority) missing.push('cognito.authority');
  if (!cfg.cognito.clientId) missing.push('cognito.clientId');
  if (!cfg.cognito.domain) missing.push('cognito.domain');
  return missing;
}

/**
 * Build a RuntimeConfig from Vite build-time env (DEV fallback only).
 *
 * Every read is guarded by `import.meta.env.DEV`, which Vite statically
 * replaces with `false` in a production build. That turns this whole function's
 * body into dead code that Vite's minifier eliminates — so a PRODUCTION bundle
 * contains NO inlined VITE_* value and is fully environment-agnostic. (Without
 * this guard, Vite would inline the env literals here even though the code path
 * is unreachable at runtime.)
 */
function fromDevEnv(): RuntimeConfig {
  if (!import.meta.env.DEV) return EMPTY;
  const env = import.meta.env;
  return normalize({
    apiBase: env.VITE_API_BASE,
    cognito: {
      authority: env.VITE_COGNITO_AUTHORITY,
      clientId: env.VITE_COGNITO_CLIENT_ID,
      domain: env.VITE_COGNITO_DOMAIN,
    },
  });
}

/**
 * Load runtime config ONCE. Fetches `/config.json` (same-origin, no CORS,
 * no-store so a redeploy is picked up immediately). In DEV, falls back to
 * VITE_* so `npm run dev` works without a deployed backend. Never throws — the
 * result carries `missing`/`loadError` so the UI can fail loud with a banner
 * instead of a raw Cognito 404 deep in a click handler.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfigResult> {
  if (resolved) return resolved;

  const isDev = Boolean(import.meta.env.DEV);
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (res.ok) {
      const config = normalize(await res.json());
      const missing = missingFields(config);
      // In dev, if config.json is present but incomplete, backfill from env so
      // a local run isn't blocked by a stub file.
      if (missing.length > 0 && isDev) {
        const devConfig = fromDevEnv();
        resolved = {
          config: devConfig,
          source: 'dev-env',
          missing: missingFields(devConfig),
        };
        return resolved;
      }
      resolved = { config, source: 'runtime', missing };
      return resolved;
    }
    // Non-200: in dev, fall back to env; in prod, this is a hard misconfig.
    if (isDev) {
      const devConfig = fromDevEnv();
      resolved = { config: devConfig, source: 'dev-env', missing: missingFields(devConfig) };
      return resolved;
    }
    resolved = {
      config: EMPTY,
      source: 'runtime',
      missing: missingFields(EMPTY),
      loadError: `config.json returned HTTP ${res.status}`,
    };
    return resolved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDev) {
      const devConfig = fromDevEnv();
      resolved = { config: devConfig, source: 'dev-env', missing: missingFields(devConfig) };
      return resolved;
    }
    resolved = {
      config: EMPTY,
      source: 'runtime',
      missing: missingFields(EMPTY),
      loadError: `failed to fetch config.json: ${message}`,
    };
    return resolved;
  }
}

/**
 * Synchronous accessor for the already-loaded config. Consumer modules
 * (config.ts) call this at evaluation time, which is guaranteed to run AFTER
 * loadRuntimeConfig() resolves because main.tsx dynamically imports App only
 * after the await. If called before loading (defensive), returns EMPTY so the
 * ConfigBanner reports "not configured" rather than crashing.
 */
export function getRuntimeConfig(): RuntimeConfig {
  return resolved?.config ?? EMPTY;
}

/** The full result (source/missing/loadError), for the ConfigBanner. */
export function getRuntimeConfigResult(): RuntimeConfigResult | undefined {
  return resolved;
}
