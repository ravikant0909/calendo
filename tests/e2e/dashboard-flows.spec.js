import { expect, test } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers (inline — this file does NOT use helpers.js)
// ---------------------------------------------------------------------------

async function registerUser(page, unique) {
  const name = `Dashboard User ${unique}`
  const email = `dash-user-${unique}@calendo.test`
  const password = 'password123'

  await page.goto('/auth/register.html')
  await page.evaluate(() => localStorage.setItem('calendo_onboarding_done', 'true'))

  await page.fill('#name', name)
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.click('#submitBtn')
  await page.waitForURL('**/dashboard/')
  await expect(page.locator('#welcomeHeader')).toBeVisible({ timeout: 10000 })

  return { name, email, password }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('login and dashboard loads', async ({ page }) => {
  const unique = Date.now().toString()
  const creds = await registerUser(page, unique)

  await page.click('#logoutBtn')
  await page.waitForURL('**/auth/login**')

  await page.evaluate(() => localStorage.setItem('calendo_onboarding_done', 'true'))
  await page.fill('#email', creds.email)
  await page.fill('#password', creds.password)
  await page.click('#submitBtn')
  await page.waitForURL('**/dashboard/')

  await expect(page.locator('#welcomeHeader')).toContainText(creds.name)
})

test('4 default event types visible after registration', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  // Wait for overview to render event types (uses toContainText which auto-retries)
  await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })
  await expect(page.locator('#overviewEventTypes')).toContainText('30 Minute Meeting')
  await expect(page.locator('#overviewEventTypes')).toContainText('45 Minute Meeting')
  await expect(page.locator('#overviewEventTypes')).toContainText('60 Minute Deep Dive')
})

test('booking link is populated', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  // Wait for overview to render (booking link is in the first "All Meeting Types" row)
  await expect(page.locator('#overviewEventTypes')).toContainText('All Meeting Types', { timeout: 10000 })

  // #bookingLinkValue is hidden but has content
  const linkValue = await page.locator('#bookingLinkValue').textContent({ timeout: 5000 })
  expect(linkValue?.trim()).toBeTruthy()
  expect(linkValue?.trim()).toContain('/booking/')
})

test('edit event type via overview Edit button opens modal', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  // Overview Edit buttons call openEditModal() which opens #editEtPanel
  const editBtns = page.locator('#overviewEventTypes button:has-text("Edit")')
  await expect(editBtns.first()).toBeVisible()
  await editBtns.first().click()

  // Edit modal should open
  await expect(page.locator('#editEtPanel')).toBeVisible()

  // Change the name
  const newName = `Renamed Meeting ${unique}`
  await page.fill('#editEtName', newName)
  await page.click('#editEtSaveBtn')
  await page.waitForTimeout(1000)

  // Verify the overview now shows the new name
  await expect(page.locator('#overviewEventTypes')).toContainText(newName)
})

test('toggle active / inactive on overview', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

  // The checkbox is hidden (styled toggle) — use force:true to click, or click the label
  const toggle = page.locator('#overviewEventTypes .toggle-switch').first()
  await expect(toggle).toBeVisible()

  // Click the toggle label (which is visible, unlike the hidden checkbox)
  await toggle.click()
  await page.waitForTimeout(1000)

  await expect(page.locator('#overviewEventTypes')).toContainText('Off')

  // Toggle back on
  await page.locator('#overviewEventTypes .toggle-switch').first().click()
  await page.waitForTimeout(1000)
})

test('create new event type', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

  // Click "+ New" which opens the edit modal in create mode
  await page.click('#overviewCreateEtBtn')
  await expect(page.locator('#editEtPanel')).toBeVisible({ timeout: 5000 })

  const eventName = `Custom Event ${unique}`
  await page.fill('#editEtName', eventName)
  await page.selectOption('#editEtDuration', '45')
  await page.fill('#editEtDesc', 'E2E custom event test')
  await page.click('#editEtSaveBtn')

  await page.waitForTimeout(1500)

  await expect(page.locator('#overviewEventTypes')).toContainText(eventName, { timeout: 5000 })
})

test('delete event type via edit modal', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  // Wait for overview to load
  await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

  // Count initial event type names
  const initialText = await page.locator('#overviewEventTypes').textContent()
  expect(initialText).toContain('15 Minute Chat')

  // Open edit modal for first event type
  const editBtns = page.locator('#overviewEventTypes button:has-text("Edit")')
  await editBtns.first().click()
  await expect(page.locator('#editEtPanel')).toBeVisible()

  // Get the name we're about to delete
  const nameToDelete = await page.locator('#editEtName').inputValue()

  // Click Delete in the modal
  await page.click('#editEtDeleteBtn')

  // Confirm the dialog
  await expect(page.locator('#dialogConfirm')).toBeVisible()
  await page.click('#dialogConfirm')
  await page.waitForTimeout(1500)

  // The deleted name should no longer be on the overview
  await expect(page.locator('#overviewEventTypes')).not.toContainText(nameToDelete)
})

test('sidebar navigation between tabs', async ({ page }) => {
  const unique = Date.now().toString()
  await registerUser(page, unique)

  await expect(page.locator('#panel-overview')).toHaveClass(/active/)

  await page.locator('.sidebar-nav a[data-tab="bookings"]').click()
  await expect(page.locator('#panel-bookings')).toHaveClass(/active/)

  await page.locator('.sidebar-nav a[data-tab="settings"]').click()
  await expect(page.locator('#panel-settings')).toHaveClass(/active/)

  await page.locator('.sidebar-nav a[data-tab="analytics"]').click()
  await expect(page.locator('#panel-analytics')).toHaveClass(/active/)

  await page.locator('.sidebar-nav a[data-tab="overview"]').click()
  await expect(page.locator('#panel-overview')).toHaveClass(/active/)
})

test('settings page loads with user data', async ({ page }) => {
  const unique = Date.now().toString()
  const creds = await registerUser(page, unique)

  await page.locator('.sidebar-nav a[data-tab="settings"]').click()
  await expect(page.locator('#panel-settings')).toHaveClass(/active/)

  await expect(page.locator('#settingsDisplayName')).toHaveValue(creds.name)
  await expect(page.locator('#settingsSlug')).toBeVisible()

  const slugValue = await page.locator('#settingsSlug').inputValue()
  expect(slugValue.length).toBeGreaterThan(0)

  await expect(page.locator('#settingsSaveBtn')).toBeVisible()
})

test('welcome header shows user name', async ({ page }) => {
  const unique = Date.now().toString()
  const creds = await registerUser(page, unique)

  await expect(page.locator('#welcomeHeader')).toContainText(creds.name)
})
