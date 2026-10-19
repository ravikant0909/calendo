import { expect, test } from '@playwright/test'
import {
  registerUser,
  createEventType,
  createBookingAndReturnToDashboard,
  getBookingUrl,
  getConfirmationLinks,
  openFirstAvailableSlot,
  bookAsGuest,
  loginUser,
  navigateToTab,
  uniqueId,
} from './helpers.js'

test.describe('Cancel & Reschedule', () => {
  // ---------------------------------------------------------------------------
  // 1. Host cancel from dashboard
  // ---------------------------------------------------------------------------
  test('host can cancel a booking from the dashboard', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Click Cancel on the booking
    const cancelBtn = page.locator('.bookings-table button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    // Confirm via dialog
    await expect(page.locator('#confirmDialog')).toBeVisible()
    await page.locator('#dialogConfirm').click()
    await page.waitForTimeout(1000)

    // Switch to cancelled filter
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)

    // Verify guest name and cancelled badge
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer .badge-cancelled')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 2. Cancelled NOT in upcoming
  // ---------------------------------------------------------------------------
  test('cancelled booking does not appear in upcoming filter', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Cancel the booking
    const cancelBtn = page.locator('.bookings-table button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    await expect(page.locator('#confirmDialog')).toBeVisible()
    await page.locator('#dialogConfirm').click()
    await page.waitForTimeout(1000)

    // Switch to upcoming - guest should NOT be there
    await page.locator('.filter-btn[data-filter="upcoming"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).not.toContainText(guestName)
  })

  // ---------------------------------------------------------------------------
  // 3. Cancelled IS in cancelled filter
  // ---------------------------------------------------------------------------
  test('cancelled booking appears in cancelled filter with badge', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Cancel the booking
    const cancelBtn = page.locator('.bookings-table button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    await expect(page.locator('#confirmDialog')).toBeVisible()
    await page.locator('#dialogConfirm').click()
    await page.waitForTimeout(1000)

    // Switch to cancelled filter
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)

    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer .badge-cancelled')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 4. Booking in upcoming filter
  // ---------------------------------------------------------------------------
  test('new booking appears in upcoming filter with confirmed badge', async ({ page }) => {
    const { guestName, eventName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Upcoming filter should be active by default
    await expect(page.locator('.filter-btn[data-filter="upcoming"]')).toHaveClass(/active/)

    // Table should contain the guest name and event name
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer')).toContainText(eventName)

    // Confirmed badge visible
    await expect(page.locator('#bookingsTableContainer .badge-confirmed')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 5. Invitee cancel via token
  // ---------------------------------------------------------------------------
  test('invitee can cancel booking via cancel link', async ({ page }) => {
    const host = await registerUser(page, 'CancelToken')
    const { eventName, eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    // Get cancel link from confirmation page
    const { cancelHref } = await getConfirmationLinks(page)
    expect(cancelHref).toBeTruthy()

    // Navigate to cancel page
    await page.goto(cancelHref)

    // Cancel form should be visible
    await expect(page.locator('#cancel-form')).toBeVisible()

    // Click cancel button
    await page.click('#cancel-btn')

    // Success state should appear
    await expect(page.locator('#success-state')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 6. Cancel with reason
  // ---------------------------------------------------------------------------
  test('invitee can cancel with a reason', async ({ page }) => {
    const host = await registerUser(page, 'CancelReason')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const { cancelHref } = await getConfirmationLinks(page)
    await page.goto(cancelHref)

    await expect(page.locator('#cancel-form')).toBeVisible()

    // Fill reason textarea
    await page.fill('#reason', 'Something came up, need to reschedule for next week')

    // Click cancel button
    await page.click('#cancel-btn')

    // Success state should appear
    await expect(page.locator('#success-state')).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // 7. Reschedule via token
  // ---------------------------------------------------------------------------
  test('invitee can reschedule booking via reschedule link', async ({ page }) => {
    const host = await registerUser(page, 'Resched')
    const { eventName, eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const { rescheduleHref } = await getConfirmationLinks(page)
    expect(rescheduleHref).toBeTruthy()

    // Navigate to reschedule page
    await page.goto(rescheduleHref)

    // Reschedule UI should be visible
    await expect(page.locator('#reschedule-ui')).toBeVisible()

    // Current booking info should show event name
    await expect(page.locator('#current-booking-info')).toContainText(eventName)

    // Select a new time slot
    await openFirstAvailableSlot(page)

    // Click reschedule button
    await page.click('#btn-reschedule')

    // Success state should appear
    await expect(page.locator('#success-state')).toBeVisible()
    await expect(page.locator('.confirmation-title')).toContainText('Rescheduled')
  })

  // ---------------------------------------------------------------------------
  // 8. Cancel page shows booking details
  // ---------------------------------------------------------------------------
  test('cancel page shows event name, host name, and date/time', async ({ page }) => {
    const host = await registerUser(page, 'CancelDetails')
    const { eventName, eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const { cancelHref } = await getConfirmationLinks(page)
    await page.goto(cancelHref)

    await expect(page.locator('#cancel-form')).toBeVisible()

    // All booking detail fields should have content
    await expect(page.locator('#event-name')).not.toBeEmpty()
    await expect(page.locator('#host-name')).not.toBeEmpty()
    await expect(page.locator('#date-time')).not.toBeEmpty()

    // Event name should match the one we created
    await expect(page.locator('#event-name')).toContainText(eventName)
  })

  // ---------------------------------------------------------------------------
  // 9. Reschedule page shows current booking
  // ---------------------------------------------------------------------------
  test('reschedule page shows current event and datetime', async ({ page }) => {
    const host = await registerUser(page, 'ReschedInfo')
    const { eventName, eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const { rescheduleHref } = await getConfirmationLinks(page)
    await page.goto(rescheduleHref)

    await expect(page.locator('#reschedule-ui')).toBeVisible()

    // Current booking details should have content
    await expect(page.locator('#current-event')).not.toBeEmpty()
    await expect(page.locator('#current-datetime')).not.toBeEmpty()

    // Event name should match
    await expect(page.locator('#current-event')).toContainText(eventName)
  })

  // ---------------------------------------------------------------------------
  // 10. Filter switch works across upcoming/cancelled
  // ---------------------------------------------------------------------------
  test('filter toggle works: booking moves from upcoming to cancelled', async ({ page }) => {
    const { guestName, eventName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Verify booking is in upcoming
    await expect(page.locator('.filter-btn[data-filter="upcoming"]')).toHaveClass(/active/)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer')).toContainText(eventName)

    // Cancel the booking
    const cancelBtn = page.locator('.bookings-table button:has-text("Cancel")').first()
    await cancelBtn.click()
    await expect(page.locator('#confirmDialog')).toBeVisible()
    await page.locator('#dialogConfirm').click()
    await page.waitForTimeout(1000)

    // Upcoming should no longer contain the guest
    await page.locator('.filter-btn[data-filter="upcoming"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).not.toContainText(guestName)

    // Cancelled should contain the guest with badge
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer .badge-cancelled')).toBeVisible()

    // Past should not contain the guest (it was upcoming, not past)
    await page.locator('.filter-btn[data-filter="past"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).not.toContainText(guestName)
  })

  // ---------------------------------------------------------------------------
  // 11. Cancel page has reschedule-instead link
  // ---------------------------------------------------------------------------
  test('cancel page offers a reschedule-instead link', async ({ page }) => {
    const host = await registerUser(page, 'CancelResLink')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const { cancelHref } = await getConfirmationLinks(page)
    await page.goto(cancelHref)

    await expect(page.locator('#cancel-form')).toBeVisible()

    // There should be a "Reschedule instead" link
    const rescheduleLink = page.locator('#reschedule-link')
    await expect(rescheduleLink).toBeVisible()
    await expect(rescheduleLink).toContainText('Reschedule')

    // The link should point to the reschedule page
    const href = await rescheduleLink.getAttribute('href')
    expect(href).toContain('/booking/reschedule.html')
  })

  // ---------------------------------------------------------------------------
  // 12. Reschedule page shows calendar for new time selection
  // ---------------------------------------------------------------------------
  test('reschedule page shows calendar for new time selection', async ({ page }) => {
    const host = await registerUser(page, 'ReschedCal')
    const { eventSlug } = await createEventType(page)
    const bookingLinkBase = await getBookingUrl(page)

    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    await bookAsGuest(page)

    const { rescheduleHref } = await getConfirmationLinks(page)
    await page.goto(rescheduleHref)

    await expect(page.locator('#reschedule-ui')).toBeVisible()

    // Calendar should be visible
    await expect(page.locator('#calendar')).toBeVisible()

    // Available days should be present
    for (let attempts = 0; attempts < 4; attempts++) {
      const availableDays = page.locator('.calendar-day.available')
      if (await availableDays.count()) {
        // Click a day to see time slots
        await availableDays.first().click()
        const slotCount = await page.locator('.time-slot').count()
        expect(slotCount).toBeGreaterThan(0)
        return
      }
      await page.locator('.calendar-nav-btn').last().click()
      await page.waitForTimeout(250)
    }

    throw new Error('No available days found on reschedule calendar')
  })
})
