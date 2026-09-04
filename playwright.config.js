import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = process.env.PLAYWRIGHT_PORT || '5173';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    // Windows で webkit ワーカーが 300s ブロックする問題を防ぐクリーンアップ
    {
      name: 'webkit-cleanup',
      testMatch: ['**/teardown/webkit-cleanup.teardown.js'],
    },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, teardown: 'webkit-cleanup' },
    { name: 'iPhone15', use: { ...devices['iPhone 15'] }, teardown: 'webkit-cleanup' },
    {
      name: 'iPhone15-landscape',
      use: { ...devices['iPhone 15 landscape'] },
      teardown: 'webkit-cleanup',
    },
  ],
});
