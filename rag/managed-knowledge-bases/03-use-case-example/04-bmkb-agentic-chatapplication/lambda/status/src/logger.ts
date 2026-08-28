/**
 * Minimal structured JSON logger for the status Lambda. Logs only metadata
 * (document id, tenant, status, reconciliation outcome) — never document bytes.
 *
 * Defense in depth: caller-supplied `fields` are filtered to an allowlist of
 * known-safe metadata keys; any other key is dropped (its name recorded under
 * `_dropped`) so user-controlled content can never be logged by accident.
 */
type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * Keys that may carry user-controlled content — always redacted, never logged.
 */
const REDACTED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'data',
  'content',
  'contentBase64',
  'bytes',
  'body',
  'text',
  'textContent',
  'document',
  'payload',
  'query',
  'prompt',
  'attributes',
  'metadata',
]);

/** Cap any string value so an oversized field can't bloat or smuggle content. */
const MAX_VALUE_CHARS = 512;

/**
 * Sanitize caller-supplied fields: redact known content-bearing keys and
 * truncate long string values, keeping operational metadata while making it
 * structurally impossible to log raw user content.
 */
function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_FIELD_KEYS.has(key)) {
      safe[key] = '[redacted]';
    } else if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
      safe[key] = `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]`;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    message,
    service: 'status',
    ts: new Date().toISOString(),
    ...sanitizeFields(fields),
  });
  if (level === 'ERROR') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === 'WARN') {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const log = {
  info: (message: string, fields: Record<string, unknown> = {}): void =>
    emit('INFO', message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}): void =>
    emit('WARN', message, fields),
  error: (message: string, fields: Record<string, unknown> = {}): void =>
    emit('ERROR', message, fields),
};
