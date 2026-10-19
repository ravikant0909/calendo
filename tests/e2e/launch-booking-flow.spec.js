import { expect, test } from '@playwright/test'

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

async function openFirstAvailableSlot(page) {
  for (let attempts = 0; attempts < 4; attempts++) {
    const availableDays = page.locator('.calendar-day.available')
    if (await availableDays.count()) {
      await availableDays.first().click()
      await expect(page.locator('.time-slot').first()).toBeVisible()
      await page.locator('.time-slot').first().click()
      return
    }

    await page.locator('.calendar-nav-btn').last().click()
    await page.waitForTimeout(250)
  }

  throw new Error('No available booking slots were found in the first four calendar views')
}

test('user can sign up, create an event type, and complete a public booking flow', async ({ page }) => {
  const unique = Date.now().toString()
  const hostName = `Launch Host ${unique}`
  const hostEmail = `launch-host-${unique}@calendo.test`
  const guestName = `Launch Guest ${unique}`
  const guestEmail = `launch-guest-${unique}@calendo.test`
  const eventName = `Launch Demo ${unique}`
  const eventSlug = slugify(eventName)

  await page.goto('/auth/register.html')

  // Skip onboarding wizard before form submission triggers redirect
  await page.evaluate(() => localStorage.setItem('calendo_onboarding_done', 'true'))

  await page.fill('#name', hostName)
  await page.fill('#email', hostEmail)
  await page.fill('#password', 'password123')
  await page.click('#submitBtn')

  await page.waitForURL('**/dashboard/')

  // The product tour auto-starts for new accounts and its overlay intercepts
  // clicks. Mark it complete server-side and reload so it never starts.
  await page.evaluate(() => fetch('/api/product-tour/complete', { method: 'POST' }))
  await page.reload()

  await expect(page.locator('#welcomeHeader')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

  // Create event type via overview + New button (opens edit modal in create mode)
  await page.click('#overviewCreateEtBtn')
  await expect(page.locator('#editEtPanel')).toBeVisible({ timeout: 5000 })

  await page.fill('#editEtName', eventName)
  // Duration is a number input (was a <select> before custom durations shipped)
  await page.fill('#editEtDuration', '30')
  // (Description lives in a collapsed accordion section and isn't needed here.)
  await page.click('#editEtSaveBtn')
  await page.waitForTimeout(1500)

  await expect(page.locator('#overviewEventTypes')).toContainText(eventName, { timeout: 10000 })

  const bookingLinkText = (await page.locator('#bookingLinkValue').textContent())?.trim()
  expect(bookingLinkText).toBeTruthy()

  const bookingUrl = new URL(bookingLinkText)
  bookingUrl.searchParams.set('event', eventSlug)

  await page.goto(bookingUrl.toString())
  await expect(page.locator('#booking-view')).toBeVisible()

  await openFirstAvailableSlot(page)

  await page.fill('#input-name', guestName)
  await page.fill('#input-email', guestEmail)
  await page.click('#btn-confirm')

  await expect(page.locator('.confirmation-title')).toHaveText('Booking Confirmed!')
  await expect(page.locator('#confirmation-details')).toContainText(eventName)
  // Cancel/Reschedule links render in #confirmation-manage (text: "Cancel booking").
  await expect(page.locator('#confirmation-manage')).toContainText('Cancel booking')
  await expect(page.locator('#confirmation-manage')).toContainText('Reschedule')
})
