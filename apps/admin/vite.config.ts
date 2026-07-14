import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.SLOTS_DOCKER ? '0.0.0.0' : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
    },
  },
});
