/**
 * Minimal structured (JSON) logger for the chat lambda.
 *
 * No secrets are ever logged. Tenant id is logged for traceability (it is an
 * opaque scope identifier, not a credential); the user's message text and the
 * generated answer are NOT logged to avoid leaking document content.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

const MIN_LEVEL = resolveMinLevel();

function emit(level: LogLevel, message: string, fields: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) {
    return;
  }
  const line = {
    level,
    message,
    service: 'chat',
    timestamp: new Date().toISOString(),
    ...fields,
  };
  // Route warn/error to stderr, the rest to stdout.
  const serialized = JSON.stringify(line);
  if (level === 'warn' || level === 'error') {
    process.stderr.write(`${serialized}\n`);
  } else {
    process.stdout.write(`${serialized}\n`);
  }
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a child logger that merges `bound` into every emitted record. */
  child(bound: LogFields): Logger;
}

export function createLogger(bound: LogFields = {}): Logger {
  return {
    debug: (message, fields) => emit('debug', message, { ...bound, ...fields }),
    info: (message, fields) => emit('info', message, { ...bound, ...fields }),
    warn: (message, fields) => emit('warn', message, { ...bound, ...fields }),
    error: (message, fields) => emit('error', message, { ...bound, ...fields }),
    child: (childBound) => createLogger({ ...bound, ...childBound }),
  };
}
