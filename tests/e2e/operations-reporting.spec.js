import { expect, test } from '@playwright/test'
import {
  createBookingAndReturnToDashboard,
  navigateToTab,
  registerUser,
  uniqueId,
} from './helpers.js'

function futureDateTimeLocal(daysAhead = 1, hour = 11, minute = 0) {
  const date = new Date()
  date.setDate(date.getDate() + daysAhead)
  date.setHours(hour, minute, 0, 0)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

test.describe('Operations And Reporting', () => {
  test('email sequence can be created, paused, resumed, and deleted', async ({ page }) => {
    await registerUser(page, 'SeqCrud')
    await navigateToTab(page, 'settings')

    const subject = `Reminder ${uniqueId()}`
    await page.click('#createSequenceBtn')
    await expect(page.locator('#sequenceCreateForm')).toBeVisible({ timeout: 5000 })
    await page.selectOption('#seqTrigger', 'before_meeting')
    await page.fill('#seqDelay', '60')
    await page.fill('#seqSubject', subject)
    await page.fill('#seqBody', 'Hi {{invitee_name}}, this is your reminder.')
    await page.click('#seqSubmitBtn')

    await expect(page.locator('#sequencesList')).toContainText(subject, { timeout: 10000 })
    await expect(page.locator('#sequencesList')).toContainText('Active')

    await page.locator('#sequencesList button:has-text("Pause")').first().click()
    await expect(page.locator('#sequencesList')).toContainText('Paused', { timeout: 10000 })

    await page.locator('#sequencesList button:has-text("Resume")').first().click()
    await expect(page.locator('#sequencesList')).toContainText('Active', { timeout: 10000 })

    await page.locator('#sequencesList button:has-text("Delete")').first().click()
    await expect(page.locator('#sequencesList')).not.toContainText(subject, { timeout: 10000 })
  })

  test('BYOK setting can be saved and removed', async ({ page }) => {
    await registerUser(page, 'ByokCrud')
    await navigateToTab(page, 'settings')

    await page.fill('#byokKeyInput', `sk-ant-test-${uniqueId()}`)
    await page.click('#byokSaveBtn')
    await expect(page.locator('#byokStatus')).toHaveText('Your own API key is active.', { timeout: 10000 })

    await page.click('#byokRemoveBtn')
    await expect(page.locator('#byokStatus')).toHaveText('Using shared API key.', { timeout: 10000 })
  })

  test('analytics CSV export includes a freshly created booking', async ({ page }) => {
    const { guestName, guestEmail, eventName } = await createBookingAndReturnToDashboard(page, { prefix: 'CsvExport' })

    const csv = await page.evaluate(async () => {
      const res = await fetch('/api/analytics/export?format=csv&range=30d')
      return await res.text()
    })

    expect(csv).toContain('Invitee Name')
    expect(csv).toContain(guestName)
    expect(csv).toContain(guestEmail)
    expect(csv).toContain(eventName)
  })

  test('analytics CSV export escapes commas and quotes in invitee names', async ({ page }) => {
    await registerUser(page, 'CsvEscape')
    await navigateToTab(page, 'bookings')

    await page.click('#bookOnBehalfBtn')
    await expect(page.locator('#bookOnBehalfForm')).toBeVisible({ timeout: 5000 })

    const trickyName = `Comma, "Quote" ${uniqueId()}`
    await page.selectOption('#bobEventType', { label: '30 Minute Meeting' })
    await page.fill('#bobStartTime', futureDateTimeLocal(1, 11, 0))
    await page.fill('#bobName', trickyName)
    await page.fill('#bobEmail', `csv-escape-${uniqueId()}@calendo.test`)
    await page.click('#bobSubmitBtn')
    await expect(page.locator('#bookingsTableContainer')).toContainText(trickyName, { timeout: 10000 })

    const csv = await page.evaluate(async () => {
      const res = await fetch('/api/analytics/export?format=csv&range=30d')
      return await res.text()
    })

    expect(csv).toContain(`"Comma, ""Quote""`)
  })
})
