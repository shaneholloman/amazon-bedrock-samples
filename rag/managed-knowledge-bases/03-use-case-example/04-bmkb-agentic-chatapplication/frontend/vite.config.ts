import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the bmkb frontend.
//
// The only build-time configuration the client consumes is `VITE_API_BASE`
// (and optional `VITE_TENANT_HEADER`), read via `import.meta.env`. No secrets
// are ever embedded here — the API is reached over authenticated HTTPS and the
// tenant scope is enforced server-side.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @bmkb/common's barrel re-exports document-id.ts, which statically
      // imports node:crypto. That code path is unused in the browser (ids are
      // generated server-side); alias it to a shim so the bundle resolves.
      'node:crypto': fileURLToPath(
        new URL('./src/lib/empty-crypto-shim.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});
