import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      // Only PUBLIC, by-design browser variables are injected here. Never
      // inject a server secret (e.g. a Gemini/API key) through Vite `define`
      // or `import.meta.env` — it would be compiled into the client bundle
      // and shipped to every browser. See docs/PRODUCTION_READINESS.md.
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''),
      // API origin for a build that is NOT served by the API — the Capacitor
      // Android bundle loads its assets from https://localhost, so `/api/...`
      // must be prefixed with a real host. Left empty for the web deployment,
      // where the API is same-origin (lib/apiBase.ts owns the resolution).
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      allowedHosts: true,
    },
  };
});
