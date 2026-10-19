import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const persistPath = path.join(repoRoot, '.wrangler', 'smoke-local')
const baseUrl = process.env.CALENDO_SMOKE_BASE_URL || 'http://127.0.0.1:8787'
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const cookieJar = new Map()

function assert(condition, message, details = null) {
  if (!condition) {
    const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : ''
    throw new Error(`${message}${suffix}`)
  }
}

function logStep(message, details = null) {
  if (details) {
    console.log(`[smoke] ${message}`, details)
    return
  }
  console.log(`[smoke] ${message}`)
}

function storeCookies(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []

  if (setCookies.length === 0) {
    const singleHeader = response.headers.get('set-cookie')
    if (singleHeader) {
      setCookies.push(singleHeader)
    }
  }

  for (const cookie of setCookies) {
    const [nameValue] = cookie.split(';')
    const separator = nameValue.indexOf('=')
    if (separator === -1) continue
    const name = nameValue.slice(0, separator).trim()
    const value = nameValue.slice(separator + 1).trim()
    cookieJar.set(name, value)
  }
}

function getCookieHeader() {
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

async function requestJson(pathname, { method = 'GET', json, headers = {} } = {}) {
  const requestHeaders = { ...headers }
  const cookieHeader = getCookieHeader()
  if (cookieHeader) {
    requestHeaders.Cookie = cookieHeader
  }

  let body
  if (json !== undefined) {
    requestHeaders['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  }

  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: requestHeaders,
    body,
  })

  storeCookies(response)

  const text = await response.text()
  let parsed = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  return {
    status: response.status,
    body: parsed,
    headers: response.headers,
  }
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok || response.status < 500) {
        return
      }
      lastError = new Error(`Unexpected status: ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(1000)
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`)
}

function nextRangeStart() {
  const today = new Date()
  today.setUTCDate(today.getUTCDate() + 1)
  return today.toISOString().slice(0, 10)
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function toIsoUtc(dateStr, timeStr) {
  return `${dateStr}T${timeStr}:00Z`
}

function pickFirstSlot(slots, exclude = null) {
  for (const dateKey of Object.keys(slots).sort()) {
    const times = [...(slots[dateKey] || [])].sort()
    for (const time of times) {
      if (!exclude || exclude.date !== dateKey || exclude.time !== time) {
        return { date: dateKey, time }
      }
    }
  }
  return null
}

async function prepareDb() {
  const result = spawn(process.execPath, ['./scripts/prepare-local-db.mjs', persistPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })

  await new Promise((resolve, reject) => {
    result.on('error', reject)
    result.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`prepare-local-db exited with code ${code}`))
    })
  })
}

function startServer() {
  const child = spawn(
    npxCommand,
    ['wrangler', 'dev', '--local', '--persist-to', persistPath, '--ip', '127.0.0.1', '--port', '8787', '--log-level', 'error', '--env-file', './scripts/local-test.env'],
    {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  let serverLog = ''
  child.stdout.on('data', (chunk) => {
    serverLog += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    serverLog += chunk.toString()
  })

  return {
    child,
    getLogs() {
      return serverLog.trim()
    },
  }
}

function signalServer(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to signaling the direct child when the group is gone already.
    }
  }

  child.kill(signal)
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }

  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs, false),
  ])
}

