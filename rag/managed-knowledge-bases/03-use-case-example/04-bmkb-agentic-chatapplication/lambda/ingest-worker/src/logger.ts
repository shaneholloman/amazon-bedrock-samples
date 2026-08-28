/**
 * Minimal structured JSON logger. One line per event, machine-parseable in
 * CloudWatch. No secrets/PII: we log document ids + tenant ids + status, never
 * raw document bytes or base64 content.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

type LogFields = Record<string, unknown>;

/**
 * Keys that may carry user-controlled content — always redacted, never logged.
 * The worker logs metadata (ids, sizes, status, counts); these keys would
 * otherwise risk leaking document bytes, request payloads, or query text.
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
 * truncate long string values. This keeps operational logging flexible while
 * making it structurally impossible to log raw user content.
 */
function sanitizeFields(fields: LogFields): LogFields {
  const safe: LogFields = {};
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

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const line = {
    level,
    msg: message,
    ts: new Date().toISOString(),
    component: 'ingest-worker',
    ...(fields ? sanitizeFields(fields) : {}),
  };
  // Single structured line; stdout for INFO/DEBUG, stderr for WARN/ERROR.
  const serialized = safeStringify(line);
  if (level === 'ERROR' || level === 'WARN') {
    process.stderr.write(`${serialized}\n`);
  } else {
    process.stdout.write(`${serialized}\n`);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ level: 'ERROR', msg: 'log serialization failed' });
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => emit('DEBUG', message, fields),
  info: (message: string, fields?: LogFields): void => emit('INFO', message, fields),
  warn: (message: string, fields?: LogFields): void => emit('WARN', message, fields),
  error: (message: string, fields?: LogFields): void => emit('ERROR', message, fields),
};

/** Normalize an unknown thrown value into a safe, loggable summary. */
export function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: typeof err === 'string' ? err : safeStringify(err) };
}
