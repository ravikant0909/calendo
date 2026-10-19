import { expect, test } from '@playwright/test'
import { registerUser, navigateToTab, uniqueId, getBookingUrl } from './helpers.js'

test.describe('Availability', () => {
  // -----------------------------------------------------------------------
  // 1. Default schedule exists
  // -----------------------------------------------------------------------
  test('default schedule exists after registration', async ({ page }) => {
    await registerUser(page, 'AvailDefault')
    await navigateToTab(page, 'availability')

    const scheduleSelect = page.locator('#scheduleSelect')
    await expect(scheduleSelect).toBeVisible()
    await expect(scheduleSelect).toContainText('Working Hours')
  })

  // -----------------------------------------------------------------------
  // 2. Schedule has weekly rules
  // -----------------------------------------------------------------------
  test('weekly schedule editor visible with day rows', async ({ page }) => {
    await registerUser(page, 'AvailWeekly')
    await navigateToTab(page, 'availability')

    const editor = page.locator('#weeklyScheduleEditor')
    await expect(editor).toBeVisible()

    // 7 day rows (Mon-Sun)
    const dayRows = editor.locator('.avail-day-row')
    await expect(dayRows).toHaveCount(7)

    // Mon-Fri (1-5) should be checked
    for (const dayIndex of [1, 2, 3, 4, 5]) {
      await expect(editor.locator(`[data-day-toggle="${dayIndex}"]`)).toBeChecked()
    }

    // Sat (6) and Sun (0) should NOT be checked
    await expect(editor.locator('[data-day-toggle="6"]')).not.toBeChecked()
    await expect(editor.locator('[data-day-toggle="0"]')).not.toBeChecked()
  })

  // -----------------------------------------------------------------------
  // 3. Create new schedule
  // -----------------------------------------------------------------------
  test('create new schedule', async ({ page }) => {
    await registerUser(page, 'AvailCreate')
    await navigateToTab(page, 'availability')

    await page.click('#createScheduleBtn')

    const form = page.locator('#newScheduleForm')
    await expect(form).toBeVisible()

    const scheduleName = `Evening Hours ${uniqueId()}`
    await page.fill('#newScheduleName', scheduleName)
    await page.selectOption('#newScheduleTimezone', 'America/New_York')

    // Submit via the form's submit button
    await page.click('#scheduleCreateForm button[type="submit"]')
    await page.waitForTimeout(1000)

    // Verify the new schedule appears in the dropdown
    const scheduleSelect = page.locator('#scheduleSelect')
    await expect(scheduleSelect).toContainText(scheduleName)

    // The form should be hidden again
    await expect(form).not.toBeVisible()
  })

  // -----------------------------------------------------------------------
  // 4. Switch between schedules
  // -----------------------------------------------------------------------
  test('switch between schedules', async ({ page }) => {
    await registerUser(page, 'AvailSwitch')
    await navigateToTab(page, 'availability')

    // Create a second schedule
    await page.click('#createScheduleBtn')
    const scheduleName = `Switch Test ${uniqueId()}`
    await page.fill('#newScheduleName', scheduleName)
    await page.selectOption('#newScheduleTimezone', 'America/Chicago')
    await page.click('#scheduleCreateForm button[type="submit"]')
    await page.waitForTimeout(1000)

    // The new schedule should be selected
    const scheduleSelect = page.locator('#scheduleSelect')
    const selectedText = await scheduleSelect.locator('option:checked').textContent()
    expect(selectedText).toContain(scheduleName)

    // Switch back to "Working Hours"
    // Find the Working Hours option and select it by its value
    const options = scheduleSelect.locator('option')
    const optCount = await options.count()
    let workingHoursValue = ''
    for (let i = 0; i < optCount; i++) {
      const text = await options.nth(i).textContent()
      if (text.includes('Working Hours')) {
        workingHoursValue = await options.nth(i).getAttribute('value')
        break
      }
    }
    expect(workingHoursValue).toBeTruthy()
    await page.selectOption('#scheduleSelect', workingHoursValue)
    await page.waitForTimeout(500)

    // Verify Working Hours is now selected
    const newSelected = await scheduleSelect.locator('option:checked').textContent()
    expect(newSelected).toContain('Working Hours')
  })

  // -----------------------------------------------------------------------
  // 5. Delete non-default schedule
  // -----------------------------------------------------------------------
  test('delete non-default schedule', async ({ page }) => {
    await registerUser(page, 'AvailDelete')
    await navigateToTab(page, 'availability')

    // Create a schedule to delete
    await page.click('#createScheduleBtn')
    const scheduleName = `Delete Me ${uniqueId()}`
    await page.fill('#newScheduleName', scheduleName)
    await page.selectOption('#newScheduleTimezone', 'America/Chicago')
    await page.click('#scheduleCreateForm button[type="submit"]')
    await page.waitForTimeout(1000)

    await expect(page.locator('#scheduleSelect')).toContainText(scheduleName)

    // Delete button should be visible for non-default schedule
    const deleteBtn = page.locator('#deleteScheduleBtn')
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Confirm dialog
    await expect(page.locator('#confirmDialog')).toHaveClass(/active/)
    await page.click('#dialogConfirm')
    await page.waitForTimeout(1000)

    // Schedule should be gone from dropdown
    await expect(page.locator('#scheduleSelect')).not.toContainText(scheduleName)

    // Should fall back to Working Hours
    await expect(page.locator('#scheduleSelect')).toContainText('Working Hours')
  })

  // -----------------------------------------------------------------------
  // 6. Cannot delete default schedule
  // -----------------------------------------------------------------------
  test('cannot delete default schedule', async ({ page }) => {
    await registerUser(page, 'AvailNoDelDefault')
    await navigateToTab(page, 'availability')

    // Working Hours is selected by default — delete button should be hidden
    const deleteBtn = page.locator('#deleteScheduleBtn')
    await expect(deleteBtn).not.toBeVisible()
  })

  // -----------------------------------------------------------------------
  // 7. Booking page weekdays available
  // -----------------------------------------------------------------------
  test('booking page has available weekdays', async ({ page }) => {
    const creds = await registerUser(page, 'AvailBookWd')

    const bookingLinkText = await getBookingUrl(page)
    expect(bookingLinkText).toBeTruthy()

    // Navigate to booking page with a default event type
    const bookingUrl = new URL(bookingLinkText)
    bookingUrl.searchParams.set('event', '30-minute-meeting')
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()
    await page.waitForTimeout(1500)

    // There should be available days (weekdays)
    const availableDays = page.locator('.calendar-day.available')
    const availCount = await availableDays.count()
    expect(availCount).toBeGreaterThan(0)

    // Click an available day and verify time slots appear
    await availableDays.first().click()
    await expect(page.locator('.time-slot').first()).toBeVisible()
  })

  // -----------------------------------------------------------------------
  // 8. Booking page weekends unavailable
  // -----------------------------------------------------------------------
  test('booking page weekends are not available', async ({ page }) => {
    const creds = await registerUser(page, 'AvailBookWe')

    const bookingLinkText = await getBookingUrl(page)
    const bookingUrl = new URL(bookingLinkText)
    bookingUrl.searchParams.set('event', '30-minute-meeting')
    await page.goto(bookingUrl.toString())
    await expect(page.locator('#booking-view')).toBeVisible()
    await page.waitForTimeout(1500)

    // There should be unavailable days (weekends)
    const unavailableDays = page.locator('.calendar-day.unavailable')
    const unavailCount = await unavailableDays.count()
    expect(unavailCount).toBeGreaterThan(0)

    // Unavailable days should not have the .available class
    for (let i = 0; i < Math.min(unavailCount, 3); i++) {
      const classes = await unavailableDays.nth(i).getAttribute('class')
      expect(classes).not.toContain('available')
    }
  })

  // -----------------------------------------------------------------------
  // 9. Total weekly hours displayed
  // -----------------------------------------------------------------------
  test('total weekly hours shows 40', async ({ page }) => {
    await registerUser(page, 'AvailHours')
    await navigateToTab(page, 'availability')

    // Default schedule: Mon-Fri 9-5 = 8 hrs/day x 5 = 40 hrs/week
    await expect(page.locator('#totalWeeklyHours')).toContainText('40.0')
  })
})
