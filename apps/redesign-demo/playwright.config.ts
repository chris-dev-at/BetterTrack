import { defineConfig, devices } from '@playwright/test';

const port = 5194;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        colorScheme: 'dark',
      },
    },
  ],
});
