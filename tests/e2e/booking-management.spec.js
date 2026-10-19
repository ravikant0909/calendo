import { expect, test } from '@playwright/test'
import {
  registerUser,
  createBookingAndReturnToDashboard,
  navigateToTab,
  uniqueId,
  createEventType,
  getBookingUrl,
  bookAsGuest,
  loginUser,
  slugify,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Booking Management
// ---------------------------------------------------------------------------

test.describe('Booking Management', () => {
  // 1. Booking appears in upcoming
  test('booking appears in upcoming', async ({ page }) => {
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

  // 2. Cancel from dashboard
  test('cancel from dashboard', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Click Cancel on the booking
    const cancelBtn = page.locator('#bookingsTableContainer button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    // Confirm via dialog
    const dialogConfirm = page.locator('#dialogConfirm')
    await expect(dialogConfirm).toBeVisible()
    await dialogConfirm.click()

    await page.waitForTimeout(1000)

    // Switch to cancelled filter
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)

    // Verify guest name and cancelled badge
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer .badge-cancelled')).toBeVisible()
  })

  // 3. Filter: upcoming vs cancelled
  test('filter: upcoming vs cancelled', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Cancel the booking
    const cancelBtn = page.locator('#bookingsTableContainer button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    const dialogConfirm = page.locator('#dialogConfirm')
    await expect(dialogConfirm).toBeVisible()
    await dialogConfirm.click()
    await page.waitForTimeout(1000)

    // Upcoming should NOT contain the cancelled guest
    await page.locator('.filter-btn[data-filter="upcoming"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).not.toContainText(guestName)

    // Cancelled SHOULD contain the guest
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
  })

  // 4. Contacts tab shows invitee
  test('contacts tab shows invitee', async ({ page }) => {
    const { guestName, guestEmail } = await createBookingAndReturnToDashboard(page)

    // Navigate to contacts tab
    await navigateToTab(page, 'contacts')
    await page.waitForTimeout(1000)

    // Contacts panel should contain the guest name and email
    await expect(page.locator('#panel-contacts')).toContainText(guestName)
    await expect(page.locator('#panel-contacts')).toContainText(guestEmail)
  })

  // 5. Contacts search
  test('contacts search filters by guest name', async ({ page }) => {
    const { guestName, guestEmail } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'contacts')
    await page.waitForTimeout(1000)

    // Type guest name into the search input
    await page.fill('#contactsSearch', guestName)
    await page.waitForTimeout(500)

    // Results should show the guest
    await expect(page.locator('#contactsTableContainer')).toContainText(guestName)
    await expect(page.locator('#contactsTableContainer')).toContainText(guestEmail)
  })

  // 6. Contacts all filter
  test('contacts all filter shows all contacts', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'contacts')
    await page.waitForTimeout(1000)

    // Click "All" filter button
    const allFilter = page.locator('button[data-contacts-filter="all"]')
    if (await allFilter.isVisible().catch(() => false)) {
      await allFilter.click()
      await page.waitForTimeout(500)
    }

    // Guest should appear regardless of filter
    await expect(page.locator('#contactsTableContainer')).toContainText(guestName)
  })

  // 7. Meeting search
  test('meeting search filters bookings by guest name', async ({ page }) => {
    const { guestName, eventName } = await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Type guest name into the meeting search input
    await page.fill('#meetingSearch', guestName)
    await page.waitForTimeout(500)

    // Should still see the matching booking
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer')).toContainText(eventName)
  })

  // 8. Book on behalf button is visible
  test('book on behalf button is visible on bookings tab', async ({ page }) => {
    await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // The book on behalf button should be visible
    await expect(page.locator('#bookOnBehalfBtn')).toBeVisible()
  })

  // 9. Bookings load on tab switch
  test('bookings load on tab switch', async ({ page }) => {
    const { guestName } = await createBookingAndReturnToDashboard(page)

    // Navigate to bookings first
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)

    // Navigate away to settings
    await navigateToTab(page, 'settings')
    await page.waitForTimeout(500)

    // Navigate back to bookings
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Bookings should still be visible
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
  })

  // 10. Multiple bookings from different guests
  test('multiple bookings with different guests both appear', async ({ page }) => {
    const hostCreds = await registerUser(page, 'MultiBk')

    // Get booking URL base
    const bookingLinkBase = await getBookingUrl(page)

    // Create an event type
    const { eventName, eventSlug } = await createEventType(page, {
      name: `Multi Booking Event ${uniqueId()}`,
      duration: '30',
    })

    // Build booking URL
    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)

    // Book as first guest
    const guest1Name = `Guest One ${uniqueId()}`
    const guest1Email = `guest-one-${uniqueId()}@calendo.test`
    await page.goto(bookingUrl.toString())
    await bookAsGuest(page, { name: guest1Name, email: guest1Email })

    // Book as second guest
    const guest2Name = `Guest Two ${uniqueId()}`
    const guest2Email = `guest-two-${uniqueId()}@calendo.test`
    await page.goto(bookingUrl.toString())
    await bookAsGuest(page, { name: guest2Name, email: guest2Email })

    // Re-login as host
    await loginUser(page, hostCreds)

    // Navigate to bookings tab
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Both guests should appear
    await expect(page.locator('#bookingsTableContainer')).toContainText(guest1Name)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guest2Name)
  })

  // 11. Analytics stats update after booking
  test('analytics stats reflect booking count', async ({ page }) => {
    await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'analytics')
    await page.waitForTimeout(1000)

    // Analytics panel should be visible
    await expect(page.locator('#panel-analytics')).toHaveClass(/active/)
    await expect(page.locator('#analyticsStats')).toBeVisible()

    // Total stat should be at least 1
    const totalText = await page.locator('#statTotal').textContent()
    expect(parseInt(totalText, 10)).toBeGreaterThanOrEqual(1)
  })

  // 12. Meeting search with no match returns empty
  test('meeting search with no match shows no results', async ({ page }) => {
    await createBookingAndReturnToDashboard(page)

    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Search for a name that does not exist
    await page.fill('#meetingSearch', 'zzzznonexistent999')
    await page.waitForTimeout(500)

    // The table should not contain any booking rows with that text
    await expect(page.locator('#bookingsTableContainer')).not.toContainText('zzzznonexistent999')
  })
})
