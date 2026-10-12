import { defineConfig } from 'vite';
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export default defineConfig({
  define: { __BUILD__: JSON.stringify(stamp) },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/api': 'http://localhost:4173' } },
});
