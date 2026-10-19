import { test, expect } from '@playwright/test'
import { registerUser, loginUser, logoutUser, uniqueId } from './helpers.js'

test.describe('Auth', () => {

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  test('Register happy path: register and land on dashboard with welcome header', async ({ page }) => {
    const creds = await registerUser(page, 'RegHappy')
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.locator('#welcomeHeader')).toBeVisible()
    await expect(page.locator('#welcomeHeader')).toContainText(creds.name)
  })

  test('Register: empty name shows error', async ({ page }) => {
    await page.goto('/auth/register.html')
    await page.evaluate(() => document.querySelector('#registerForm').setAttribute('novalidate', ''))

    const unique = uniqueId()
    await page.fill('#email', `empty-name-${unique}@calendo.test`)
    await page.fill('#password', 'TestPassword123')
    await page.click('#submitBtn')

    await expect(page.locator('#error')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#error')).toContainText(/name/i)
    await expect(page).toHaveURL(/\/auth\/register/)
  })

  test('Register: invalid email shows error', async ({ page }) => {
    await page.goto('/auth/register.html')
    await page.evaluate(() => document.querySelector('#registerForm').setAttribute('novalidate', ''))

    await page.fill('#name', 'Invalid Email User')
    await page.fill('#email', 'notanemail')
    await page.fill('#password', 'TestPassword123')
    await page.click('#submitBtn')

    await expect(page.locator('#error')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#error')).toContainText(/email/i)
    await expect(page).toHaveURL(/\/auth\/register/)
  })

  test('Register: short password shows error about 8 characters', async ({ page }) => {
    await page.goto('/auth/register.html')
    await page.evaluate(() => document.querySelector('#registerForm').setAttribute('novalidate', ''))

    const unique = uniqueId()
    await page.fill('#name', 'Short Pass User')
    await page.fill('#email', `short-pass-${unique}@calendo.test`)
    await page.fill('#password', 'abc')
    await page.click('#submitBtn')

    await expect(page.locator('#error')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#error')).toContainText(/8/i)
    await expect(page).toHaveURL(/\/auth\/register/)
  })

  test('Register: duplicate email shows "already" error', async ({ page }) => {
    const creds = await registerUser(page, 'Dup')

    await page.goto('/auth/register.html')
    await page.fill('#name', 'Duplicate User')
    await page.fill('#email', creds.email)
    await page.fill('#password', 'TestPassword123')
    await page.click('#submitBtn')

    await expect(page.locator('#error')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#error')).toContainText(/already/i)
    await expect(page).toHaveURL(/\/auth\/register/)
  })

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  test('Login happy path: register, logout, login, dashboard shows name', async ({ page }) => {
    const creds = await registerUser(page, 'Login')
    await logoutUser(page)

    await loginUser(page, creds)
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.locator('#welcomeHeader')).toBeVisible()
    await expect(page.locator('#welcomeHeader')).toContainText(creds.name)
  })

  test('Login: wrong password shows error and stays on login page', async ({ page }) => {
    const creds = await registerUser(page, 'WrongPw')
    await logoutUser(page)

    await page.goto('/auth/login.html')
    await page.fill('#email', creds.email)
    await page.fill('#password', 'CompletelyWrongPassword999')
    await page.click('#submitBtn')

    await expect(page.locator('#error')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('#error')).not.toBeEmpty()
    await expect(page).toHaveURL(/\/auth\/login/)
  })

  // -------------------------------------------------------------------------
  // Logout / session
  // -------------------------------------------------------------------------

  test('Logout redirects to login page', async ({ page }) => {
    await registerUser(page, 'LogoutRedir')
    await logoutUser(page)

    await expect(page).toHaveURL(/\/auth\/login/)
  })

  test('Session cleared after logout: dashboard redirects to login', async ({ page }) => {
    await registerUser(page, 'SessionClr')
    await logoutUser(page)

    await page.goto('/dashboard/')
    await expect(page).toHaveURL(/\/auth\/login/)
  })

  // -------------------------------------------------------------------------
  // OAuth buttons
  // -------------------------------------------------------------------------

  test('Register form shows OAuth buttons for Google and Microsoft', async ({ page }) => {
    await page.goto('/auth/register.html')

    const googleBtn = page.locator('.oauth-google')
    const microsoftBtn = page.locator('.oauth-microsoft')

    const googleCount = await googleBtn.count()
    const microsoftCount = await microsoftBtn.count()
    expect(googleCount).toBeGreaterThanOrEqual(1)
    expect(microsoftCount).toBeGreaterThanOrEqual(1)
  })

})
