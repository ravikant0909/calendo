import { expect, test } from '@playwright/test'
import {
  createEventTypeViaForm,
  getBookingUrl,
  gotoBookingPage,
  navigateToTab,
  openFirstAvailableSlot,
  registerUser,
  uniqueId,
  waitForDashboard,
} from './helpers.js'

async function createCoupon(page, code, value = '100') {
  await navigateToTab(page, 'settings')
  await page.click('#createCouponBtn')
  await expect(page.locator('#couponCreateForm')).toBeVisible({ timeout: 5000 })
  await page.fill('#couponCode', code)
  await page.selectOption('#couponType', 'percent')
  await page.fill('#couponValue', value)
  await page.click('#couponSubmitBtn')
  await expect(page.locator('#couponsList')).toContainText(code, { timeout: 10000 })
}

function nextDate(daysAhead) {
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  return date.toISOString().slice(0, 10)
}

test.describe('Routing, Polls, And Compound Flows', () => {
  test('routing form creates a public qualifier flow and records a submission in analytics', async ({ page }) => {
    const host = await registerUser(page, 'RoutingFlow')

    const eventName = `Enterprise Demo ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, { name: eventName })

    await navigateToTab(page, 'routing-forms')
    await page.click('#createRfBtn')
    await expect(page.locator('#rfFormPanel')).toBeVisible({ timeout: 5000 })

    const formName = `Lead Router ${uniqueId()}`
    const formSlug = `lead-router-${uniqueId()}`
    await page.fill('#rfName', formName)
    await page.fill('#rfSlug', formSlug)

    await page.click('#rfAddFieldBtn')
    const field = page.locator('#rfFieldsList > div').first()
    await field.locator('input[placeholder="Label"]').fill('Company size')
    await field.locator('select').selectOption('radio')
    await field.locator('input[placeholder="Options (comma-separated)"]').fill('Small,Enterprise')
    await field.locator('input[type="checkbox"]').check()

    await page.click('#rfAddRuleBtn')
    const rule = page.locator('#rfRulesList > div').first()
    await rule.locator('select').nth(0).selectOption({ label: 'Company size' })
    await rule.locator('input[placeholder="Value"]').fill('Enterprise')
    await rule.locator('select').nth(2).selectOption({ label: eventName })

    await page.click('#rfSubmitBtn')
    await expect(page.locator('#routingFormsList')).toContainText(formName, { timeout: 10000 })

    await page.goto(`/routing/?user=${host.slug}&form=${formSlug}`)
    await expect(page.locator('#form-title')).toHaveText(formName, { timeout: 10000 })
    await page.check('input[value="Enterprise"]')
    await page.click('#btn-submit')

    await page.waitForURL(`**/booking/?user=${host.slug}&event=${eventSlug}`, { timeout: 10000 })
    await expect(page.locator('#sidebar-event-name')).toContainText(eventName, { timeout: 15000 })

    await page.goto('/dashboard/')
    await waitForDashboard(page)
    await navigateToTab(page, 'routing-forms')
    await expect(page.locator('#routingAnalytics')).toContainText('1 submissions', { timeout: 10000 })
    await expect(page.locator('#routingAnalytics')).toContainText(eventName)
  })

  test('meeting poll supports creation, public voting, and finalization', async ({ page }) => {
    await registerUser(page, 'PollFlow')
    await navigateToTab(page, 'settings')

    const pollTitle = `Team Poll ${uniqueId()}`
    await page.click('#createPollBtn')
    await expect(page.locator('#pollCreateForm')).toBeVisible({ timeout: 5000 })
    await page.fill('#pollTitle', pollTitle)
    await page.fill('#pollDesc', 'Pick the best time for the team')

    await page.locator('#pollOptionsContainer input[type="date"]').nth(0).fill(nextDate(1))
    await page.locator('#pollOptionsContainer input[type="date"]').nth(1).fill(nextDate(2))
    await page.locator('#pollOptionsContainer input[type="time"]').nth(0).fill('09:00')
    await page.locator('#pollOptionsContainer input[type="time"]').nth(1).fill('10:00')
    await page.locator('#pollOptionsContainer input[type="time"]').nth(2).fill('11:00')
    await page.locator('#pollOptionsContainer input[type="time"]').nth(3).fill('12:00')
    await page.click('#pollSubmitBtn')
    await expect(page.locator('#pollsList')).toContainText(pollTitle, { timeout: 10000 })

    const poll = await page.evaluate(async (title) => {
      const res = await fetch('/api/polls')
      const data = await res.json()
      return data.find((item) => item.title === title) || null
    }, pollTitle)

    expect(poll?.id).toBeTruthy()

    await page.goto(`/poll/?id=${poll.id}`)
    await expect(page.locator('h1')).toHaveText(pollTitle, { timeout: 10000 })

    await page.locator('button.vote-btn[data-option]').first().click()
    await page.fill('#voterName', `Poll Voter ${uniqueId()}`)
    await page.fill('#voterEmail', `poll-voter-${uniqueId()}@calendo.test`)
    await page.click('#submitVoteBtn')
    await expect(page.locator('#toast')).toContainText('Votes submitted!', { timeout: 10000 })

    await expect(page.locator('table.vote-table')).toContainText('Poll Voter', { timeout: 10000 })
    await expect(page.locator('#finalizePollBtn')).toBeVisible({ timeout: 10000 })
    await page.click('#finalizePollBtn')
    await expect(page.locator('#toast')).toContainText('Poll finalized!', { timeout: 10000 })
    await expect(page.locator('body')).toContainText('Meeting confirmed!', { timeout: 10000 })
  })

  test('compound flow: paid event, coupon, guests, redirect, analytics, and audit log all line up', async ({ page }) => {
    const host = await registerUser(page, 'CompoundFlow')
    const bookingBase = await getBookingUrl(page)
    const origin = new URL(bookingBase).origin

    await navigateToTab(page, 'settings')
    await page.fill('#settingsDisplayName', `Compound Host ${uniqueId()}`)
    await page.fill('#settingsGaMeasurementId', 'G-COMPOUND123')
    await page.fill('#settingsMetaPixelId', '123456789')
    await page.click('#settingsSaveBtn')
    await expect(page.locator('#settingsSaveBtn')).toHaveText('Save Changes', { timeout: 10000 })

    const eventName = `Compound Session ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, {
      name: eventName,
      allowGuests: true,
      price: '30',
      paymentMethod: 'stripe',
      redirectUrl: `${origin}/privacy?from=compound-flow`,
    })

    const couponCode = `COMPOUND${uniqueId().slice(-4).toUpperCase()}`
    await createCoupon(page, couponCode, '100')

    await gotoBookingPage(page, bookingBase, eventSlug, {
      utm_source: 'google',
      utm_campaign: 'compound-suite',
      utm_medium: 'cpc',
    })
    await openFirstAvailableSlot(page)

    await page.click('#add-guest-btn')
    await page.click('#add-guest-btn')
    await page.locator('.guest-email-input').nth(0).fill(`compound-guest-a-${uniqueId()}@calendo.test`)
    await page.locator('.guest-email-input').nth(1).fill(`compound-guest-b-${uniqueId()}@calendo.test`)

    const inviteeName = `Compound Invitee ${uniqueId()}`
    const inviteeEmail = `compound-${uniqueId()}@calendo.test`
    await page.fill('#input-name', inviteeName)
    await page.fill('#input-email', inviteeEmail)
    await page.fill('#input-coupon', couponCode)
    await page.click('#apply-coupon-btn')
    await expect(page.locator('#price-display')).toContainText('FREE')
    await expect(page.locator('#btn-confirm')).toHaveText('Confirm Booking')

    await page.click('#btn-confirm')
    await page.waitForURL('**/privacy?**', { timeout: 10000 })

    const redirected = new URL(page.url())
    expect(redirected.searchParams.get('from')).toBe('compound-flow')
    expect(redirected.searchParams.get('invitee_name')).toBe(inviteeName)
    expect(redirected.searchParams.get('invitee_email')).toBe(inviteeEmail)
    expect(redirected.searchParams.get('event_type')).toBe(eventSlug)
    expect(redirected.searchParams.get('utm_source')).toBe('google')
    expect(redirected.searchParams.get('utm_campaign')).toBe('compound-suite')
    expect(redirected.searchParams.get('utm_medium')).toBe('cpc')

    await page.goto('/dashboard/')
    await waitForDashboard(page)
    await navigateToTab(page, 'bookings')
    await expect(page.locator('#bookingsTableContainer')).toContainText(eventName, { timeout: 10000 })
    await expect(page.locator('#bookingsTableContainer')).toContainText('+2 guests', { timeout: 10000 })

    await navigateToTab(page, 'analytics')
    const totalText = await page.locator('#statTotal').textContent()
    expect(parseInt(totalText || '0', 10)).toBeGreaterThanOrEqual(1)

    await navigateToTab(page, 'settings')
    await page.selectOption('#auditActionFilter', 'booking.created')
    await page.click('#refreshAuditLogBtn')
    await expect(page.locator('#auditLogBody')).toContainText(inviteeEmail, { timeout: 10000 })
  })
})
