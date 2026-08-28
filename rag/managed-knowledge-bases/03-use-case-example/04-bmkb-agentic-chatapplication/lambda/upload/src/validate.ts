/**
 * Strict input validation for POST /upload.
 *
 * Validates the UploadRequest shape BEFORE any routing/size decision. Format +
 * size allowlists are enforced downstream by routeBySize (@bmkb/common); here
 * we guarantee the field types/ranges so routeBySize receives clean input and
 * we can reject malformed requests early with precise error codes.
 */
import {
  SUPPORTED_MIME_TYPES,
  type SupportedMimeType,
  type UploadRequest,
} from '@bmkb/common';

import { HttpError } from './http.js';

/** Defensive ceiling on a single filename to avoid pathological keys/logs. */
const MAX_FILENAME_LEN = 1024;
/** Defensive ceiling on the count of client attributes. */
const MAX_ATTRIBUTES = 50;
const MAX_ATTRIBUTE_KEY_LEN = 128;
const MAX_ATTRIBUTE_VALUE_LEN = 2048;

const MIME_SET: ReadonlySet<string> = new Set(SUPPORTED_MIME_TYPES);

/**
 * Validate the parsed JSON body into a well-typed UploadRequest. Throws
 * HttpError with a precise code on any violation. Does NOT trust `attributes`
 * for tenancy and rejects any caller-supplied tenant key there.
 */
export function validateUploadRequest(body: unknown): UploadRequest {
  // All failures below are CLIENT input errors (4xx) — they must NOT be 500s.
  // INVALID_TENANT_KEY maps to HTTP 400 in the API envelope.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('INVALID_TENANT_KEY', 'request body must be a JSON object');
  }
  const obj = body as Record<string, unknown>;

  const filename = requireString(obj['filename'], 'filename');
  if (filename.length > MAX_FILENAME_LEN) {
    throw new HttpError('INVALID_TENANT_KEY', 'filename is too long');
  }
  // Reject path traversal / control characters in the filename: it becomes part
  // of the deterministic doc id input and (for S3) part of the object key.
  if (
    /[\x00-\x1f\x7f]/.test(filename) ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new HttpError('INVALID_TENANT_KEY', 'filename contains illegal characters');
  }

  const contentTypeRaw = requireString(obj['contentType'], 'contentType');
  if (!MIME_SET.has(contentTypeRaw)) {
    throw new HttpError(
      'UNSUPPORTED_FORMAT',
      `unsupported content type "${contentTypeRaw}"`,
    );
  }
  const contentType = contentTypeRaw as SupportedMimeType;

  const sizeBytes = obj['sizeBytes'];
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new HttpError('INVALID_TENANT_KEY', 'sizeBytes must be a non-negative integer');
  }

  let contentBase64: string | undefined;
  if (obj['contentBase64'] !== undefined) {
    contentBase64 = requireString(obj['contentBase64'], 'contentBase64');
    if (!isBase64(contentBase64)) {
      throw new HttpError('INVALID_TENANT_KEY', 'contentBase64 is not valid base64');
    }
    // Cross-check declared size against the decoded byte length so a client
    // cannot under-declare size to dodge the inline/S3 routing.
    const decodedLen = decodedByteLength(contentBase64);
    if (decodedLen !== sizeBytes) {
      throw new HttpError(
        'INVALID_TENANT_KEY',
        `sizeBytes (${sizeBytes}) does not match decoded contentBase64 length (${decodedLen})`,
      );
    }
  }

  const attributes = validateAttributes(obj['attributes']);

  // exactOptionalPropertyTypes: only attach optional keys when present.
  return {
    filename,
    contentType,
    sizeBytes,
    ...(contentBase64 !== undefined ? { contentBase64 } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
  };
}

function validateAttributes(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError('INVALID_TENANT_KEY', 'attributes must be a string→string object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTES) {
    throw new HttpError('INVALID_TENANT_KEY', `attributes exceeds ${MAX_ATTRIBUTES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length === 0 || k.length > MAX_ATTRIBUTE_KEY_LEN) {
      throw new HttpError('INVALID_TENANT_KEY', 'attribute key length is invalid');
    }
    // Reserved-key rule (F12) + tenancy: client cannot set tenant or any
    // underscore-prefixed (reserved) metadata key via attributes.
    if (k.startsWith('_') || k === 'tenant_id') {
      throw new HttpError(
        'INVALID_TENANT_KEY',
        `attribute key "${k}" is reserved and cannot be set by the client`,
      );
    }
    if (typeof v !== 'string' || v.length > MAX_ATTRIBUTE_VALUE_LEN) {
      throw new HttpError('INVALID_TENANT_KEY', `attribute "${k}" must be a string within limits`);
    }
    out[k] = v;
  }
  return out;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(
      'INVALID_TENANT_KEY',
      `${field} is required and must be a non-empty string`,
    );
  }
  return value;
}

/** Strict base64 check (standard alphabet, correct padding). */
function isBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Exact decoded byte length of a (validated) base64 string. */
function decodedByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}
