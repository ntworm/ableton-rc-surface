import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.mjs',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: 'http://localhost:9880',
    viewport: { width: 1024, height: 768 },
    actionTimeout: 10000,
  },
  webServer: {
    command: 'node tests/ui/test-server.mjs',
    port: 9880,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Chrome Landscape',
      use: { ...devices['Pixel 5'], isLandscape: true },
    },
  ],
});
