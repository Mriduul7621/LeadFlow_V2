import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installAuthenticatedFetch } from './lib/apiClient';
import { installGlobalChunkRecovery } from './utils/chunkRecovery';
import { registerPushServiceWorker } from './modules/notifications/services/pushService';

installAuthenticatedFetch();

// Web Push reminders (public/sw.js): registration only — permission is
// requested solely from the explicit opt-in toggle in Profile settings,
// never here. Fire-and-forget; the helper swallows every failure so app
// boot can never break on it (including inside the Capacitor shell,
// where push is unsupported and this is a no-op in practice).
void registerPushServiceWorker();

// Safety net for stale-dynamic-chunk failures that never reach a React
// error boundary (stale entry script / modulepreload on a hard load with
// a cached index.html, imports outside the route tree). One guarded
// reload, cooldown-protected — see utils/chunkRecovery.ts.
installGlobalChunkRecovery();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
