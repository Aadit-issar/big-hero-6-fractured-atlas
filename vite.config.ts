import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Terrain tests mesh all fourteen islands; allow for a loaded CPU.
    testTimeout: 30_000,
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/simulation/**/*.ts'],
    },
  },
});
