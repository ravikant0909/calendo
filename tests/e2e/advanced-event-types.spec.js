import { expect, test } from '@playwright/test'
import {
  createEventTypeViaForm,
  getBookingUrl,
  gotoBookingPage,
  navigateToTab,
  openEventTypeEditModal,
  openFirstAvailableSlot,
  registerUser,
  setCheckbox,
  uniqueId,
  waitForDashboard,
} from './helpers.js'

async function openModalSection(page, label) {
  const summary = page.locator('#editEtPanel summary').filter({ hasText: label }).first()
  await expect(summary).toBeVisible({ timeout: 5000 })
  const details = summary.locator('xpath=ancestor::details[1]')
  const isOpen = await details.evaluate((el) => el.open)
  if (!isOpen) {
    await summary.click()
  }
}

test.describe('Advanced Event Types', () => {
  test('secret event stays hidden from public event list but works via direct link', async ({ page }) => {
    await registerUser(page, 'SecretET')
    const bookingBase = await getBookingUrl(page)

    const eventName = `Invite Only ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, {
      name: eventName,
      description: 'Private strategy session',
      isSecret: true,
    })

    await page.goto(bookingBase)
    await expect(page.locator('#event-list-view')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#event-types-grid')).not.toContainText(eventName)

    await gotoBookingPage(page, bookingBase, eventSlug)
    await expect(page.locator('#booking-view')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#sidebar-event-name')).toContainText(eventName)
  })

  test('guest-enabled event accepts extra guests and host sees guest count', async ({ page }) => {
    await registerUser(page, 'GuestFlow')
    const bookingBase = await getBookingUrl(page)

    const eventName = `Guests Welcome ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, {
      name: eventName,
      description: 'Bring teammates',
      allowGuests: true,
    })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await openFirstAvailableSlot(page)

    await expect(page.locator('#guests-section')).toBeVisible()
    await page.click('#add-guest-btn')
    await page.click('#add-guest-btn')
    await page.locator('.guest-email-input').nth(0).fill(`guest-a-${uniqueId()}@calendo.test`)
    await page.locator('.guest-email-input').nth(1).fill(`guest-b-${uniqueId()}@calendo.test`)

    await page.fill('#input-name', `Primary Guest ${uniqueId()}`)
    await page.fill('#input-email', `primary-${uniqueId()}@calendo.test`)
    await page.click('#btn-confirm')

    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })

    await page.goto('/dashboard/')
    await waitForDashboard(page)
    await navigateToTab(page, 'bookings')
    await expect(page.locator('#bookingsTableContainer')).toContainText('+2 guests', { timeout: 10000 })
  })

  test('guest-disabled event hides the guest section on booking form', async ({ page }) => {
    await registerUser(page, 'NoGuests')
    const bookingBase = await getBookingUrl(page)

    const { eventSlug } = await createEventTypeViaForm(page, {
      name: `Solo Only ${uniqueId()}`,
      allowGuests: false,
    })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await openFirstAvailableSlot(page)

    await expect(page.locator('#guests-section')).toBeHidden()
  })

  test('locked timezone disables timezone switching for invitees', async ({ page }) => {
    await registerUser(page, 'LockedTz')
    const bookingBase = await getBookingUrl(page)

    const eventName = `Locked TZ ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, { name: eventName })

    await openEventTypeEditModal(page, eventName)
    await openModalSection(page, 'Limits')
    await page.selectOption('#editEtLockedTz', 'America/New_York')
    await page.click('#editEtSaveBtn')
    await expect(page.locator('#editEtPanel')).toBeHidden({ timeout: 10000 })

    await gotoBookingPage(page, bookingBase, eventSlug)
    const tzSelect = page.locator('#timezone-select')
    await expect(tzSelect).toBeDisabled()
    await expect(tzSelect).toHaveValue('America/New_York')
    await expect(tzSelect.locator('option')).toHaveText(/locked/i)
  })

  test('conditional booking questions show and validate only when triggered', async ({ page }) => {
    await registerUser(page, 'CondQs')
    const bookingBase = await getBookingUrl(page)

    const eventName = `Conditional Questions ${uniqueId()}`
    const { eventSlug } = await createEventTypeViaForm(page, { name: eventName })

    await openEventTypeEditModal(page, eventName)
    await openModalSection(page, 'Booking questions')

    const addBtn = page.locator('#editEtPanel button').filter({ hasText: '+ Add question' })
    await addBtn.click()
    await page.locator('#editEtQuestionsList > div').nth(0).locator('input[placeholder="Question label"]').fill('Company type')
    await setCheckbox(page.locator('#editEtQuestionsList > div').nth(0), 'input[type="checkbox"]', true)

    await addBtn.click()
    const secondRow = page.locator('#editEtQuestionsList > div').nth(1)
    await secondRow.locator('input[placeholder="Question label"]').fill('Budget')
    await setCheckbox(secondRow, 'input[type="checkbox"]', true)
    await secondRow.locator('select').nth(1).selectOption('0')

    const rerenderedSecondRow = page.locator('#editEtQuestionsList > div').nth(1)
    await rerenderedSecondRow.locator('input[placeholder="answer"]').fill('Enterprise')

    await page.click('#editEtSaveBtn')
    await expect(page.locator('#editEtPanel')).toBeHidden({ timeout: 10000 })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await openFirstAvailableSlot(page)

    const questionInputs = page.locator('#custom-questions [data-question-id]')
    await questionInputs.nth(0).fill('Startup')
    const budgetGroup = page.locator('#custom-questions .form-group').filter({ has: page.locator('label', { hasText: 'Budget' }) })
    await expect(budgetGroup).toBeHidden()

    await questionInputs.nth(0).fill('Enterprise')
    await expect(budgetGroup).toBeVisible()

    await page.fill('#input-name', `Questions Guest ${uniqueId()}`)
    await page.fill('#input-email', `questions-${uniqueId()}@calendo.test`)
    const budgetInput = budgetGroup.locator('[data-question-id]')
    await page.click('#btn-confirm')
    await expect(budgetInput).toBeFocused()
    expect(await budgetInput.evaluate((el) => !el.checkValidity())).toBe(true)

    await budgetInput.fill('Over $50k')
    await page.click('#btn-confirm')
    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })
  })

  test('phone meetings require an invitee phone number before booking', async ({ page }) => {
    await registerUser(page, 'PhoneET')
    const bookingBase = await getBookingUrl(page)

    const { eventSlug } = await createEventTypeViaForm(page, {
      name: `Phone Screen ${uniqueId()}`,
      locationType: 'phone',
      locationValue: '+1 (555) 010-2000',
    })

    await gotoBookingPage(page, bookingBase, eventSlug)
    await openFirstAvailableSlot(page)

    await expect(page.locator('#phone-field-group')).toBeVisible()
    await page.fill('#input-name', `Phone Guest ${uniqueId()}`)
    await page.fill('#input-email', `phone-${uniqueId()}@calendo.test`)
    await page.click('#btn-confirm')
    await expect(page.locator('#input-phone')).toBeFocused()
    expect(await page.locator('#input-phone').evaluate((el) => !el.checkValidity())).toBe(true)

    await page.fill('#input-phone', '+1 555 200 3000')
    await page.click('#btn-confirm')
    await expect(page.locator('.confirmation-title')).toContainText('Booking Confirmed', { timeout: 10000 })
    await expect(page.locator('#confirmation-meeting-link')).toContainText('Phone call')
  })

  test('reminder settings and reconfirmation choices persist in the edit modal', async ({ page }) => {
    await registerUser(page, 'ReminderET')

    const eventName = `Reminder Options ${uniqueId()}`
    await createEventTypeViaForm(page, { name: eventName })

    await openEventTypeEditModal(page, eventName)
    await openModalSection(page, 'Limits')

    await setCheckbox(page, '#editEtRemEmail24', false)
    await setCheckbox(page, '#editEtRemEmail1', false)
    await setCheckbox(page, '#editEtRemSms24', true)
    await page.selectOption('#editEtReconfirmation', '24')
    await page.click('#editEtSaveBtn')
    await expect(page.locator('#editEtPanel')).toBeHidden({ timeout: 10000 })

    await openEventTypeEditModal(page, eventName)
    await openModalSection(page, 'Limits')
    await expect(page.locator('#editEtRemEmail24')).not.toBeChecked()
    await expect(page.locator('#editEtRemEmail1')).not.toBeChecked()
    await expect(page.locator('#editEtRemSms24')).toBeChecked()
    await expect(page.locator('#editEtReconfirmation')).toHaveValue('24')
  })
})
