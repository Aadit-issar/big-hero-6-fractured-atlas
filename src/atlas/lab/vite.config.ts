import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Only the hero GLB models of the challenge scene live here (see docs/ASSET_PROVENANCE.md).
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('../../../dist/atlas-lab', import.meta.url)),
    emptyOutDir: true,
  },
});
