import { test, expect } from '@playwright/test'
import { registerUser, navigateToTab, getBookingUrl, uniqueId } from './helpers.js'

test.describe('Settings', () => {

  test('Edit display name persists after reload', async ({ page }) => {
    const creds = await registerUser(page, 'SetName')
    await navigateToTab(page, 'settings')

    const newName = `Updated Name ${uniqueId()}`
    await page.fill('#settingsDisplayName', newName)
    await page.click('#settingsSaveBtn')

    // Wait for save to complete
    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    // Navigate back to settings after reload
    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsDisplayName')).toHaveValue(newName)
  })

  test('Edit slug updates booking link', async ({ page }) => {
    await registerUser(page, 'SetSlug')
    await navigateToTab(page, 'settings')

    const newSlug = `test-slug-${uniqueId()}`
    await page.fill('#settingsSlug', newSlug)
    await page.click('#settingsSaveBtn')

    // Wait for save to complete
    await page.waitForTimeout(1000)

    // Navigate to overview to see booking link
    await navigateToTab(page, 'overview')
    await expect(page.locator('#bookingLinkValue')).toBeAttached({ timeout: 5000 })
    const bookingLink = await page.locator('#bookingLinkValue').textContent()
    expect(bookingLink).toContain(newSlug)
  })

  test('Edit bio persists after reload', async ({ page }) => {
    await registerUser(page, 'SetBio')
    await navigateToTab(page, 'settings')

    const newBio = `This is my bio ${uniqueId()}`
    await page.fill('#settingsBio', newBio)
    await page.click('#settingsSaveBtn')

    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsBio')).toHaveValue(newBio)
  })

  test('Change brand color persists after reload', async ({ page }) => {
    await registerUser(page, 'SetColor')
    await navigateToTab(page, 'settings')

    await page.fill('#settingsBrandColorText', '#ff5500')
    await page.click('#settingsSaveBtn')

    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsBrandColorText')).toHaveValue('#ff5500')
  })

  test('Set cancellation policy persists after reload', async ({ page }) => {
    await registerUser(page, 'SetCancel')
    await navigateToTab(page, 'settings')

    const policy = 'Cancellations must be made at least 24 hours in advance.'
    await page.fill('#settingsCancellationPolicy', policy)
    await page.click('#settingsSaveBtn')

    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsCancellationPolicy')).toHaveValue(policy)
  })

  test('Booking page reflects updated display name', async ({ page }) => {
    await registerUser(page, 'SetBooking')
    await navigateToTab(page, 'settings')

    const newName = `Booking Name ${uniqueId()}`
    await page.fill('#settingsDisplayName', newName)
    await page.click('#settingsSaveBtn')
    await page.waitForTimeout(1000)

    // Navigate to overview to get booking URL
    await navigateToTab(page, 'overview')
    const bookingUrl = await getBookingUrl(page)

    // Visit the public booking page
    await page.goto(bookingUrl)
    await expect(page.locator('#host-name')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#host-name')).toContainText(newName)
  })

  test('Settings page loads all key sections', async ({ page }) => {
    await registerUser(page, 'SetSections')
    await navigateToTab(page, 'settings')

    await expect(page.locator('#settingsForm')).toBeVisible()
    await expect(page.locator('#createApiKeyBtn')).toBeVisible()
    await expect(page.locator('#deleteAccountBtn')).toBeVisible()
  })

  test('API key create flow: form, fill, submit, modal shows key', async ({ page }) => {
    await registerUser(page, 'SetApiKey')
    await navigateToTab(page, 'settings')

    // Click the create button to show the form
    await page.click('#createApiKeyBtn')
    await expect(page.locator('#apiKeyCreateForm')).toBeVisible({ timeout: 3000 })

    // Fill in a name and submit
    const keyName = `Test Key ${uniqueId()}`
    await page.fill('#apiKeyNameInput', keyName)
    await page.click('#apiKeyCreateSubmit')

    // The modal should appear with the full key value
    await expect(page.locator('#apiKeyModal')).toBeVisible({ timeout: 5000 })
    const keyValue = await page.locator('#apiKeyFullValue').inputValue()
    expect(keyValue.length).toBeGreaterThan(0)

    // Close the modal (click outside or press escape)
    await page.keyboard.press('Escape')
  })

  test('API key delete: create then delete via confirm dialog', async ({ page }) => {
    await registerUser(page, 'SetApiDel')
    await navigateToTab(page, 'settings')

    // Create an API key first
    await page.click('#createApiKeyBtn')
    await expect(page.locator('#apiKeyCreateForm')).toBeVisible({ timeout: 3000 })

    const keyName = `Delete Key ${uniqueId()}`
    await page.fill('#apiKeyNameInput', keyName)
    await page.click('#apiKeyCreateSubmit')

    await expect(page.locator('#apiKeyModal')).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Find the delete button in the API keys list
    const deleteBtn = page.locator('#apiKeysList button').filter({ hasText: /delete|revoke|remove/i }).first()
    // If no text-labeled button, try a generic delete icon button
    const deleteBtnAlt = page.locator('#apiKeysList .btn-delete, #apiKeysList button[title*="delete" i], #apiKeysList button[title*="revoke" i]').first()

    const hasDeleteBtn = await deleteBtn.count() > 0
    const hasDeleteBtnAlt = await deleteBtnAlt.count() > 0

    if (hasDeleteBtn) {
      await deleteBtn.click()
    } else if (hasDeleteBtnAlt) {
      await deleteBtnAlt.click()
    } else {
      // Click the first button inside the key's row
      await page.locator('#apiKeysList button').first().click()
    }

    // Confirm via the dialog
    await expect(page.locator('#confirmDialog')).toBeVisible({ timeout: 3000 })
    await page.click('#dialogConfirm')

    // Key should be removed from the list
    await page.waitForTimeout(500)
    await expect(page.locator('#apiKeysList')).not.toContainText(keyName)
  })

  test('Blocked emails persists after reload', async ({ page }) => {
    await registerUser(page, 'SetBlocked')
    await navigateToTab(page, 'settings')

    await page.fill('#settingsBlockedEmails', 'spam.com')
    await page.click('#settingsSaveBtn')

    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsBlockedEmails')).toHaveValue(/spam\.com/)
  })

  test('Set logo URL persists after reload', async ({ page }) => {
    await registerUser(page, 'SetLogo')
    await navigateToTab(page, 'settings')

    const logoUrl = 'https://example.com/logo.png'
    await page.fill('#settingsLogoUrl', logoUrl)
    await page.click('#settingsSaveBtn')

    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsLogoUrl')).toHaveValue(logoUrl)
  })

  test('GA and Meta tracking IDs persist after reload', async ({ page }) => {
    await registerUser(page, 'SetTracking')
    await navigateToTab(page, 'settings')

    const gaId = 'G-TEST123456'
    const metaId = '9876543210'
    await page.fill('#settingsGaMeasurementId', gaId)
    await page.fill('#settingsMetaPixelId', metaId)
    await page.click('#settingsSaveBtn')

    await page.waitForTimeout(1000)
    await page.reload()
    await page.waitForTimeout(1000)

    await navigateToTab(page, 'settings')
    await expect(page.locator('#settingsGaMeasurementId')).toHaveValue(gaId)
    await expect(page.locator('#settingsMetaPixelId')).toHaveValue(metaId)
  })

})
