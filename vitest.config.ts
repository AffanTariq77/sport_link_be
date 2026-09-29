import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Same as the other scripts' --env-file-if-exists=.env. Existing env vars win.
if (existsSync('.env')) process.loadEnvFile();

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // DB tests share one test database, so run files one at a time.
    fileParallelism: false,
    // Tests run real multi-step flows against Postgres; 5 s is too tight on a busy machine or CI runner.
    testTimeout: 20_000,
    globalSetup: ['test/global-setup.ts'],
  },
});
