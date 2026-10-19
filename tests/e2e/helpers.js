import { expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function uniqueId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 6)
}

// ---------------------------------------------------------------------------
// Auth Helpers
// ---------------------------------------------------------------------------

/**
 * Skip the onboarding wizard by setting localStorage.
 * Must be called after navigating to any page on the domain.
 */
async function skipOnboarding(page) {
  await page.evaluate(() => {
    localStorage.setItem('calendo_onboarding_done', 'true')
  })
}

/**
 * Wait for the dashboard to fully load after login/register/reload.
 * Handles the onboarding wizard by skipping it and reloading.
 */
export async function waitForDashboard(page) {
  await page.waitForURL('**/dashboard/**')

  // Check if onboarding wizard appeared
  const onboarding = page.locator('#calendarOnboarding')
  const appLayout = page.locator('#appLayout')

  // Give dashboard a moment to decide what to show
  await page.waitForTimeout(500)

  const onboardingVisible = await onboarding.isVisible().catch(() => false)
  if (onboardingVisible) {
    // Skip onboarding and reload
    await skipOnboarding(page)
    await page.reload()
    await page.waitForTimeout(500)
  }

  // Now wait for the actual dashboard
  await expect(appLayout).toBeVisible({ timeout: 10000 })
  await expect(page.locator('#welcomeHeader')).toBeVisible({ timeout: 10000 })

  // Wait for initial data to load (event types, bookings)
  await page.waitForTimeout(500)
}

/**
 * Register a brand-new user and land on the dashboard.
 * Returns { name, email, password, slug, unique }.
 */
export async function registerUser(page, prefix = 'E2E') {
  const unique = uniqueId()
  const name = `${prefix} User ${unique}`
  const email = `${prefix.toLowerCase()}-${unique}@calendo.test`
  const password = 'TestPassword123'

  await page.goto('/auth/register.html')

  // Set onboarding skip before form submission triggers redirect
  await skipOnboarding(page)

  await page.fill('#name', name)
  await page.fill('#email', email)
  await page.fill('#password', password)

  // Retry registration if rate-limited by local dev server
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click('#submitBtn')

    // Check if we got redirected to dashboard or stayed on register (error)
    const result = await Promise.race([
      page.waitForURL('**/dashboard/**', { timeout: 10000 }).then(() => 'dashboard'),
      page.locator('#error').filter({ hasText: /too many|rate/i }).waitFor({ timeout: 10000 }).then(() => 'ratelimit'),
    ]).catch(() => 'timeout')

    if (result === 'dashboard') break
    if (result === 'ratelimit' && attempt < 2) {
      // Wait and retry
      await page.waitForTimeout(5000)
      await page.locator('#error').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
      continue
    }
    // On last attempt, just try waitForDashboard
    await waitForDashboard(page)
  }

  // Ensure dashboard is fully loaded
  const appLayout = page.locator('#appLayout')
  await expect(appLayout).toBeVisible({ timeout: 10000 })
  await expect(page.locator('#welcomeHeader')).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(500)

  // Read the booking slug — #bookingLinkValue exists but may be hidden,
  // so just read its textContent directly (it has the URL even when hidden)
  const bookingLink = await page.locator('#bookingLinkValue').textContent({ timeout: 5000 })
  const slug = bookingLink?.trim()?.split('user=')[1] || ''

  return { name, email, password, slug, unique }
}

/**
 * Login with existing credentials and land on dashboard.
 */
export async function loginUser(page, creds) {
  await page.goto('/auth/login.html')

  // Set onboarding skip
  await skipOnboarding(page)

  await page.fill('#email', creds.email)
  await page.fill('#password', creds.password)
  await page.click('#submitBtn')

  await waitForDashboard(page)
}

/**
 * Logout from the dashboard.
 */
export async function logoutUser(page) {
  await page.click('#logoutBtn')
  await page.waitForURL('**/auth/login**')
}

// ---------------------------------------------------------------------------
// Dashboard Navigation
// ---------------------------------------------------------------------------

/**
 * Navigate to a sidebar tab by its data-tab attribute.
 * Valid tabs: overview, bookings, calendar, analytics, availability,
 *             routing-forms, contacts, settings, event-types
 */
export async function navigateToTab(page, tabName) {
  // Ensure sidebar is loaded and visible before clicking
  const link = page.locator(`.sidebar-nav a[data-tab="${tabName}"]`)
  await expect(link).toBeVisible({ timeout: 10000 })
  await link.click()
  // event-types panel ID matches the tab name
  const panelId = `#panel-${tabName}`
  await expect(page.locator(panelId)).toHaveClass(/active/, { timeout: 5000 })
}

/**
 * Get the booking page base URL from the dashboard.
 */
export async function getBookingUrl(page) {
  // #bookingLinkValue exists but may be hidden — read textContent directly
  const text = await page.locator('#bookingLinkValue').textContent({ timeout: 5000 })
  return text?.trim() || ''
}

// Navigate to a host's public booking page for a specific event, with optional
// extra query params (e.g. utm_*). `bookingBase` is the URL from getBookingUrl().
export async function gotoBookingPage(page, bookingBase, eventSlug, extraParams = {}) {
  const url = new URL(bookingBase, 'http://127.0.0.1:8787')
  if (eventSlug) url.searchParams.set('event', eventSlug)
  for (const [k, v] of Object.entries(extraParams || {})) url.searchParams.set(k, String(v))
  await page.goto(url.toString())
}

// ---------------------------------------------------------------------------
// Event Type Helpers
// ---------------------------------------------------------------------------

/**
 * Create a new event type from the Event Types tab.
 * Returns { eventName, eventSlug }.
 */
