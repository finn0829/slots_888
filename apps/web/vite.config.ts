import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: process.env.SLOTS_DOCKER ? '0.0.0.0' : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
    },
  },
});
