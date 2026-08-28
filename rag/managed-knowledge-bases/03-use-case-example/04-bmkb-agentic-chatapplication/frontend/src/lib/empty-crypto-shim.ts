/**
 * Browser shim for `node:crypto`.
 *
 * `@bmkb/common`'s barrel re-exports `document-id.ts`, which imports
 * `createHash` from `node:crypto`. The frontend NEVER builds document ids
 * (the server owns id generation), so this code path is unused at runtime —
 * but the static import must still resolve for the browser bundle. Vite aliases
 * `node:crypto` to this shim (see vite.config.ts). If it were ever called it
 * throws loudly rather than silently returning a wrong/insecure value.
 */
export function createHash(): never {
  throw new Error(
    'node:crypto.createHash is not available in the browser; document ids are generated server-side.',
  );
}

export default { createHash };
