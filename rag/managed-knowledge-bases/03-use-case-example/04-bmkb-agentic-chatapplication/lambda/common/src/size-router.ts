/**
 * Size router — decides INLINE vs S3 ingest path, and enforces the format
 * allowlist and the hard per-file size ceiling.
 *
 * Verified ceilings (F3, F5, F6):
 *   - Inline payload ceiling per ingest request = 6 MB (doc-only).  <= 6 MB → INLINE
 *   - Per-file size on the S3 path                = 50 MB.          > 50 MB → reject
 *   - Format allowlist                             = F6 extensions/MIME.
 *
 * Defaults are config-driven (override via env) so we can retune after the M3
 * benchmark measures the real ingest ceiling — but the absolute hard caps
 * (6 MB / 50 MB) come from verified quotas and should not be raised.
 */

import {
  IngestPath,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  type SupportedExtension,
  type SupportedMimeType,
} from './types.js';

/** 6 MB inline payload ceiling (F3). */
export const DEFAULT_INLINE_MAX_BYTES = 6 * 1024 * 1024; // 6_291_456
/** 50 MB per-file ceiling on the S3 path (F5). */
export const DEFAULT_S3_MAX_FILE_BYTES = 50 * 1024 * 1024; // 52_428_800

export interface SizeRouterConfig {
  /** <= this many bytes → INLINE; above → S3. Default 6 MB. */
  readonly inlineMaxBytes: number;
  /** Hard reject above this many bytes. Default 50 MB. */
  readonly s3MaxFileBytes: number;
}

export function sizeRouterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SizeRouterConfig {
  return {
    inlineMaxBytes: parsePositiveInt(env['INLINE_MAX_BYTES'], DEFAULT_INLINE_MAX_BYTES),
    s3MaxFileBytes: parsePositiveInt(env['S3_MAX_FILE_BYTES'], DEFAULT_S3_MAX_FILE_BYTES),
  };
}

export class SizeRouterError extends Error {
  constructor(
    message: string,
    readonly code: 'UNSUPPORTED_FORMAT' | 'FILE_TOO_LARGE' | 'INVALID_SIZE',
  ) {
    super(message);
    this.name = 'SizeRouterError';
  }
}

const EXTENSION_SET: ReadonlySet<string> = new Set(SUPPORTED_EXTENSIONS);
const MIME_SET: ReadonlySet<string> = new Set(SUPPORTED_MIME_TYPES);

/** Extract a lowercased extension (with dot) from a filename, or null. */
export function extensionOf(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx < 0 || idx === filename.length - 1) return null;
  return filename.slice(idx).toLowerCase();
}

export function isSupportedExtension(ext: string): ext is SupportedExtension {
  return EXTENSION_SET.has(ext.toLowerCase());
}

export function isSupportedMimeType(mime: string): mime is SupportedMimeType {
  return MIME_SET.has(mime);
}

/**
 * Validate the file's format against the allowlist. Throws on rejection.
 * Both the filename extension AND the declared content type must be allowed.
 */
export function assertSupportedFormat(filename: string, contentType: string): void {
  const ext = extensionOf(filename);
  if (ext === null || !isSupportedExtension(ext)) {
    throw new SizeRouterError(
      `unsupported file extension for "${filename}" (allowed: ${SUPPORTED_EXTENSIONS.join(' ')})`,
      'UNSUPPORTED_FORMAT',
    );
  }
  if (!isSupportedMimeType(contentType)) {
    throw new SizeRouterError(
      `unsupported content type "${contentType}"`,
      'UNSUPPORTED_FORMAT',
    );
  }
}

export interface RouteDecision {
  readonly path: IngestPath;
  readonly extension: SupportedExtension;
  readonly contentType: SupportedMimeType;
  readonly sizeBytes: number;
}

/**
 * Decide the ingest path for a file. Validates format + size first.
 *   <= inlineMaxBytes (6 MB) → INLINE
 *   <= s3MaxFileBytes (50 MB) → S3
 *   > s3MaxFileBytes          → reject (FILE_TOO_LARGE)
 */
export function routeBySize(
  filename: string,
  contentType: string,
  sizeBytes: number,
  config: SizeRouterConfig = sizeRouterConfigFromEnv(),
): RouteDecision {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new SizeRouterError(`invalid sizeBytes: ${sizeBytes}`, 'INVALID_SIZE');
  }
  assertSupportedFormat(filename, contentType);

  if (sizeBytes > config.s3MaxFileBytes) {
    throw new SizeRouterError(
      `file is ${sizeBytes} bytes; exceeds the ${config.s3MaxFileBytes}-byte (50 MB) per-file limit`,
      'FILE_TOO_LARGE',
    );
  }

  const path = sizeBytes <= config.inlineMaxBytes ? IngestPath.INLINE : IngestPath.S3;
  // Narrowed by assertSupportedFormat above.
  return {
    path,
    extension: extensionOf(filename) as SupportedExtension,
    contentType: contentType as SupportedMimeType,
    sizeBytes,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
