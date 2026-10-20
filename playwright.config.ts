import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  // One page at a time: each page runs a terrain worker pool and compiles large
  // shaders at start-up, so parallel pages measure CPU contention, not the app.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173',
    browserName: 'chromium',
    launchOptions: { channel: 'chrome' },
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.E2E_SERVER_COMMAND ?? 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  outputDir: './test-results/playwright',
});
