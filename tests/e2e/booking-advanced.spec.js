import { expect, test } from '@playwright/test'
import {
  createEventTypeViaForm,
  getBookingUrl,
  gotoBookingPage,
  navigateToTab,
  openFirstAvailableSlot,
  registerUser,
  uniqueId,
} from './helpers.js'

async function createCoupon(page, code, { type = 'percent', value = '100', maxUses = '' } = {}) {
  await page.click('#createCouponBtn')
  await expect(page.locator('#couponCreateForm')).toBeVisible({ timeout: 5000 })
  await page.fill('#couponCode', code)
  await page.selectOption('#couponType', type)
  await page.fill('#couponValue', value)
  if (maxUses !== '') {
    await page.fill('#couponMaxUses', maxUses)
  }
  await page.click('#couponSubmitBtn')
  await expect(page.locator('#couponsList')).toContainText(code, { timeout: 10000 })
}

function localIsoDate(daysAhead) {
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  return date.toISOString().slice(0, 10)
}

test.describe('Advanced Booking Flows', () => {
  test('paid event applies a 100% coupon and confirms without external checkout', async ({ page }) => {
    await registerUser(page, 'PaidCoupon')
    const bookingBase = await getBookingUrl(page)

    const eventName = `Paid Consult ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, {
      name: eventName,
      price: '25',
      paymentMethod: 'stripe',
    })

    await navigateToTab(page, 'settings')
    const couponCode = `FREE${uniqueId().slice(-6).toUpperCase()}`
    await createCoupon(page, couponCode, { type: 'percent', value: '100', maxUses: '5' })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await openFirstAvailableSlot(page)

    await expect(page.locator('#price-display')).toContainText('$25.00')
    await expect(page.locator('#btn-confirm')).toHaveText('Pay & Confirm')

    await page.fill('#input-coupon', couponCode)
    await page.click('#apply-coupon-btn')
    await expect(page.locator('#coupon-status')).toContainText('100% off applied')
    await expect(page.locator('#price-display')).toContainText('FREE')
    await expect(page.locator('#btn-confirm')).toHaveText('Confirm Booking')

    await page.fill('#input-name', `Coupon Guest ${uniqueId()}`)
    await page.fill('#input-email', `coupon-${uniqueId()}@calendo.test`)
    await page.click('#btn-confirm')

    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })
  })

  test('redirect URL receives invitee details and UTM parameters after booking', async ({ page }) => {
    await registerUser(page, 'RedirectFlow')
    const bookingBase = await getBookingUrl(page)
    const origin = new URL(bookingBase).origin

    const eventName = `Redirect Event ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, {
      name: eventName,
      redirectUrl: `${origin}/privacy?from=redirect-flow`,
    })

    await gotoBookingPage(page, bookingBase, eventSlug, {
      utm_source: 'newsletter',
      utm_campaign: 'spring-promo',
      utm_medium: 'email',
    })
    await openFirstAvailableSlot(page)

    const inviteeName = `Redirect Guest ${uniqueId()}`
    const inviteeEmail = `redirect-${uniqueId()}@calendo.test`
    await page.fill('#input-name', inviteeName)
    await page.fill('#input-email', inviteeEmail)
    await page.click('#btn-confirm')

    await page.waitForURL('**/privacy?**', { timeout: 10000 })
    const redirected = new URL(page.url())
    expect(redirected.searchParams.get('from')).toBe('redirect-flow')
    expect(redirected.searchParams.get('invitee_name')).toBe(inviteeName)
    expect(redirected.searchParams.get('invitee_email')).toBe(inviteeEmail)
    expect(redirected.searchParams.get('event_type')).toBe(eventSlug)
    expect(redirected.searchParams.get('utm_source')).toBe('newsletter')
    expect(redirected.searchParams.get('utm_campaign')).toBe('spring-promo')
    expect(redirected.searchParams.get('utm_medium')).toBe('email')
    expect(redirected.searchParams.get('start_time')).toBeTruthy()
  })

  test('single-use link works once and is rejected on the second visit', async ({ page }) => {
    await registerUser(page, 'SingleUse')

    const eventName = `Single Use Session ${uniqueId()}`
    await createEventTypeViaForm(page, { name: eventName })

    await page.click('.sidebar-nav a[data-tab="settings"]')
    await page.click('#createSingleUseLinkBtn')
    await expect(page.locator('#singleUseLinkCreateForm')).toBeVisible({ timeout: 5000 })
    await page.selectOption('#sulEventType', { label: eventName })
    await page.fill('#sulLabel', 'One-time invite')
    await page.fill('#sulMaxUses', '1')
    await page.click('#sulGenerateBtn')
    await expect(page.locator('#singleUseLinksList')).toContainText(eventName, { timeout: 10000 })

    const onclick = await page.locator('#singleUseLinksList button:has-text("Copy")').first().getAttribute('onclick')
    const singleUseUrl = onclick?.match(/copySulLink\('([^']+)'\)/)?.[1]
    expect(singleUseUrl).toBeTruthy()

    await page.goto(singleUseUrl)
    await openFirstAvailableSlot(page)
    await page.fill('#input-name', `Single Use Guest ${uniqueId()}`)
    await page.fill('#input-email', `single-use-${uniqueId()}@calendo.test`)
    await page.click('#btn-confirm')
    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })

    await page.goto(singleUseUrl)
    await expect(page.locator('#not-found-view')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#not-found-view')).toContainText(/Link Expired|already been used|no longer valid/i)
  })

  test('group event shows reduced spot count after the first booking and still allows the second booking', async ({ page }) => {
    await registerUser(page, 'GroupFlow')
    const bookingBase = await getBookingUrl(page)

    const eventName = `Group Workshop ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, {
      name: eventName,
      groupMaxAttendees: 2,
    })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await page.locator('.calendar-day.available').first().click()
    await expect(page.locator('.time-slot').first()).toContainText(/2 spots|2 spot/i)
    await page.locator('.time-slot').first().click()
    await page.fill('#input-name', `Group Guest A ${uniqueId()}`)
    await page.fill('#input-email', `group-a-${uniqueId()}@calendo.test`)
    await page.click('#btn-confirm')
    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await page.locator('.calendar-day.available').first().click()
    const oneSpotButton = page.locator('.time-slot').filter({ hasText: /1 spot left/i }).first()
    await expect(oneSpotButton).toBeVisible({ timeout: 10000 })
    await oneSpotButton.click()
    await page.fill('#input-name', `Group Guest B ${uniqueId()}`)
    await page.fill('#input-email', `group-b-${uniqueId()}@calendo.test`)
    await page.click('#btn-confirm')
    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await page.locator('.calendar-day.available').first().click()
    await expect(page.locator('.time-slot').filter({ hasText: /1 spot left/i })).toHaveCount(0)
  })

  test('holiday presets block a weekday holiday that would otherwise be available', async ({ page }) => {
    await registerUser(page, 'HolidayFlow')
    const bookingBase = await getBookingUrl(page)

    await navigateToTab(page, 'availability')
    await page.selectOption('#holidayCountry', 'US')
    await page.selectOption('#holidayYear', '2026')
    await page.click('#loadHolidayPresetsBtn')
    await expect(page.locator('#holidaysList')).toContainText('Memorial Day', { timeout: 10000 })
    await page.click('#saveHolidaysBtn')

    await gotoBookingPage(page, bookingBase, '30-minute-meeting')
    await page.locator('.calendar-nav-btn').last().click()
    const memorialDay = page.locator('.calendar-day').filter({ hasText: /^25$/ }).first()
    await expect(memorialDay).toHaveClass(/unavailable/)
  })
})
