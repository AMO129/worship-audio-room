import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: 'client/assets',
  build: {
    outDir: 'client/dist',
    emptyOutDir: true,
  },
});
