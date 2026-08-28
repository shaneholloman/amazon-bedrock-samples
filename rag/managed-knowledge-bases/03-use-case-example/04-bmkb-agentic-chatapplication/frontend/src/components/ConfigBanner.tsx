import { getRuntimeConfigResult } from '../lib/runtime-config.js';
import { AlertIcon } from './icons.js';

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

/**
 * Fail-loud deployment-health banner. Runtime config is delivered by
 * `/config.json` (written by `cdk deploy`); if it is missing, unreachable, or
 * incomplete, surface ONE obvious message instead of letting a user hit a raw
 * Cognito 404 or a "Failed to fetch" deep inside a click handler. This converts
 * a silent, per-user runtime failure into a single visible signal.
 */
export function ConfigBanner() {
  const result = getRuntimeConfigResult();

  // A hard load failure (config.json missing / non-200 / unreachable in prod).
  if (result?.loadError) {
    return (
      <Banner>
        <span className="font-medium">Deployment misconfigured.</span> Could not load{' '}
        <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">/config.json</code>:{' '}
        {result.loadError}. A fresh <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">cdk deploy</code>{' '}
        writes this file from the stack outputs.
      </Banner>
    );
  }

  // Loaded but missing required fields.
  if (result && result.missing.length > 0) {
    return (
      <Banner>
        <span className="font-medium">Deployment misconfigured.</span> Missing config values:{' '}
        <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">
          {result.missing.join(', ')}
        </code>
        {result.source === 'dev-env'
          ? ' — set the matching VITE_* vars for local dev.'
          : ' — redeploy so config.json is regenerated from stack outputs.'}
      </Banner>
    );
  }

  return null;
}
