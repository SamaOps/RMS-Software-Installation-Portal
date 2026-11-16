import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to the API so no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': process.env.VITE_DEV_API || 'http://localhost:4000' } },
});
