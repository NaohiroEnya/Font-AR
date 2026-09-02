import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    allowedHosts: ['.ngrok-free.dev'],
  },
});
