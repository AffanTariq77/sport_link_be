import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Same as the other scripts' --env-file-if-exists=.env. Existing env vars win.
if (existsSync('.env')) process.loadEnvFile();

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // DB tests share one test database, so run files one at a time.
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
  },
});
