import { test, expect } from '@playwright/test'
import { registerUser, createBookingAndReturnToDashboard, navigateToTab } from './helpers.js'

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

test.describe('Analytics', () => {

  test('Analytics tab loads with stats, chart, and table', async ({ page }) => {
    await registerUser(page, 'Analytics')
    await navigateToTab(page, 'analytics')

    await expect(page.locator('#panel-analytics')).toBeVisible()
    await expect(page.locator('#analyticsStats')).toBeVisible()
    await expect(page.locator('#statTotal')).toBeVisible()
    await expect(page.locator('#volumeChart')).toBeVisible()
    await expect(page.locator('#eventTypeTable')).toBeVisible()
  })

  test('Analytics shows data after booking: statTotal >= 1', async ({ page }) => {
    await createBookingAndReturnToDashboard(page, { prefix: 'AnalyticsData' })

    await navigateToTab(page, 'analytics')
    await page.waitForTimeout(1000)

    // The total bookings stat should show at least 1
    const totalText = await page.locator('#statTotal').textContent()
    const totalNum = parseInt(totalText, 10)
    expect(totalNum).toBeGreaterThanOrEqual(1)

    // This month stat should also show at least 1
    const monthText = await page.locator('#statThisMonth').textContent()
    const monthNum = parseInt(monthText, 10)
    expect(monthNum).toBeGreaterThanOrEqual(1)
  })

  test('Export CSV button is visible on analytics tab', async ({ page }) => {
    await registerUser(page, 'AnalyticsCSV')
    await navigateToTab(page, 'analytics')

    await expect(page.locator('#exportCsvBtn')).toBeVisible()
  })

})

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

test.describe('Admin', () => {

  test('Admin page loads without crash', async ({ page }) => {
    await registerUser(page, 'AdminLoad')

    await page.goto('/admin/')
    await page.waitForTimeout(2000)

    // The page should load successfully and show either the admin dashboard
    // (#content) for admin users, or the access denied (#forbidden) for
    // non-admin users. Test users are not on the admin whitelist.
    const forbiddenVisible = await page.locator('#forbidden').isVisible()
    const contentVisible = await page.locator('#content').isVisible()

    // At least one should be visible (page loaded without crashing)
    expect(forbiddenVisible || contentVisible).toBe(true)
  })

  test('Admin page not accessible to regular users: shows access denied', async ({ page }) => {
    await registerUser(page, 'AdminDeny')

    await page.goto('/admin/')
    await page.waitForTimeout(2000)

    // Test users are not admins, so we expect the forbidden message
    await expect(page.locator('#forbidden')).toBeVisible()
    await expect(page.locator('#forbidden')).toContainText(/access denied/i)

    // The admin content should NOT be visible
    await expect(page.locator('#content')).not.toBeVisible()
  })

})
