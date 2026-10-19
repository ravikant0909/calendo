import { expect, test } from '@playwright/test'
import {
  createEventTypeViaForm,
  navigateToTab,
  registerUser,
  uniqueId,
} from './helpers.js'

function futureDateTimeLocal(daysAhead = 1, hour = 10, minute = 0) {
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  date.setHours(hour, minute, 0, 0)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

test.describe('Settings And Integrations', () => {
  test('embed code tabs render distinct snippets and previews', async ({ page }) => {
    const host = await registerUser(page, 'EmbedCode')
    await navigateToTab(page, 'settings')

    await expect(page.locator('#embedCodeBlock')).toContainText('data-mode="inline"')
    await expect(page.locator('#embedPreview iframe')).toHaveAttribute('src', /embed=1/)

    await page.click('.embedTabBtn[data-embed="popup"]')
    await expect(page.locator('#embedCodeBlock')).toContainText('data-mode="popup"')
    await expect(page.locator('#embedPreview')).toContainText('Book a Meeting')

    await page.click('.embedTabBtn[data-embed="badge"]')
    await expect(page.locator('#embedCodeBlock')).toContainText('data-calendo-mode="badge"')
    await expect(page.locator('#embedCodeBlock')).toContainText(host.slug)
    await expect(page.locator('#embedPreview')).toContainText('Book a meeting')
  })

  test('Slack webhook save updates connected status and reveals test button', async ({ page }) => {
    await registerUser(page, 'SlackSave')
    await navigateToTab(page, 'settings')

    await page.fill('#slackWebhookUrl', 'https://hooks.slack.com/services/T123456/B123456/abc123')
    await page.click('#saveSlackWebhookBtn')

    await expect(page.locator('#slackConnectionStatus')).toHaveText('Connected', { timeout: 10000 })
    await expect(page.locator('#testSlackWebhookBtn')).toBeVisible()
    await expect(page.locator('#slackWebhookUrl')).toHaveValue(/hooks\.slack\.com/)
  })

  test('PayPal credentials can be saved and removed from settings', async ({ page }) => {
    await registerUser(page, 'PayPalSave')
    await navigateToTab(page, 'settings')

    await page.fill('#paypalClientId', `paypal-client-${uniqueId()}`)
    await page.fill('#paypalClientSecret', `paypal-secret-${uniqueId()}`)
    await page.selectOption('#paypalMode', 'live')
    await page.click('#savePayPalBtn')

    await expect(page.locator('#paypalConnectionStatus')).toHaveText('Connected (live)', { timeout: 10000 })
    await expect(page.locator('#removePayPalBtn')).toBeVisible()

    page.once('dialog', dialog => dialog.accept())
    await page.click('#removePayPalBtn')
    await expect(page.locator('#paypalConnectionStatus')).toHaveText('Not configured', { timeout: 10000 })
    await expect(page.locator('#removePayPalBtn')).toBeHidden()
  })

  test('new users see the email verification banner and can trigger resend', async ({ page }) => {
    await registerUser(page, 'VerifyBanner')

    await expect(page.locator('#emailVerificationBanner')).toBeVisible({ timeout: 10000 })
    await page.click('#resendVerificationBtn')
    await expect(page.locator('#resendVerificationBtn')).toHaveText('Resend Verification Email', { timeout: 10000 })
  })

  test('password reset request page submits successfully for an existing account', async ({ page }) => {
    const host = await registerUser(page, 'ResetReq')

    await page.goto('/auth/reset-password.html')
    await page.fill('#email', host.email)
    await page.click('#forgotBtn')

    await expect(page.locator('#success')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#success')).toContainText(/reset link|check your email/i)
  })

  test('activity log records new event creation and settings updates with filtering', async ({ page }) => {
    await registerUser(page, 'AuditLog')
    const eventName = `Audit Trail ${uniqueId()}`
    await createEventTypeViaForm(page, { name: eventName })

    await navigateToTab(page, 'settings')
    await page.fill('#settingsDisplayName', `Audit Host ${uniqueId()}`)
    await page.click('#settingsSaveBtn')
    await expect(page.locator('#settingsSaveBtn')).toHaveText('Save Changes', { timeout: 10000 })

    await page.selectOption('#auditActionFilter', 'event_type.created')
    await page.click('#refreshAuditLogBtn')
    await expect(page.locator('#auditLogBody')).toContainText('Event type created', { timeout: 10000 })
    await expect(page.locator('#auditLogBody')).toContainText(eventName)

    await page.selectOption('#auditActionFilter', 'settings.updated')
    await page.click('#refreshAuditLogBtn')
    await expect(page.locator('#auditLogBody')).toContainText('Settings updated', { timeout: 10000 })
  })

  test('book on behalf creates a booking that appears in meetings and calendar view', async ({ page }) => {
    await registerUser(page, 'BookBehalf')

    await navigateToTab(page, 'bookings')
    await page.click('#bookOnBehalfBtn')
    await expect(page.locator('#bookOnBehalfForm')).toBeVisible({ timeout: 5000 })

    const inviteeName = `Delegated Guest ${uniqueId()}`
    await page.selectOption('#bobEventType', { label: '30 Minute Meeting' })
    await page.fill('#bobStartTime', futureDateTimeLocal(1, 10, 0))
    await page.fill('#bobName', inviteeName)
    await page.fill('#bobEmail', `behalf-${uniqueId()}@calendo.test`)
    await page.fill('#bobNotes', 'Created by host from dashboard')
    await page.click('#bobSubmitBtn')

    await expect(page.locator('#bookingsTableContainer')).toContainText(inviteeName, { timeout: 10000 })

    await navigateToTab(page, 'calendar')
    await expect(page.locator('#calendarViewGrid')).toBeVisible()
    await expect(page.locator('#calendarViewGrid')).toContainText(inviteeName, { timeout: 10000 })
  })
})
