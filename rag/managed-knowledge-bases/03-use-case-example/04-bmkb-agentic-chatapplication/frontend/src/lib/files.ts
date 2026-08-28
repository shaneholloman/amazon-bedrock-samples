/**
 * Client-side file helpers. These mirror the server's validation using the
 * SAME shared logic from `@bmkb/common` so the UI can show an accurate routing
 * hint and reject obviously-bad files BEFORE a round-trip. The server remains
 * the authority — these checks are purely for UX.
 */
import {
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_S3_MAX_FILE_BYTES,
  IngestPath,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  assertSupportedFormat,
  extensionOf,
  routeBySize,
  SizeRouterError,
  type SupportedMimeType,
} from '@bmkb/common';

export const INLINE_MAX_BYTES = DEFAULT_INLINE_MAX_BYTES;
export const S3_MAX_FILE_BYTES = DEFAULT_S3_MAX_FILE_BYTES;

/** Comma-joined extension list for the <input accept="…"> attribute. */
export const ACCEPT_ATTR = SUPPORTED_EXTENSIONS.join(',');

/** A guess of the MIME type from a filename, used when the browser omits one. */
export function inferContentType(filename: string): SupportedMimeType | null {
  const ext = extensionOf(filename);
  if (!ext) return null;
  const map: Record<string, SupportedMimeType> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.csv': 'text/csv',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pdf': 'application/pdf',
  };
  return map[ext] ?? null;
}

/**
 * Resolve the effective content type for a browser File. Browsers frequently
 * report '' or a non-allowlisted type for office docs, so we fall back to the
 * extension-derived type when needed.
 */
export function resolveContentType(file: File): string {
  if (file.type && (SUPPORTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return file.type;
  }
  return inferContentType(file.name) ?? file.type ?? '';
}

export interface FileValidation {
  readonly ok: boolean;
  readonly contentType: string;
  readonly ingestPath?: IngestPath;
  readonly error?: string;
}

/**
 * Validate + classify a file using the shared size router. Returns a routing
 * hint (INLINE vs S3) or a human-readable error. Never throws.
 */
export function validateFile(file: File): FileValidation {
  const contentType = resolveContentType(file);
  try {
    assertSupportedFormat(file.name, contentType);
    const decision = routeBySize(file.name, contentType, file.size);
    return { ok: true, contentType, ingestPath: decision.path };
  } catch (err) {
    if (err instanceof SizeRouterError) {
      return { ok: false, contentType, error: err.message };
    }
    return {
      ok: false,
      contentType,
      error: err instanceof Error ? err.message : 'invalid file',
    };
  }
}

/** Human-readable byte size, e.g. "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Read a File as a base64 string (no data: prefix), for the INLINE upload path.
 * Rejects if the file would exceed the inline ceiling.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('unexpected FileReader result'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
