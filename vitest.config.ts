import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Services fall back to %APPDATA%\gPhotos (settings, sync checkpoints, library status,
// pending rotation queue, logs) when there is no Electron `app`, i.e. under vitest. Point
// that at a throwaway dir so the suite can never read or write the real user's data.
const isolatedAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_vitest_appdata_'));

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
    env: { APPDATA: isolatedAppData, LOCALAPPDATA: isolatedAppData },
    // Several specs assert on timing (event-loop lag, "not artificially delayed") and others burn a lot of CPU
    // (20k-face clustering oracles, workers, sharp). Running every spec file at once starves the timing ones, so
    // cap the parallelism at about half the cores.
    maxWorkers: Math.max(2, Math.floor(os.cpus().length / 2)),
  },
});
