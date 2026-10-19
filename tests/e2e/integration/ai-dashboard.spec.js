import { expect, test } from '@playwright/test'

/**
 * Integration tests for the Dashboard AI assistant.
 * Run against live calendo.dev with a real Claude API key.
 *
 * Usage:
 *   CALENDO_SESSION_TOKEN=<your-session-token> npx playwright test --config playwright.integration.config.js
 *
 * These tests use a real user session and real AI API calls.
 * They cost real API credits and should be run sparingly.
 */

const SESSION_TOKEN = process.env.CALENDO_SESSION_TOKEN || ''
const DELAY_BETWEEN_TESTS = 15000 // 15s to avoid AI rate limits

test.describe('AI Dashboard Integration', () => {
  test.beforeEach(async ({ page }) => {
    // Set session cookie and navigate to dashboard
    if (!SESSION_TOKEN) {
      test.skip()
      return
    }
    await page.context().addCookies([{
      name: 'session',
      value: SESSION_TOKEN,
      domain: 'calendo.dev',
      path: '/',
    }])
    await page.goto('/dashboard/')
    await expect(page.locator('#welcomeHeader')).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async () => {
    // Delay between tests to avoid AI rate limits
    await new Promise(r => setTimeout(r, DELAY_BETWEEN_TESTS))
  })

  test('AI answers scheduling question', async ({ page }) => {
    // Open AI chat
    const aiToggle = page.locator('#aiToggle, button:has-text("AI"), .ai-fab').first()
    await aiToggle.click()
    await page.waitForTimeout(500)

    // Type a question
    const chatInput = page.locator('#aiInput, .ai-input, textarea[placeholder*="message"]').first()
    await chatInput.fill('What are my event types?')
    await page.keyboard.press('Enter')

    // Wait for AI response (may take up to 30s)
    const response = page.locator('.ai-message, .chat-message').last()
    await expect(response).toBeVisible({ timeout: 45000 })

    // Response should mention event types (not an error)
    const text = await response.textContent()
    expect(text?.toLowerCase()).not.toContain('went wrong')
    expect(text?.toLowerCase()).not.toContain('rate-limited')
  })

  test('AI refuses off-topic question', async ({ page }) => {
    const aiToggle = page.locator('#aiToggle, button:has-text("AI"), .ai-fab').first()
    await aiToggle.click()
    await page.waitForTimeout(500)

    const chatInput = page.locator('#aiInput, .ai-input, textarea[placeholder*="message"]').first()
    await chatInput.fill('What is the capital of France?')
    await page.keyboard.press('Enter')

    const response = page.locator('.ai-message, .chat-message').last()
    await expect(response).toBeVisible({ timeout: 45000 })

    const text = await response.textContent()
    expect(text?.toLowerCase()).toContain('can only help')
  })

  test('AI navigates to settings', async ({ page }) => {
    const aiToggle = page.locator('#aiToggle, button:has-text("AI"), .ai-fab').first()
    await aiToggle.click()
    await page.waitForTimeout(500)

    const chatInput = page.locator('#aiInput, .ai-input, textarea[placeholder*="message"]').first()
    await chatInput.fill('Take me to settings')
    await page.keyboard.press('Enter')

    // Wait for AI response + navigation action
    await page.waitForTimeout(10000)

    // Settings panel should become active
    await expect(page.locator('#panel-settings')).toHaveClass(/active/, { timeout: 15000 })
  })

  test('AI submits feedback', async ({ page }) => {
    const aiToggle = page.locator('#aiToggle, button:has-text("AI"), .ai-fab').first()
    await aiToggle.click()
    await page.waitForTimeout(500)

    const chatInput = page.locator('#aiInput, .ai-input, textarea[placeholder*="message"]').first()
    await chatInput.fill('I want to submit feedback: The dashboard loads fast, great job!')
    await page.keyboard.press('Enter')

    const response = page.locator('.ai-message, .chat-message').last()
    await expect(response).toBeVisible({ timeout: 45000 })

    const text = await response.textContent()
    // Should confirm feedback was submitted
    expect(text?.toLowerCase()).toMatch(/submitted|received|thank/)
  })
})
