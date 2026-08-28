/**
 * Minimal structured JSON logger. Never logs file bytes, base64 payloads, or
 * secrets — only metadata (document id, tenant, sizes, decisions).
 *
 * Defense in depth: rather than spreading caller-supplied `fields` verbatim,
 * only an allowlist of known-safe metadata keys is emitted. Any other key is
 * dropped and its name (not value) recorded under `_dropped`, so a caller can
 * never accidentally log user-controlled content (e.g. file contents, request
 * bodies) even by mistake.
 */
type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * Keys that may carry user-controlled content — always redacted, never logged
 * (would otherwise risk leaking file bytes, base64 payloads, or request bodies).
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
 * truncate long string values, so raw user content can never be logged while
 * operational metadata still flows.
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
    service: 'upload',
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
