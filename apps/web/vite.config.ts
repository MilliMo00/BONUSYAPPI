import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Общий контракт (статусы, роли, типы API) берётся прямо из серверного пакета.
    alias: { '@contract': fileURLToPath(new URL('../server/src/contract', import.meta.url)) },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: false },
});
