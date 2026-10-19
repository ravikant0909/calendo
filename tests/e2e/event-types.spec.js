import { test, expect } from '@playwright/test'
import { registerUser, navigateToTab, createEventType, uniqueId, getBookingUrl } from './helpers.js'

test.describe('Event Types', () => {

  test('4 default event types after registration', async ({ page }) => {
    await registerUser(page, 'ETDefaults')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })
    await expect(page.locator('#overviewEventTypes')).toContainText('30 Minute Meeting')
    await expect(page.locator('#overviewEventTypes')).toContainText('45 Minute Meeting')
    await expect(page.locator('#overviewEventTypes')).toContainText('60 Minute Deep Dive')
    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(4)
  })

  test('create event type', async ({ page }) => {
    await registerUser(page, 'ETCreate')
    const { eventName } = await createEventType(page, { name: `New Event ${uniqueId()}`, duration: '30' })
    await expect(page.locator('#overviewEventTypes')).toContainText(eventName)
    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(5)
  })

  test('create with custom duration 45 min', async ({ page }) => {
    await registerUser(page, 'ETDur45')
    const { eventName } = await createEventType(page, { name: `FortyFive ${uniqueId()}`, duration: '45' })
    await expect(page.locator('#overviewEventTypes')).toContainText(eventName)
    await expect(page.locator('#overviewEventTypes')).toContainText('45m')
  })

  test('edit event type name via modal', async ({ page }) => {
    await registerUser(page, 'ETEditName')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()

    const newName = `Renamed ${uniqueId()}`
    await page.fill('#editEtName', newName)
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await expect(page.locator('#overviewEventTypes')).toContainText(newName)
  })

  test('edit duration via modal', async ({ page }) => {
    await registerUser(page, 'ETEditDur')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()

    await page.selectOption('#editEtDuration', '90')
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await expect(page.locator('#overviewEventTypes')).toContainText('90m')
  })

  test('edit description via modal persists', async ({ page }) => {
    await registerUser(page, 'ETEditDesc')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()

    const desc = `Description ${uniqueId()}`
    await page.fill('#editEtDesc', desc)
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await expect(page.locator('#editEtDesc')).toHaveValue(desc)
  })

  test('toggle active/inactive', async ({ page }) => {
    await registerUser(page, 'ETToggle')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    // Click the toggle label (checkbox is hidden, styled as a slider)
    const toggle = page.locator('#overviewEventTypes .toggle-switch').first()
    await expect(toggle).toBeVisible()
    await toggle.click()
    await page.waitForTimeout(1000)
    await expect(page.locator('#overviewEventTypes')).toContainText('Off')

    // Toggle back
    await page.locator('#overviewEventTypes .toggle-switch').first().click()
    await page.waitForTimeout(1000)
  })

  test('delete event type via modal', async ({ page }) => {
    await registerUser(page, 'ETDelete')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })
    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(4)

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()

    const nameToDelete = await page.locator('#editEtName').inputValue()

    await page.click('#editEtDeleteBtn')
    await expect(page.locator('#dialogConfirm')).toBeVisible()
    await page.click('#dialogConfirm')
    await page.waitForTimeout(1500)

    await expect(page.locator('#overviewEventTypes')).not.toContainText(nameToDelete)
    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(3)
  })

  test('copy booking link', async ({ page }) => {
    await registerUser(page, 'ETCopy')
    await expect(page.locator('#overviewEventTypes')).toContainText('All Meeting Types', { timeout: 10000 })

    const copyBtns = page.locator('#overviewEventTypes button:has-text("Copy")')
    await expect(copyBtns.first()).toBeVisible()
    await copyBtns.first().click()
    await page.waitForTimeout(500)
  })

  test('create 2 extra event types', async ({ page }) => {
    await registerUser(page, 'ETMulti')
    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(4, { timeout: 10000 })

    await createEventType(page, { name: `Extra A ${uniqueId()}` })
    await createEventType(page, { name: `Extra B ${uniqueId()}` })

    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(6)
  })

  test('delete custom returns to 4 defaults', async ({ page }) => {
    await registerUser(page, 'ETDelCustom')

    const { eventName } = await createEventType(page, { name: `Custom ${uniqueId()}` })
    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(5)

    await page.locator('#overviewEventTypes button:has-text("Edit")').last().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.click('#editEtDeleteBtn')
    await expect(page.locator('#dialogConfirm')).toBeVisible()
    await page.click('#dialogConfirm')
    await page.waitForTimeout(1500)

    await expect(page.locator('#overviewEventTypes .toggle-switch')).toHaveCount(4)
  })

  test('set slot interval via modal', async ({ page }) => {
    await registerUser(page, 'ETSlot')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()

    // Expand "Limits & buffers" collapsible section
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtSlotInterval')).toBeVisible()

    await page.selectOption('#editEtSlotInterval', '30')
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtSlotInterval')).toHaveValue('30')
  })

  test('set buffer times via modal', async ({ page }) => {
    await registerUser(page, 'ETBuffer')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtBufferBefore')).toBeVisible()

    await page.fill('#editEtBufferBefore', '15')
    await page.fill('#editEtBufferAfter', '10')
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtBufferBefore')).toHaveValue('15')
    await expect(page.locator('#editEtBufferAfter')).toHaveValue('10')
  })

  test('set min notice via modal', async ({ page }) => {
    await registerUser(page, 'ETNotice')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtMinNotice')).toBeVisible()

    await page.fill('#editEtMinNotice', '120')
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtMinNotice')).toHaveValue('120')
  })

  test('set max per day via modal', async ({ page }) => {
    await registerUser(page, 'ETMaxDay')
    await expect(page.locator('#overviewEventTypes')).toContainText('15 Minute Chat', { timeout: 10000 })

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtMaxPerDay')).toBeVisible()

    await page.fill('#editEtMaxPerDay', '5')
    await page.click('#editEtSaveBtn')
    await page.waitForTimeout(1000)

    await page.locator('#overviewEventTypes button:has-text("Edit")').first().click()
    await expect(page.locator('#editEtPanel')).toBeVisible()
    await page.locator('#editEtPanel summary:has-text("Limits")').click()
    await expect(page.locator('#editEtMaxPerDay')).toHaveValue('5')
  })
})
