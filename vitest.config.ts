import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer/src'),
      '@shared': path.resolve(__dirname, 'src/types'),
    },
  },
  test: {
    include: ['test/vitest/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 480000,
    hookTimeout: 30000,
  },
});
