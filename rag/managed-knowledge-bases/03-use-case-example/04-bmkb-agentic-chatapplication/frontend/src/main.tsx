import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { loadRuntimeConfig } from './lib/runtime-config.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('bmkb: #root element not found in index.html');
}

/**
 * Bootstrap: load /config.json BEFORE importing any module that reads config at
 * evaluation time (config.ts, store/auth.ts, lib/api.ts). App is imported
 * dynamically for exactly this reason — its dependency graph must not be
 * evaluated until the runtime-config singleton is populated. loadRuntimeConfig
 * never throws (it records missing/loadError instead), so the app always mounts
 * and the ConfigBanner surfaces any misconfiguration loudly.
 */
async function bootstrap(): Promise<void> {
  await loadRuntimeConfig();
  const { App } = await import('./App.js');
  ReactDOM.createRoot(container as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
