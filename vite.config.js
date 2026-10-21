import { defineConfig } from 'vite';
import { motionLogPlugin } from './scripts/motion-log.mjs';
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export default defineConfig({
  define: { __BUILD__: JSON.stringify(stamp), __COMMIT__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || '') },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: 'index.html', world: 'world.html' } } },   // /world: Jena's 3D room (world.html, lazy src/world.js)
  plugins: [motionLogPlugin()],   // LOCAL /motion-log telemetry stub (dev server only)
  server: { proxy: { '/api': 'http://localhost:4173' } },
});
