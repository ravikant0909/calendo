import { defineConfig } from '@playwright/test'

/**
 * Integration test config — runs against live calendo.dev.
 * These tests use real external services (Claude AI, Resend email, etc.)
 * and should be run sparingly, not on every code change.
 *
 * Usage:
 *   npx playwright test --config playwright.integration.config.js
 *
 * Prerequisites:
 *   - Valid session tokens in environment variables (see below)
 *   - Real Claude API key configured in Cloudflare Workers
 *   - Resend API key for email verification (optional)
 */
export default defineConfig({
  testDir: './tests/e2e/integration',
  timeout: 120000, // 2 minutes per test (AI calls are slow)
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'https://calendo.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Use existing session cookie instead of registering
    extraHTTPHeaders: {
      'Cookie': `session=${process.env.CALENDO_SESSION_TOKEN || ''}`,
    },
  },
  // No webServer block — tests run against production
})
