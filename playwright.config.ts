import { defineConfig, devices } from '@playwright/test';

const playwrightPort = process.env.PLAYWRIGHT_PORT || process.env.PORT || '3000';
const playwrightBaseUrl =
  process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${playwrightPort}`;
const disablePlaywrightWebServer = process.env.PLAYWRIGHT_NO_WEBSERVER === 'true';
const webServerEnv = [
  'DISABLE_AUTH=true',
  `NEXTAUTH_SECRET=${process.env.NEXTAUTH_SECRET || 'playwright-test-secret'}`,
  `PORT=${playwrightPort}`,
];

if (process.env.WATCHPACK_POLLING) {
  webServerEnv.push(`WATCHPACK_POLLING=${process.env.WATCHPACK_POLLING}`);
}

/**
 * Playwright E2E Test Configuration for AgriDrone Ops
 *
 * Run tests with: npm run test:e2e
 * Run in UI mode: npm run test:e2e:ui
 */
export default defineConfig({
  // Test directory
  testDir: './e2e',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter configuration
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  // Shared settings for all projects
  use: {
    // Base URL for the application
    baseURL: playwrightBaseUrl,

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Uncomment to add more browsers
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  // Run local dev server before starting the tests
  webServer: disablePlaywrightWebServer
    ? undefined
    : {
        command: `${webServerEnv.join(' ')} npm run dev`,
        url: playwrightBaseUrl,
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000, // 2 minutes to start
      },

  // Global timeout for each test
  timeout: 60 * 1000, // 60 seconds

  // Expect timeout
  expect: {
    timeout: 10 * 1000, // 10 seconds
  },
});
