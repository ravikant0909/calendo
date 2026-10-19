import { expect, test } from '@playwright/test'

/**
 * Integration tests that verify real emails are sent.
 * Run against live calendo.dev — requires RESEND_API_KEY env var
 * to query the Resend API for sent emails.
 *
 * Usage:
 *   CALENDO_SESSION_TOKEN=<token> RESEND_API_KEY=<key> \
 *     npx playwright test --config playwright.integration.config.js tests/e2e/integration/email.spec.js
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const SESSION_TOKEN = process.env.CALENDO_SESSION_TOKEN || ''

async function getRecentEmails(toEmail) {
  if (!RESEND_API_KEY) return []
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
    })
    if (!resp.ok) return []
    const data = await resp.json()
    // Filter emails sent to the target address in the last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    return (data.data || []).filter(e =>
      e.to?.includes(toEmail) && e.created_at > fiveMinAgo
    )
  } catch {
    return []
  }
}

test.describe('Email Integration', () => {
  test.beforeEach(async () => {
    if (!SESSION_TOKEN || !RESEND_API_KEY) {
      test.skip()
    }
  })

  test('booking confirmation email sent', async ({ page }) => {
    // This test requires:
    // 1. A real user session on calendo.dev
    // 2. A bookable event type
    // 3. RESEND_API_KEY to verify emails
    // 4. Use a real email address as the invitee

    await page.context().addCookies([{
      name: 'session',
      value: SESSION_TOKEN,
      domain: 'calendo.dev',
      path: '/',
    }])

    await page.goto('/dashboard/')
    await expect(page.locator('#welcomeHeader')).toBeVisible({ timeout: 10000 })

    // Get booking URL
    const bookingLink = await page.locator('#bookingLinkValue').textContent()
    const bookingUrl = bookingLink?.trim()
    if (!bookingUrl) {
      test.skip()
      return
    }

    // Go to booking page and book with a test email
    const testEmail = `e2e-email-test-${Date.now()}@calendo.test`
    await page.goto(bookingUrl)

    // Select first event type if on list view
    const eventCard = page.locator('.event-type-card, .et-option').first()
    if (await eventCard.isVisible()) {
      await eventCard.click()
    }

    // Find and click available slot
    for (let i = 0; i < 4; i++) {
      const days = page.locator('.calendar-day.available')
      if (await days.count()) {
        await days.first().click()
        await page.locator('.time-slot').first().click()
        break
      }
      await page.locator('.calendar-nav-btn').last().click()
      await page.waitForTimeout(250)
    }

    await page.fill('#input-name', 'Email Test User')
    await page.fill('#input-email', testEmail)
    await page.click('#btn-confirm')
    await expect(page.locator('.confirmation-title')).toHaveText('Booking Confirmed!')

    // Wait for email to be sent (give it a few seconds)
    await page.waitForTimeout(5000)

    // Check Resend API for the email
    const emails = await getRecentEmails(testEmail)
    expect(emails.length).toBeGreaterThan(0)
    // The subject should contain "Booking Confirmed" or similar
    const confirmEmail = emails.find(e =>
      e.subject?.toLowerCase().includes('confirm') ||
      e.subject?.toLowerCase().includes('booked')
    )
    expect(confirmEmail).toBeTruthy()
  })
})
