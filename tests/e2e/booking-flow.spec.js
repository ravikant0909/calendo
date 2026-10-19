import { expect, test } from '@playwright/test'
import {
  registerUser,
  createEventType,
  openFirstAvailableSlot,
  bookAsGuest,
  getBookingUrl,
  getConfirmationLinks,
  navigateToTab,
  uniqueId,
  slugify,
} from './helpers.js'

test.describe('Booking Flow', () => {
  // ---------------------------------------------------------------------------
  // 1. Full booking happy path
  // ---------------------------------------------------------------------------
  test('full booking happy path: register, create event, book, confirm', async ({ page }) => {
    const host = await registerUser(page, 'BkFlow')
    const { eventName, eventSlug } = await createEventType(page, {
      description: 'Happy path booking test',
    })
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await expect(page.locator('#booking-view')).toBeVisible()

    await openFirstAvailableSlot(page)

    const guestName = `Guest ${uniqueId()}`
    const guestEmail = `guest-${uniqueId()}@calendo.test`
    await page.fill('#input-name', guestName)
    await page.fill('#input-email', guestEmail)
    await page.click('#btn-confirm')

    await expect(page.locator('.confirmation-title')).toHaveText('Booking Confirmed!')
    await expect(page.locator('#confirmation-details')).toContainText(eventName)
  })

  // ---------------------------------------------------------------------------
  // 2. Confirmation shows cancel and reschedule links
  // ---------------------------------------------------------------------------
  test('confirmation shows cancel and reschedule links', async ({ page }) => {
    const host = await registerUser(page, 'BkLinks')
    const { eventName, eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const manage = page.locator('#confirmation-manage')
    await expect(manage).toBeVisible()
    await expect(manage).toContainText('Cancel')
    await expect(manage).toContainText('Reschedule')

    // Verify they are actual links
    const cancelLink = manage.locator('a:has-text("Cancel")')
    const rescheduleLink = manage.locator('a:has-text("Reschedule")')
    await expect(cancelLink).toHaveCount(1)
    await expect(rescheduleLink).toHaveCount(1)

    // Verify href attributes point to the correct pages
    const cancelHref = await cancelLink.getAttribute('href')
    const rescheduleHref = await rescheduleLink.getAttribute('href')
    expect(cancelHref).toContain('/booking/cancel.html?token=')
    expect(rescheduleHref).toContain('/booking/reschedule.html?token=')
  })

  // ---------------------------------------------------------------------------
  // 3. Prefilled links populate name and email
  // ---------------------------------------------------------------------------
  test('prefilled booking links populate name and email', async ({ page }) => {
    const host = await registerUser(page, 'BkPre')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    bookingUrl.searchParams.set('name', 'PreTest')
    bookingUrl.searchParams.set('email', 'pre@test.com')
    await page.goto(bookingUrl.toString())

    await expect(page.locator('#booking-view')).toBeVisible()
    await openFirstAvailableSlot(page)

    await expect(page.locator('#input-name')).toHaveValue('PreTest')
    await expect(page.locator('#input-email')).toHaveValue('pre@test.com')
  })

  // ---------------------------------------------------------------------------
  // 4. Timezone selector visible
  // ---------------------------------------------------------------------------
  test('timezone selector is visible on booking page', async ({ page }) => {
    const host = await registerUser(page, 'BkTz')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    const tzSelect = page.locator('#timezone-select')
    await expect(tzSelect).toBeVisible()

    // Should have multiple timezone options
    const optionCount = await tzSelect.locator('option').count()
    expect(optionCount).toBeGreaterThan(1)
  })

  // ---------------------------------------------------------------------------
  // 5. Embed mode
  // ---------------------------------------------------------------------------
  test('embed mode sets white background and does not crash', async ({ page }) => {
    const host = await registerUser(page, 'BkEmbed')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    bookingUrl.searchParams.set('embed', '1')
    await page.goto(bookingUrl.toString())

    await expect(page.locator('#booking-view')).toBeVisible()

    // Background should be white in embed mode
    const bgColor = await page.evaluate(() => document.body.style.background)
    expect(bgColor).toBe('#fff')
  })

  // ---------------------------------------------------------------------------
  // 6. Direct event link hides back button
  // ---------------------------------------------------------------------------
  test('direct event link hides back button', async ({ page }) => {
    const host = await registerUser(page, 'BkDirect')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await expect(page.locator('#booking-view')).toBeVisible()
    await expect(page.locator('#btn-back-events')).toBeHidden()
  })

  // ---------------------------------------------------------------------------
  // 7. Event list without event param
  // ---------------------------------------------------------------------------
  test('booking page without event param shows event list', async ({ page }) => {
    const host = await registerUser(page, 'BkList')
    await createEventType(page, { name: `ListEvent ${uniqueId()}` })
    const bookingLinkBase = await getBookingUrl(page)

    // Go to booking page WITHOUT ?event= param
    await page.goto(bookingLinkBase)

    await expect(page.locator('#event-list-view')).toBeVisible()
    await expect(page.locator('#booking-view')).toBeHidden()
    await expect(page.locator('#event-types-grid')).not.toBeEmpty()
  })

  // ---------------------------------------------------------------------------
  // 8. Multiple time slots available
  // ---------------------------------------------------------------------------
  test('clicking an available day shows multiple time slots', async ({ page }) => {
    const host = await registerUser(page, 'BkSlots')
    const { eventSlug } = await createEventType(page, { duration: '30' })
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    // Find and click an available day (navigate forward if needed)
    for (let attempts = 0; attempts < 4; attempts++) {
      const availableDays = page.locator('.calendar-day.available')
      if (await availableDays.count()) {
        await availableDays.first().click()
        break
      }
      await page.locator('.calendar-nav-btn').last().click()
      await page.waitForTimeout(250)
    }

    const slotCount = await page.locator('.time-slot').count()
    expect(slotCount).toBeGreaterThan(1)
  })

  // ---------------------------------------------------------------------------
  // 9. Guest validation
  // ---------------------------------------------------------------------------
  test('guest validation prevents submission without name/email', async ({ page }) => {
    const host = await registerUser(page, 'BkVal')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    await openFirstAvailableSlot(page)

    // Leave name and email empty, click confirm
    await page.click('#btn-confirm')

    // Confirmation should NOT appear
    await expect(page.locator('.confirmation-title')).not.toBeVisible()

    // Error message should be visible
    await expect(page.locator('#form-error')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 10. Booking page shows host info
  // ---------------------------------------------------------------------------
  test('booking page shows host display name', async ({ page }) => {
    const host = await registerUser(page, 'BkHost')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    await expect(page.locator('#host-name')).toContainText(host.name)
  })

  // ---------------------------------------------------------------------------
  // 11. Back button from confirm to calendar
  // ---------------------------------------------------------------------------
  test('back button from confirm form returns to calendar view', async ({ page }) => {
    const host = await registerUser(page, 'BkBack')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    // Select a time slot to reach the confirm form
    await openFirstAvailableSlot(page)

    // Confirm form should be visible
    await expect(page.locator('#confirm-view')).toBeVisible()

    // Click back to calendar
    await page.click('#btn-back-calendar')

    // Calendar should be visible again
    await expect(page.locator('#calendar')).toBeVisible()

    // Confirm view should be hidden
    await expect(page.locator('#confirm-view')).toBeHidden()
  })

  // ---------------------------------------------------------------------------
  // 12. Can book default event type (30-minute-meeting)
  // ---------------------------------------------------------------------------
  test('can book using default 30-minute-meeting event type', async ({ page }) => {
    const host = await registerUser(page, 'BkDefault')
    const bookingLinkBase = await getBookingUrl(page)

    // New users get default event types including "30 Minute Meeting"
    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', '30-minute-meeting')
    await page.goto(bookingUrl.toString())

    await expect(page.locator('#booking-view')).toBeVisible()

    await openFirstAvailableSlot(page)

    const guestName = `DefaultGuest ${uniqueId()}`
    const guestEmail = `default-${uniqueId()}@calendo.test`
    await page.fill('#input-name', guestName)
    await page.fill('#input-email', guestEmail)
    await page.click('#btn-confirm')

    await expect(page.locator('.confirmation-title')).toHaveText('Booking Confirmed!')
    await expect(page.locator('#confirmation-details')).toContainText('30')
  })

  // ---------------------------------------------------------------------------
  // 13. Step indicator shows progress
  // ---------------------------------------------------------------------------
  test('step indicator is visible with step labels', async ({ page }) => {
    const host = await registerUser(page, 'BkStep')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    const stepIndicator = page.locator('#step-indicator')
    await expect(stepIndicator).toBeVisible()

    // Should contain step labels
    await expect(stepIndicator).toContainText('Select Time')

    // After selecting a slot the step indicator should update
    await openFirstAvailableSlot(page)
    await expect(stepIndicator).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 14. Calendar navigation
  // ---------------------------------------------------------------------------
  test('calendar navigation loads different month', async ({ page }) => {
    const host = await registerUser(page, 'BkNav')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()
    await expect(page.locator('#calendar')).toBeVisible()

    // Get the current month label text
    const monthLabelBefore = await page.locator('.calendar-month-label').textContent()

    // Click the forward nav button
    await page.locator('.calendar-nav-btn').last().click()
    await page.waitForTimeout(500)

    // Month label should change
    const monthLabelAfter = await page.locator('.calendar-month-label').textContent()
    expect(monthLabelAfter).not.toBe(monthLabelBefore)
  })

  // ---------------------------------------------------------------------------
  // 15. Selecting a day shows time slots panel
  // ---------------------------------------------------------------------------
  test('selecting a day shows time slots panel', async ({ page }) => {
    const host = await registerUser(page, 'BkPanel')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()

    // Time slots panel should be hidden initially
    await expect(page.locator('#time-slots-panel')).toBeHidden()

    // Click an available day
    for (let attempts = 0; attempts < 4; attempts++) {
      const availableDays = page.locator('.calendar-day.available')
      if (await availableDays.count()) {
        await availableDays.first().click()
        break
      }
      await page.locator('.calendar-nav-btn').last().click()
      await page.waitForTimeout(250)
    }

    // Time slots panel should now be visible with slots
    await expect(page.locator('#time-slots-panel')).toBeVisible()
    const slotCount = await page.locator('.time-slot').count()
    expect(slotCount).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // 16. Event list shows event cards
  // ---------------------------------------------------------------------------
  test('event list shows event cards with correct info', async ({ page }) => {
    const host = await registerUser(page, 'BkCards')
    const { eventName } = await createEventType(page, {
      name: `CardEvent ${uniqueId()}`,
      duration: '45',
    })
    const bookingLinkBase = await getBookingUrl(page)

    await page.goto(bookingLinkBase)
    await expect(page.locator('#event-list-view')).toBeVisible()

    // Event cards should be present
    const eventCards = page.locator('.event-card')
    const cardCount = await eventCards.count()
    expect(cardCount).toBeGreaterThan(0)

    // The created event should appear in the grid
    await expect(page.locator('#event-types-grid')).toContainText(eventName)
  })

  // ---------------------------------------------------------------------------
  // 17. Clicking event card navigates to booking view
  // ---------------------------------------------------------------------------
  test('clicking an event card from event list navigates to booking view', async ({ page }) => {
    const host = await registerUser(page, 'BkCardClick')
    const { eventName } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    // Go to event list (no ?event= param)
    await page.goto(bookingLinkBase)
    await expect(page.locator('#event-list-view')).toBeVisible()

    // Click the first event card
    await page.locator('.event-card').first().click()

    // Should now be in booking view with calendar
    await expect(page.locator('#booking-view')).toBeVisible()
    await expect(page.locator('#calendar')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 18. Unavailable days are not clickable
  // ---------------------------------------------------------------------------
  test('unavailable calendar days have unavailable class', async ({ page }) => {
    const host = await registerUser(page, 'BkUnavail')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()
    await expect(page.locator('#calendar')).toBeVisible()

    // Past days and weekend days should have the unavailable class
    const unavailableDays = page.locator('.calendar-day.unavailable')
    const unavailableCount = await unavailableDays.count()
    expect(unavailableCount).toBeGreaterThan(0)
  })
})
