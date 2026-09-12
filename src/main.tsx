import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installAuthenticatedFetch } from './lib/apiClient';
import { installGlobalChunkRecovery } from './utils/chunkRecovery';

installAuthenticatedFetch();

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
