import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` proxies the API to a locally running server (default :3002).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: process.env.MEMENTO_API || 'http://localhost:3002', changeOrigin: false },
      '/health': { target: process.env.MEMENTO_API || 'http://localhost:3002' },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 700 },
});
