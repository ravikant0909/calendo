import { expect, test } from '@playwright/test'
import {
  registerUser,
  loginUser,
  logoutUser,
  navigateToTab,
  createEventType,
  getBookingUrl,
  openFirstAvailableSlot,
  bookAsGuest,
  createBookingAndReturnToDashboard,
  uniqueId,
  slugify,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Full Lifecycle Tests — long chain integration flows
// ---------------------------------------------------------------------------

test.describe('Full Lifecycle', () => {
  // -------------------------------------------------------------------------
  // 1. Complete lifecycle: register → create → book → verify → cancel → analytics → contacts
  // -------------------------------------------------------------------------
  test('complete lifecycle from registration through cancellation', async ({ page }) => {
    // Step 1: Register a new host user
    const hostCreds = await registerUser(page, 'Lifecycle')

    // Step 2: Verify dashboard loaded and overview shows default event types
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat')
    await expect(page.locator('#overviewEventTypes')).toContainText('30 Minute Meeting')

    // Step 3: Create a custom event type
    const eventName = `Lifecycle Event ${uniqueId()}`
    const eventSlug = slugify(eventName)
    const { eventName: createdName } = await createEventType(page, { name: eventName, duration: '30' })

    // Step 4: Verify it appears in event types list
    await expect(page.locator('#overviewEventTypes')).toContainText(createdName)

    // Step 5: Set availability (navigate to availability tab, verify it loads)
    await navigateToTab(page, 'availability')
    await expect(page.locator('#panel-availability')).toHaveClass(/active/)

    // Step 6: Get booking URL
    await navigateToTab(page, 'overview')
    const bookingLinkBase = await getBookingUrl(page)
    expect(bookingLinkBase).toBeTruthy()

    // Step 7: Navigate to booking page as guest
    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)
    await page.goto(bookingUrl.toString())

    // Step 8: Verify booking view shows
    await expect(page.locator('#booking-view')).toBeVisible()

    // Step 9: Book as guest
    const guestName = `Lifecycle Guest ${uniqueId()}`
    const guestEmail = `lifecycle-guest-${uniqueId()}@calendo.test`
    await openFirstAvailableSlot(page)
    await page.fill('#input-name', guestName)
    await page.fill('#input-email', guestEmail)
    await page.click('#btn-confirm')

    // Step 10: Verify confirmation
    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed')

    // Step 11: Re-login as host
    await loginUser(page, hostCreds)

    // Step 12: Navigate to bookings tab
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    // Step 13: Verify booking in upcoming
    await expect(page.locator('.filter-btn[data-filter="upcoming"]')).toHaveClass(/active/)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer')).toContainText(createdName)
    await expect(page.locator('#bookingsTableContainer .badge-confirmed')).toBeVisible()

    // Step 14: Cancel the booking
    const cancelBtn = page.locator('#bookingsTableContainer button:has-text("Cancel")').first()
    await cancelBtn.click()
    const dialogConfirm = page.locator('#dialogConfirm')
    await expect(dialogConfirm).toBeVisible()
    await dialogConfirm.click()
    await page.waitForTimeout(1000)

    // Step 15: Verify in cancelled
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
    await expect(page.locator('#bookingsTableContainer .badge-cancelled')).toBeVisible()

    // Step 16: Check analytics — total should be >= 1
    await navigateToTab(page, 'analytics')
    await page.waitForTimeout(1000)
    await expect(page.locator('#analyticsStats')).toBeVisible()
    const totalText = await page.locator('#statTotal').textContent()
    expect(parseInt(totalText, 10)).toBeGreaterThanOrEqual(1)

    // Step 17: Check contacts — guest should appear
    await navigateToTab(page, 'contacts')
    await page.waitForTimeout(1000)
    await expect(page.locator('#panel-contacts')).toContainText(guestName)
    await expect(page.locator('#panel-contacts')).toContainText(guestEmail)
  })

  // -------------------------------------------------------------------------
  // 2. Multi-user isolation — two users see only their own data
  // -------------------------------------------------------------------------
  test('multi-user isolation: users see only their own data', async ({ browser }) => {
    // Create two separate browser contexts
    const context1 = await browser.newContext()
    const context2 = await browser.newContext()
    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    try {
      // Register user 1
      const user1 = await registerUser(page1, 'IsoUser1')
      const event1Name = `User1 Event ${uniqueId()}`
      await createEventType(page1, { name: event1Name })

      // Register user 2
      const user2 = await registerUser(page2, 'IsoUser2')
      const event2Name = `User2 Event ${uniqueId()}`
      await createEventType(page2, { name: event2Name })

      // User 1 should see their event but not user 2's
      await navigateToTab(page1, 'overview')
      await page1.waitForTimeout(500)
      await expect(page1.locator('#overviewEventTypes')).toContainText(event1Name)
      await expect(page1.locator('#overviewEventTypes')).not.toContainText(event2Name)

      // User 2 should see their event but not user 1's
      await navigateToTab(page2, 'overview')
      await page2.waitForTimeout(500)
      await expect(page2.locator('#overviewEventTypes')).toContainText(event2Name)
      await expect(page2.locator('#overviewEventTypes')).not.toContainText(event1Name)
    } finally {
      await context1.close()
      await context2.close()
    }
  })

  // -------------------------------------------------------------------------
  // 3. Settings → booking page roundtrip
  // -------------------------------------------------------------------------
  test('settings update reflects on public booking page', async ({ page }) => {
    const hostCreds = await registerUser(page, 'SettingsRT')

    // Navigate to settings
    await navigateToTab(page, 'settings')
    await page.waitForTimeout(500)

    // Update display name
    const newName = `Updated Host ${uniqueId()}`
    await page.fill('#settingsDisplayName', newName)

    // Update bio if field exists
    const bioField = page.locator('#settingsBio')
    const bioVisible = await bioField.isVisible().catch(() => false)
    let newBio = ''
    if (bioVisible) {
      newBio = `Bio text ${uniqueId()}`
      await bioField.fill(newBio)
    }

    // Save settings
    await page.click('#settingsSaveBtn')
    await page.waitForTimeout(1000)

    // Navigate to overview to get booking URL
    await navigateToTab(page, 'overview')
    const bookingUrl = await getBookingUrl(page)

    // Visit public booking page
    await page.goto(bookingUrl)
    await page.waitForTimeout(1000)

    // Host name should reflect updated name
    await expect(page.locator('#host-name')).toContainText(newName)
  })

  // -------------------------------------------------------------------------
  // 4. Event type lifecycle: create → edit → disable → re-enable → delete
  // -------------------------------------------------------------------------
  test('event type lifecycle: create, edit, disable, re-enable, delete', async ({ page }) => {
    await registerUser(page, 'ETLife')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    // Create a new event type
    const originalName = `Lifecycle ET ${uniqueId()}`
    await createEventType(page, { name: originalName, duration: '30' })
    await expect(page.locator('#overviewEventTypes')).toContainText(originalName)

    // Edit via modal — click Edit on the last event (our new one)
    await page.locator('#overviewEventTypes button:has-text("Edit")').last().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()

    const renamedName = `Renamed ET ${uniqueId()}`
    await page.fill('#editEtName', renamedName)
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    // Verify renamed
    await expect(page.locator('#overviewEventTypes')).toContainText(renamedName)
    await expect(page.locator('#overviewEventTypes')).not.toContainText(originalName)

    // Disable via toggle (last toggle = our event)
    const toggles = page.locator('#overviewEventTypes .toggle-switch')
    await toggles.last().click()
    await page.waitForTimeout(1000)
    await expect(page.locator('#overviewEventTypes')).toContainText('Off')

    // Re-enable
    await page.locator('#overviewEventTypes .toggle-switch').last().click()
    await page.waitForTimeout(1000)

    // Delete via modal
    await page.locator('#overviewEventTypes button:has-text("Edit")').last().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.click('#editEtDeleteBtn')
    await expect(page.locator('#dialogConfirm')).toBeVisible()
    await page.click('#dialogConfirm')
    await page.waitForTimeout(1500)

    // Verify deleted
    await expect(page.locator('#overviewEventTypes')).not.toContainText(renamedName)
  })

  // -------------------------------------------------------------------------
  // 5. Booking + cancel + re-book
  // -------------------------------------------------------------------------
  test('book, cancel via dashboard, re-book same event', async ({ page }) => {
    const hostCreds = await registerUser(page, 'ReBk')

    // Create event type
    const { eventName, eventSlug } = await createEventType(page, {
      name: `ReBook Event ${uniqueId()}`,
      duration: '30',
    })

    // Get booking URL
    const bookingLinkBase = await getBookingUrl(page)
    const bookingUrl = new URL(bookingLinkBase)
    bookingUrl.searchParams.set('event', eventSlug)

    // First booking
    const guest1Name = `First Guest ${uniqueId()}`
    const guest1Email = `first-guest-${uniqueId()}@calendo.test`
    await page.goto(bookingUrl.toString())
    await bookAsGuest(page, { name: guest1Name, email: guest1Email })

    // Re-login as host and cancel the booking
    await loginUser(page, hostCreds)
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)

    const cancelBtn = page.locator('#bookingsTableContainer button:has-text("Cancel")').first()
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()

    const dialogConfirm = page.locator('#dialogConfirm')
    await expect(dialogConfirm).toBeVisible()
    await dialogConfirm.click()
    await page.waitForTimeout(1000)

    // Second booking with a different guest
    const guest2Name = `Second Guest ${uniqueId()}`
    const guest2Email = `second-guest-${uniqueId()}@calendo.test`
    await page.goto(bookingUrl.toString())
    await bookAsGuest(page, { name: guest2Name, email: guest2Email })

    // Re-login as host
    await loginUser(page, hostCreds)

    // Check upcoming has the second booking (confirmed)
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)
    await expect(page.locator('.filter-btn[data-filter="upcoming"]')).toHaveClass(/active/)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guest2Name)
    await expect(page.locator('#bookingsTableContainer .badge-confirmed')).toBeVisible()

    // Check cancelled has the first booking
    await page.locator('.filter-btn[data-filter="cancelled"]').click()
    await page.waitForTimeout(500)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guest1Name)
    await expect(page.locator('#bookingsTableContainer .badge-cancelled')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // 6. Logout and re-login preserves data
  // -------------------------------------------------------------------------
  test('logout and re-login preserves event types and bookings', async ({ page }) => {
    const { hostCreds, eventName, guestName } = await createBookingAndReturnToDashboard(page, {
      prefix: 'Persist',
    })

    // Verify booking is present
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)

    // Logout
    await logoutUser(page)

    // Re-login
    await loginUser(page, hostCreds)

    // Verify event type still exists
    await navigateToTab(page, 'overview')
    await page.waitForTimeout(500)
    await expect(page.locator('#overviewEventTypes')).toContainText(eventName)

    // Verify booking still exists
    await navigateToTab(page, 'bookings')
    await page.waitForTimeout(1000)
    await expect(page.locator('#bookingsTableContainer')).toContainText(guestName)
  })
})
