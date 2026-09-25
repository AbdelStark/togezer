import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/goals': 'http://localhost:3001',
      '/state': 'http://localhost:3001',
      '/agents': 'http://localhost:3001',
      '/lessons': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