async function main() {
  await prepareDb()

  const server = startServer()
  try {
    await waitForServer(baseUrl)
    logStep('local worker is ready')

    const unique = Date.now()
    const hostEmail = `host-${unique}@calendo.test`
    const hostName = `Smoke Host ${unique}`
    const freeInviteeEmail = `free-${unique}@calendo.test`
    const freeInvitee2Email = `free-second-${unique}@calendo.test`
    const paidInviteeEmail = `paid-${unique}@calendo.test`

    const register = await requestJson('/api/auth/register', {
      method: 'POST',
      json: {
        name: hostName,
        email: hostEmail,
        password: 'password123',
        timezone: 'UTC',
      },
    })
    assert(register.status === 201, 'expected registration to succeed', register)
    const bookingSlug = register.body?.bookingSlug
    assert(bookingSlug, 'expected registration to return bookingSlug', register.body)
    logStep('registered host user', { bookingSlug })

    const schedules = await requestJson('/api/availability-schedules')
    assert(schedules.status === 200, 'expected availability schedule list to succeed', schedules)
    const defaultSchedule = schedules.body?.[0]
    assert(defaultSchedule?.id, 'expected default availability schedule', schedules.body)

    const updatedSchedule = await requestJson(`/api/availability-schedules/${defaultSchedule.id}`, {
      method: 'PUT',
      json: {
        timezone: 'UTC',
        rules: [
          { day: 1, start: '09:00', end: '17:00' },
          { day: 2, start: '09:00', end: '17:00' },
          { day: 3, start: '09:00', end: '17:00' },
          { day: 4, start: '09:00', end: '17:00' },
          { day: 5, start: '09:00', end: '17:00' },
        ],
        overrides: [],
      },
    })
    assert(updatedSchedule.status === 200, 'expected schedule update to succeed', updatedSchedule)
    logStep('normalized default availability schedule to UTC weekdays')

    const freeEventName = `Smoke Free ${unique}`
    const freeEvent = await requestJson('/api/event-types', {
      method: 'POST',
      json: {
        name: freeEventName,
        duration_minutes: 30,
        description: 'Launch quality free booking smoke test',
        location_type: 'phone',
        min_notice_hours: 0,
        max_future_days: 30,
      },
    })
    assert(freeEvent.status === 201, 'expected free event creation to succeed', freeEvent)

    const paidEventName = `Smoke Paid ${unique}`
    const paidEvent = await requestJson('/api/event-types', {
      method: 'POST',
      json: {
        name: paidEventName,
        duration_minutes: 30,
        description: 'Launch quality paid booking smoke test',
        location_type: 'phone',
        min_notice_hours: 0,
        max_future_days: 30,
        price_cents: 5000,
        currency: 'usd',
      },
    })
    assert(paidEvent.status === 201, 'expected paid event creation to succeed', paidEvent)
    logStep('created free and paid event types', {
      freeEventSlug: freeEvent.body?.slug,
      paidEventSlug: paidEvent.body?.slug,
    })

    const publicPage = await requestJson(`/api/booking-page/${bookingSlug}`)
    assert(publicPage.status === 200, 'expected public booking page lookup to succeed', publicPage)
    assert(Array.isArray(publicPage.body?.eventTypes), 'expected public booking page eventTypes', publicPage.body)
    assert(publicPage.body.eventTypes.length >= 2, 'expected public booking page to include created event types', publicPage.body)
    logStep('verified public booking page metadata')

    const start = nextRangeStart()
    const end = addDays(start, 14)

    const freeAvailability = await requestJson(
      `/api/availability/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(freeEvent.body.slug)}?start=${start}&end=${end}&timezone=UTC`
    )
    assert(freeAvailability.status === 200, 'expected free availability lookup to succeed', freeAvailability)
    const firstFreeSlot = pickFirstSlot(freeAvailability.body?.slots || {})
    assert(firstFreeSlot, 'expected at least one free slot for smoke test', freeAvailability.body)
    logStep('picked first free slot', firstFreeSlot)

    const freeBooking = await requestJson(`/api/book/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(freeEvent.body.slug)}`, {
      method: 'POST',
      json: {
        name: 'Smoke Invitee',
        email: freeInviteeEmail,
        timezone: 'UTC',
        start_time: toIsoUtc(firstFreeSlot.date, firstFreeSlot.time),
      },
    })
    assert(freeBooking.status === 201, 'expected free booking creation to succeed', freeBooking)
    assert(freeBooking.body?.booking?.status === 'confirmed', 'expected free booking to be confirmed', freeBooking.body)
    const freeCancelToken = freeBooking.body.booking.cancel_token
    assert(freeCancelToken, 'expected free booking cancel token', freeBooking.body)
    logStep('created free booking', { status: freeBooking.body.booking.status })

    const cancelBooking = await requestJson(`/api/bookings/cancel-by-token/${encodeURIComponent(freeCancelToken)}`, {
      method: 'POST',
      json: { reason: 'Smoke test cancellation' },
    })
    assert(cancelBooking.status === 200, 'expected invitee cancellation to succeed', cancelBooking)
    logStep('cancelled free booking by token')

    const freeAvailabilityAfterCancel = await requestJson(
      `/api/availability/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(freeEvent.body.slug)}?start=${start}&end=${end}&timezone=UTC`
    )
    assert(freeAvailabilityAfterCancel.status === 200, 'expected availability lookup after cancellation to succeed', freeAvailabilityAfterCancel)
    assert(
      (freeAvailabilityAfterCancel.body?.slots?.[firstFreeSlot.date] || []).includes(firstFreeSlot.time),
      'expected cancelled slot to become available again',
      freeAvailabilityAfterCancel.body
    )
    logStep('verified cancelled slot returned to availability')

    const freeBookingForReschedule = await requestJson(`/api/book/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(freeEvent.body.slug)}`, {
      method: 'POST',
      json: {
        name: 'Smoke Invitee Again',
        email: freeInvitee2Email,
        timezone: 'UTC',
        start_time: toIsoUtc(firstFreeSlot.date, firstFreeSlot.time),
      },
    })
    assert(freeBookingForReschedule.status === 201, 'expected second free booking creation to succeed', freeBookingForReschedule)
    const rescheduleToken = freeBookingForReschedule.body?.booking?.cancel_token
    assert(rescheduleToken, 'expected reschedule booking cancel token', freeBookingForReschedule.body)

    const secondFreeSlot = pickFirstSlot(freeAvailabilityAfterCancel.body?.slots || {}, firstFreeSlot)
    assert(secondFreeSlot, 'expected a second free slot for reschedule coverage', freeAvailabilityAfterCancel.body)

    const rescheduled = await requestJson(`/api/bookings/reschedule-by-token/${encodeURIComponent(rescheduleToken)}`, {
      method: 'POST',
      json: {
        new_start_time: toIsoUtc(secondFreeSlot.date, secondFreeSlot.time),
        timezone: 'UTC',
      },
    })
    assert(rescheduled.status === 201, 'expected invitee reschedule to succeed', rescheduled)
    assert(rescheduled.body?.booking?.status === 'confirmed', 'expected rescheduled booking to remain confirmed', rescheduled.body)
    logStep('rescheduled booking by token', secondFreeSlot)

    const paidAvailability = await requestJson(
      `/api/availability/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(paidEvent.body.slug)}?start=${start}&end=${end}&timezone=UTC`
    )
    assert(paidAvailability.status === 200, 'expected paid availability lookup to succeed', paidAvailability)
    const paidSlot = pickFirstSlot(paidAvailability.body?.slots || {})
    assert(paidSlot, 'expected at least one paid slot for smoke test', paidAvailability.body)
    logStep('picked first paid slot', paidSlot)

    const paidBooking = await requestJson(`/api/book/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(paidEvent.body.slug)}`, {
      method: 'POST',
      json: {
        name: 'Smoke Paid Invitee',
        email: paidInviteeEmail,
        timezone: 'UTC',
        start_time: toIsoUtc(paidSlot.date, paidSlot.time),
      },
    })
    assert(paidBooking.status === 201, 'expected paid booking creation to succeed', paidBooking)
    assert(paidBooking.body?.booking?.status === 'pending_payment', 'expected paid booking to remain pending_payment before Stripe webhook', paidBooking.body)
    logStep('created paid booking', { status: paidBooking.body.booking.status })

    const duplicatePaidBooking = await requestJson(`/api/book/${encodeURIComponent(bookingSlug)}/${encodeURIComponent(paidEvent.body.slug)}`, {
      method: 'POST',
      json: {
        name: 'Smoke Paid Invitee 2',
        email: `paid-second-${unique}@calendo.test`,
        timezone: 'UTC',
        start_time: toIsoUtc(paidSlot.date, paidSlot.time),
      },
    })
    assert(duplicatePaidBooking.status === 409, 'expected duplicate paid booking to be blocked', duplicatePaidBooking)
    logStep('verified pending_payment blocks duplicate booking attempts')

    console.log('')
    console.log('Smoke test passed:')
    console.log(`- booking page slug: ${bookingSlug}`)
    console.log(`- free slot: ${firstFreeSlot.date} ${firstFreeSlot.time} UTC`)
    console.log(`- rescheduled slot: ${secondFreeSlot.date} ${secondFreeSlot.time} UTC`)
    console.log(`- paid slot: ${paidSlot.date} ${paidSlot.time} UTC`)
  } finally {
    signalServer(server.child, 'SIGTERM')
    const exitedOnTerm = await waitForChildExit(server.child, 5000)
    if (!exitedOnTerm) {
      signalServer(server.child, 'SIGKILL')
      await waitForChildExit(server.child, 5000)
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exit(1)
})
