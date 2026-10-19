import { defineConfig } from '@playwright/test'

const serverCommand = 'node ./scripts/prepare-local-db.mjs .wrangler/e2e && npx wrangler dev --local --persist-to .wrangler/e2e --ip 127.0.0.1 --port 8787 --log-level error --env-file ./scripts/local-test.env'

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/integration/**'],
  timeout: 60000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The app now registers a service worker on every page. Block it during e2e
    // so SW caching/interception can't add flakiness to deterministic tests.
    serviceWorkers: 'block',
    // Use the full Chromium app, not chrome-headless-shell. The headless-shell
    // variant crashes at launch on macOS with a mach-port permission error
    // ("bootstrap_check_in ... Permission denied (1100)").
    channel: 'chromium',
  },
  webServer: {
    command: serverCommand,
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: false,
    timeout: 120000,
  },
})