export async function createEventType(page, opts = {}) {
  const unique = opts.unique || uniqueId()
  const eventName = opts.name || `Test Event ${unique}`
  const eventSlug = slugify(eventName)
  const duration = opts.duration || '30'
  const description = opts.description || 'E2E test event'

  // Ensure overview is showing and loaded
  await expect(page.locator('#overviewEventTypes')).toContainText('Minute', { timeout: 10000 })

  // Click "+ New" which opens the edit modal in "create" mode
  await page.click('#overviewCreateEtBtn')
  await expect(page.locator('#editEtPanel')).toBeVisible({ timeout: 5000 })

  // Fill the create form (reuses edit modal fields)
  await page.fill('#editEtName', eventName)
  await page.selectOption('#editEtDuration', duration)
  if (description) {
    await page.fill('#editEtDesc', description)
  }

  // Click "Create" (the save button says "Create" in create mode)
  await page.click('#editEtSaveBtn')

  // Wait for creation and overview to re-render
  await page.waitForTimeout(1500)

  // Verify it appears on the overview
  await expect(page.locator('#overviewEventTypes')).toContainText(eventName, { timeout: 10000 })

  return { eventName, eventSlug }
}

// Alias: several specs import `createEventTypeViaForm`. It's the same UI flow.
export const createEventTypeViaForm = createEventType

// Open the edit modal for an existing event type by name (clicks its Edit button).
export async function openEventTypeEditModal(page, eventName) {
  const card = page.locator('.et-card').filter({ hasText: eventName }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.getByRole('button', { name: /edit/i }).first().click()
  await expect(page.locator('#editEtPanel')).toBeVisible({ timeout: 5000 })
}

// Set a checkbox to the desired state. `root` may be a Page or a Locator.
export async function setCheckbox(root, selector, checked) {
  const cb = root.locator(selector)
  const current = await cb.isChecked().catch(() => null)
  if (current === checked) return
  await cb.setChecked(checked, { force: true }).catch(async () => {
    await cb.click({ force: true })
  })
}

// ---------------------------------------------------------------------------
// Booking Helpers
// ---------------------------------------------------------------------------

/**
 * On a booking page calendar view, find and click the first available time slot.
 * Navigates forward through months if needed (up to 6 attempts).
 */
export async function openFirstAvailableSlot(page) {
  for (let attempts = 0; attempts < 6; attempts++) {
    const availableDays = page.locator('.calendar-day.available')
    const count = await availableDays.count()
    if (count > 0) {
      await availableDays.first().click()
      await page.waitForTimeout(300)
      const slots = page.locator('.time-slot')
      await expect(slots.first()).toBeVisible({ timeout: 5000 })
      await slots.first().click()
      return
    }

    // Navigate to next month
    await page.locator('.calendar-nav-btn').last().click()
    await page.waitForTimeout(500)
  }

  throw new Error('No available booking slots found in 6 calendar pages')
}

/**
 * Complete a booking as a guest on the public booking page.
 * Assumes page is already on the booking URL with an event selected.
 * Returns { name, email }.
 */
export async function bookAsGuest(page, guestInfo = {}) {
  const unique = uniqueId()
  const name = guestInfo.name || `Guest ${unique}`
  const email = guestInfo.email || `guest-${unique}@calendo.test`

  await expect(page.locator('#booking-view')).toBeVisible({ timeout: 10000 })
  await openFirstAvailableSlot(page)

  // Wait for confirm form
  await expect(page.locator('#input-name')).toBeVisible({ timeout: 5000 })

  await page.fill('#input-name', name)
  await page.fill('#input-email', email)

  // Fill phone if present and requested
  if (guestInfo.phone) {
    const phoneField = page.locator('#input-phone')
    if (await phoneField.isVisible().catch(() => false)) {
      await phoneField.fill(guestInfo.phone)
    }
  }

  await page.click('#btn-confirm')
  await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })

  return { name, email }
}

/**
 * Full flow: register host → create event type → book as guest → re-login as host.
 * Returns { hostCreds, eventName, eventSlug, guestName, guestEmail, bookingUrl }.
 */
export async function createBookingAndReturnToDashboard(page, opts = {}) {
  const prefix = opts.prefix || 'Booking'
  const hostCreds = await registerUser(page, prefix)

  // Get booking URL
  const bookingLinkBase = await getBookingUrl(page)

  // Create an event type
  const { eventName, eventSlug } = await createEventType(page, {
    name: opts.eventName,
    duration: opts.duration || '30',
  })

  // Build booking URL
  const bookingUrl = new URL(bookingLinkBase)
  bookingUrl.searchParams.set('event', eventSlug)

  // Navigate to booking page and book as guest
  await page.goto(bookingUrl.toString())
  const { name: guestName, email: guestEmail } = await bookAsGuest(page, opts.guest)

  // Re-login as host
  await loginUser(page, hostCreds)

  return { hostCreds, eventName, eventSlug, guestName, guestEmail, bookingUrl: bookingUrl.toString() }
}

/**
 * Get cancel and reschedule links from the booking confirmation page.
 * Must be called while on the confirmation page.
 * Returns { cancelHref, rescheduleHref }.
 */
export async function getConfirmationLinks(page) {
  await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })

  const cancelLink = page.locator('#confirmation-manage a:has-text("Cancel")')
  const rescheduleLink = page.locator('#confirmation-manage a:has-text("Reschedule")')

  const cancelHref = await cancelLink.getAttribute('href').catch(() => null)
  const rescheduleHref = await rescheduleLink.getAttribute('href').catch(() => null)

  return { cancelHref, rescheduleHref }
}
