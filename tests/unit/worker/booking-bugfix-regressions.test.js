import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dateTimeInTimezoneToUtc } from '../../../src/availability.js';
import { createCheckoutSession } from '../../../src/payments.js';

// ============================================================
// Regression tests for the 2026-07 booking bug sweep:
//  1. Day-boundary bookings returned a false 409 (single-day range from the
//     UTC date, interpreted in the host timezone)
//  2. Google/Outlook busy times were never re-checked at booking time
//  3. Post-insert double-booking race guard
//  4. pending_payment bookings held their slot forever (no expiry)
//  5. Free-via-coupon bookings bypassed requires_confirmation
//  6. Reschedule dropped invitee_phone / guest_emails / assigned_user_id
//  7. Coupon use_count burned at checkout creation instead of confirmation
//  8. Busy-time listing filter was off by ±24h across local-date boundaries
//  9. CORS reflected any Origin with Allow-Credentials: true
// ============================================================

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes base64

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
  vi.resetModules();
});
afterEach(() => {
  global.fetch = originalFetch;
});

// Mirror of worker.js encryptToken, so mocked calendar connections hold a
// token the worker can actually decrypt.
async function encryptTokenForTest(token) {
  const keyData = Uint8Array.from(atob(ENCRYPTION_KEY), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  return `${btoa(String.fromCharCode(...iv))}:${btoa(String.fromCharCode(...new Uint8Array(ciphertext)))}`;
}

function allDayRules(start, end) {
  return JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start, end })));
}

function baseEventType(overrides = {}) {
  return {
    id: 1,
    user_id: 1,
    slug: 'test-meeting',
    name: 'Test Meeting',
    duration_minutes: 30,
    is_active: 1,
    price_cents: null,
    currency: 'usd',
    requires_confirmation: 0,
    buffer_before: 0,
    buffer_after: 0,
    min_notice_hours: 0,
    max_future_days: 90,
    availability_schedule_id: null,
    location_type: null,
    questions: null,
    redirect_url: null,
    group_max_attendees: null,
    max_bookings_per_day: null,
    slot_interval: 30,
    org_id: null,
    round_robin_mode: null,
    allow_guests: 1,
    payment_method: 'stripe',
    ...overrides,
  };
}

// Flexible mock DB for the public booking / reschedule / webhook flows.
// Every prepare().bind() invocation is recorded in db._executed for
// assertions on side-effect SQL.
function createMockDB(options = {}) {
  const executed = [];
  const eventType = options.eventType || baseEventType();
  const schedule = options.schedule || {
    id: 1, user_id: 1, timezone: 'UTC',
    rules: allDayRules('09:00', '17:00'),
    overrides: '[]', holidays: '[]', is_default: 1,
  };
  let insertId = 100;

  function insertReturningRow(sql, args) {
    insertId++;
    const cols = sql.match(/INSERT INTO bookings \(([^)]+)\)/)[1].split(',').map(s => s.trim());
    const row = { id: insertId, created_at: new Date().toISOString() };
    cols.forEach((col, i) => { row[col] = args[i]; });
    return row;
  }

  const db = {
    _executed: executed,
    prepare(sql) {
      return {
        // Some worker code calls .all()/.first()/.run() without .bind()
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
        bind(...args) {
          executed.push({ sql, args });
          return {
            async first() {
              if (sql.includes('FROM booking_pages')) {
                return { user_id: 1, blocked_emails: null, slug: 'host' };
              }
              if (sql.includes('FROM event_types WHERE user_id = ? AND slug = ?')) {
                return args[1] === eventType.slug ? eventType : null;
              }
              if (sql.includes('SELECT * FROM event_types WHERE id = ?')) {
                return eventType;
              }
              if (sql.includes('FROM availability_schedules')) {
                return schedule;
              }
              if (sql.includes('WHERE b.cancel_token = ?')) {
                return options.bookingByCancelToken || null;
              }
              if (sql.includes('SELECT * FROM bookings WHERE uid = ?')) {
                return options.bookingByUid || null;
              }
              if (sql.includes('SELECT * FROM bookings WHERE id = ?')) {
                return options.bookingByUid || null;
              }
              if (sql.includes('INSERT INTO bookings')) {
                return insertReturningRow(sql, args);
              }
              // Post-insert race guard probe (solo events)
              if (sql.includes('SELECT id FROM bookings') && sql.includes('AND id < ?')) {
                return options.raceConflictRow || null;
              }
              if (sql.includes('COUNT') && sql.includes('bookings')) {
                return { cnt: 0 };
              }
              if (sql.includes('FROM coupons WHERE user_id = ? AND code = ?')) {
                return (options.coupon && args[1] === options.coupon.code) ? options.coupon : null;
              }
              if (sql.includes('single_use_links')) {
                return null;
              }
              if (sql.includes('FROM payments WHERE booking_id = ?')) {
                return options.paymentRow || null;
              }
              if (sql.includes('FROM users WHERE id')) {
                return { id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC' };
              }
              return null;
            },
            async all() {
              if (sql.includes('calendar_connections')) {
                const provider = args[1];
                if (provider === 'google') return { results: options.googleConnections || [] };
                if (provider === 'outlook') return { results: options.outlookConnections || [] };
                return { results: [] };
              }
              if (sql.includes('FROM bookings')) {
                return { results: options.existingBookings || [] };
              }
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}

function createEnv(db, extra = {}) {
  return {
    DB: db,
    ASSETS: { fetch: () => new Response('') },
    ENCRYPTION_KEY,
    APP_ORIGIN: 'https://calendo.dev',
    DISABLE_OUTBOUND_NOTIFICATIONS: '1',
    ...extra,
  };
}

function futureUtcDate(daysAhead = 21) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

function dateInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function timeInTz(date, tz) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)) {
    parts[type] = value;
  }
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${hour}:${parts.minute}`;
}

async function postBooking(worker, env, body, ip = '1.2.3.4') {
  const request = new Request('https://calendo.dev/api/book/host/test-meeting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({
      name: 'Invitee', email: 'invitee@example.com', ...body,
    }),
  });
  return worker.default.fetch(request, env, {});
}

// ============================================================
// 1. Day-boundary booking (host-local date != UTC date)
// ============================================================

describe('Day-boundary public booking (regression: false 409)', () => {
  it('accepts an evening slot whose UTC date is the next day', async () => {
    const worker = await import('../../../src/worker.js');

    // Host in Los Angeles with a 17:00-18:00 local window every day.
    // 17:30 LA is 00:30/01:30 UTC on the NEXT day — the exact case that used
    // to fail because the single-day validation range came from the UTC date.
    const laDate = dateInTz(new Date(Date.now() + 21 * 86400000), 'America/Los_Angeles');
    const slotStart = dateTimeInTimezoneToUtc(laDate, '17:30', 'America/Los_Angeles');
    expect(slotStart.toISOString().slice(0, 10)).not.toBe(laDate); // sanity: crosses the UTC boundary

    const db = createMockDB({
      schedule: {
        id: 1, user_id: 1, timezone: 'America/Los_Angeles',
        rules: allDayRules('17:00', '18:00'),
        overrides: '[]', holidays: '[]', is_default: 1,
      },
    });
    const env = createEnv(db);

    const response = await postBooking(worker, env, {
      timezone: 'America/Los_Angeles',
      start_time: slotStart.toISOString(),
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.booking.status).toBe('confirmed');
  });
});

// ============================================================
// 2. Booking-time Google Calendar busy re-check
// ============================================================

describe('Booking-time calendar busy re-check (regression: double booking)', () => {
  async function googleConnection() {
    return {
      id: 1, user_id: 1, provider: 'google', check_conflicts: 1,
      calendar_id: 'primary',
      access_token_encrypted: await encryptTokenForTest('google-token'),
      token_expires_at: '2099-01-01T00:00:00Z',
    };
  }

  function mockGoogleBusy(busyRanges) {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('freeBusy')) {
        return new Response(JSON.stringify({
          calendars: { primary: { busy: busyRanges } },
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  }

  it('rejects a booking that conflicts with a Google Calendar event', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();
    const slotStart = `${day}T10:00:00Z`;

    mockGoogleBusy([{ start: `${day}T10:00:00Z`, end: `${day}T10:30:00Z` }]);
    const db = createMockDB({ googleConnections: [await googleConnection()] });
    const env = createEnv(db);

    const response = await postBooking(worker, env, {
      timezone: 'UTC', start_time: slotStart,
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toContain('no longer available');
  });

  it('accepts a booking when the Google busy time does not overlap', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    mockGoogleBusy([{ start: `${day}T14:00:00Z`, end: `${day}T14:30:00Z` }]);
    const db = createMockDB({ googleConnections: [await googleConnection()] });
    const env = createEnv(db);

    const response = await postBooking(worker, env, {
      timezone: 'UTC', start_time: `${day}T10:00:00Z`,
    });

    expect(response.status).toBe(201);
  });

  it('rejects a reschedule that conflicts with a Google Calendar event', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    mockGoogleBusy([{ start: `${day}T10:00:00Z`, end: `${day}T10:30:00Z` }]);
    const db = createMockDB({
      googleConnections: [await googleConnection()],
      bookingByCancelToken: {
        id: 50, et_id: 1, event_type_id: 1, user_id: 1, status: 'confirmed',
        invitee_email: 'invitee@example.com', invitee_name: 'Invitee',
        invitee_timezone: 'UTC', invitee_phone: null, guest_emails: '[]',
        assigned_user_id: null, recurrence_parent_id: null, answers: '{}',
        duration_minutes: 30, buffer_before: 0, buffer_after: 0,
        min_notice_hours: 0, max_future_days: 90, max_bookings_per_day: null,
        slot_interval: 30, requires_confirmation: 0, availability_schedule_id: null,
        event_type_name: 'Test Meeting', event_type_slug: 'test-meeting',
        host_name: 'Host', booking_page_slug: 'host',
        start_time: `${day}T09:00:00Z`, end_time: `${day}T09:30:00Z`,
      },
    });
    const env = createEnv(db);

    const request = new Request('https://calendo.dev/api/bookings/reschedule-by-token/tok123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.5' },
      body: JSON.stringify({ new_start_time: `${day}T10:00:00Z`, timezone: 'UTC' }),
    });
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(409);
  });
});

// ============================================================
// 3. Post-insert double-booking race guard
// ============================================================

describe('Double-booking race guard (regression: check-then-insert race)', () => {
  it('backs out and returns 409 when an earlier overlapping booking appears', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    const db = createMockDB({ raceConflictRow: { id: 5 } });
    const env = createEnv(db);

    const response = await postBooking(worker, env, {
      timezone: 'UTC', start_time: `${day}T10:00:00Z`,
    });

    expect(response.status).toBe(409);
    const deleted = db._executed.find(e => e.sql.includes('DELETE FROM bookings WHERE id = ?'));
    expect(deleted).toBeTruthy();
  });
});

// ============================================================
// 4. pending_payment expiry
// ============================================================

describe('pending_payment expiry (regression: slots held forever)', () => {
  it('cron marks stale pending_payment bookings as expired', async () => {
    const worker = await import('../../../src/worker.js');
    const db = createMockDB();
    const env = createEnv(db);

    // minute=10 so the hourly/daily branches of the cron stay quiet
    const tick = new Date();
    tick.setUTCHours(12, 10, 0, 0);
    await worker.default.scheduled({ scheduledTime: tick.getTime() }, env, {});

    const expire = db._executed.find(e =>
      e.sql.includes("UPDATE bookings SET status = 'expired'") &&
      e.sql.includes("status = 'pending_payment'")
    );
    expect(expire).toBeTruthy();
    // Cutoff is ~60 minutes ago
    const cutoff = new Date(expire.args[0]).getTime();
    expect(Math.abs(Date.now() - 60 * 60000 - cutoff)).toBeLessThan(10000);
  });

  it('Stripe checkout sessions are created with an expires_at', async () => {
    let capturedBody = null;
    global.fetch = vi.fn(async (url, init) => {
      capturedBody = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/x' }), { status: 200 });
    });

    await createCheckoutSession({ STRIPE_SECRET_KEY: 'sk_test' }, {
      eventType: { price_cents: 5000, currency: 'usd', name: 'Paid' },
      booking: { uid: 'bk-1' },
      successUrl: 'https://calendo.dev/ok',
      cancelUrl: 'https://calendo.dev/no',
    });

    const expiresAt = parseInt(capturedBody.get('expires_at'), 10);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(expiresAt).toBeGreaterThanOrEqual(nowSec + 30 * 60);
    expect(expiresAt).toBeLessThanOrEqual(nowSec + 35 * 60);
  });

  it('PayPal capture of an expired booking redirects to cancelled, never captures', async () => {
    const worker = await import('../../../src/worker.js');
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));

    const db = createMockDB({
      bookingByUid: { id: 9, uid: 'bk-exp', status: 'expired', event_type_id: 1 },
    });
    const env = createEnv(db);

    const request = new Request('https://calendo.dev/api/payments/paypal/capture?token=bk-exp');
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('/booking/cancelled');
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('paypal'), expect.anything());
  });

  it('PayPal capture of an already-confirmed booking still shows the confirmed page', async () => {
    const worker = await import('../../../src/worker.js');
    const db = createMockDB({
      bookingByUid: { id: 9, uid: 'bk-ok', status: 'confirmed', event_type_id: 1 },
    });
    const env = createEnv(db);

    const request = new Request('https://calendo.dev/api/payments/paypal/capture?token=bk-ok');
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('/booking/confirmed');
  });
});

// ============================================================
// 5 + 7. Coupons: requires_confirmation and use_count timing
// ============================================================

describe('Coupon behavior (regressions: confirmation bypass, use_count burn)', () => {
  const coupon100 = {
    id: 7, user_id: 1, code: 'FREE100', discount_type: 'percent', discount_value: 100,
    is_active: 1, applies_to: 'all', max_uses: null, use_count: 0, expires_at: null,
  };

  it('a 100% coupon on a requires_confirmation event books as pending', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    const db = createMockDB({
      eventType: baseEventType({ price_cents: 5000, requires_confirmation: 1 }),
      coupon: coupon100,
    });
    const env = createEnv(db, { STRIPE_SECRET_KEY: 'sk_test' });

    const response = await postBooking(worker, env, {
      timezone: 'UTC', start_time: `${day}T10:00:00Z`, coupon_code: 'FREE100',
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.booking.status).toBe('pending');
    // The free-coupon booking confirmed an outcome, so the use counts
    const increment = db._executed.find(e => e.sql.includes('UPDATE coupons SET use_count = use_count + 1'));
    expect(increment).toBeTruthy();
    expect(increment.args[0]).toBe(7);
  });

  it('a 100% coupon without requires_confirmation books as confirmed', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    const db = createMockDB({
      eventType: baseEventType({ price_cents: 5000, requires_confirmation: 0 }),
      coupon: coupon100,
    });
    const env = createEnv(db, { STRIPE_SECRET_KEY: 'sk_test' });

    const response = await postBooking(worker, env, {
      timezone: 'UTC', start_time: `${day}T10:00:00Z`, coupon_code: 'FREE100',
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.booking.status).toBe('confirmed');
  });

  it('a partial coupon records coupon_id but does NOT burn use_count at checkout', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('stripe.com')) {
        return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/x' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const db = createMockDB({
      eventType: baseEventType({ price_cents: 5000 }),
      coupon: { ...coupon100, code: 'HALF', discount_value: 50 },
    });
    const env = createEnv(db, { STRIPE_SECRET_KEY: 'sk_test' });

    const response = await postBooking(worker, env, {
      timezone: 'UTC', start_time: `${day}T10:00:00Z`, coupon_code: 'HALF',
    });

    expect(response.status).toBe(201);
    const recorded = db._executed.find(e => e.sql.includes('UPDATE bookings SET coupon_id = ?'));
    expect(recorded).toBeTruthy();
    expect(recorded.args[0]).toBe(7);
    const increment = db._executed.find(e => e.sql.includes('UPDATE coupons SET use_count = use_count + 1'));
    expect(increment).toBeUndefined();
  });

  it('Stripe webhook increments coupon use_count when the paid booking confirms', async () => {
    const worker = await import('../../../src/worker.js');

    const db = createMockDB({
      bookingByUid: {
        id: 9, uid: 'bk-paid', status: 'pending_payment', coupon_id: 7, event_type_id: 1,
        invitee_email: 'invitee@example.com', invitee_name: 'Invitee',
        invitee_timezone: 'UTC', start_time: '2026-08-01T10:00:00Z', end_time: '2026-08-01T10:30:00Z',
        guest_emails: '[]', answers: '{}',
      },
    });
    const env = createEnv(db, { STRIPE_WEBHOOK_SECRET: 'whsec_test' });

    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', metadata: { booking_uid: 'bk-paid' }, payment_intent: 'pi_1', amount_total: 5000 } },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode('whsec_test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`));
    const sig = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));

    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': `t=${timestamp},v1=${sig}` },
      body: payload,
    });
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const increment = db._executed.find(e => e.sql.includes('UPDATE coupons SET use_count = use_count + 1'));
    expect(increment).toBeTruthy();
    expect(increment.args[0]).toBe(7);
  });
});

// ============================================================
// 6. Reschedule keeps invitee/assignment fields
// ============================================================

describe('Reschedule field carry-over (regression: dropped fields)', () => {
  it('carries invitee_phone, guest_emails, and assigned_user_id to the new booking', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    const db = createMockDB({
      bookingByCancelToken: {
        id: 50, et_id: 1, event_type_id: 1, user_id: 1, status: 'confirmed',
        invitee_email: 'invitee@example.com', invitee_name: 'Invitee',
        invitee_timezone: 'UTC', invitee_phone: '+1 (555) 123-4567',
        guest_emails: '["guest@example.com"]', assigned_user_id: 3,
        recurrence_parent_id: null, answers: '{}',
        duration_minutes: 30, buffer_before: 0, buffer_after: 0,
        min_notice_hours: 0, max_future_days: 90, max_bookings_per_day: null,
        slot_interval: 30, requires_confirmation: 0, availability_schedule_id: null,
        event_type_name: 'Test Meeting', event_type_slug: 'test-meeting',
        host_name: 'Host', booking_page_slug: 'host',
        start_time: `${day}T09:00:00Z`, end_time: `${day}T09:30:00Z`,
      },
    });
    const env = createEnv(db);

    const request = new Request('https://calendo.dev/api/bookings/reschedule-by-token/tok456', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.6' },
      body: JSON.stringify({ new_start_time: `${day}T11:00:00Z`, timezone: 'UTC' }),
    });
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const insert = db._executed.find(e => e.sql.includes('INSERT INTO bookings'));
    expect(insert).toBeTruthy();
    const cols = insert.sql.match(/INSERT INTO bookings \(([^)]+)\)/)[1].split(',').map(s => s.trim());
    const byCol = {};
    cols.forEach((col, i) => { byCol[col] = insert.args[i]; });

    expect(byCol.invitee_phone).toBe('+1 (555) 123-4567');
    expect(byCol.guest_emails).toBe('["guest@example.com"]');
    expect(byCol.assigned_user_id).toBe(3);
  });
});

// ============================================================
// 8. Availability listing: busy filter across local-date boundaries
// ============================================================

describe('Busy filter timezone conversion (regression: ±24h offset error)', () => {
  it('removes the conflicting slot when the invitee local date differs from the UTC date', async () => {
    const worker = await import('../../../src/worker.js');
    const day = futureUtcDate();

    // Host window 08:00-09:00 UTC; invitee in Auckland (UTC+12/+13) sees these
    // slots in their EVENING, and the old hour-only offset math resolved them
    // 24h late, so a Google event at 08:00Z never removed its slot.
    const conn = {
      id: 1, user_id: 1, provider: 'google', check_conflicts: 1,
      calendar_id: 'primary',
      access_token_encrypted: await encryptTokenForTest('google-token'),
      token_expires_at: '2099-01-01T00:00:00Z',
    };
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('freeBusy')) {
        return new Response(JSON.stringify({
          calendars: { primary: { busy: [{ start: `${day}T08:00:00Z`, end: `${day}T08:30:00Z` }] } },
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const db = createMockDB({
      schedule: {
        id: 1, user_id: 1, timezone: 'UTC',
        rules: allDayRules('08:00', '09:00'),
        overrides: '[]', holidays: '[]', is_default: 1,
      },
      googleConnections: [conn],
    });
    const env = createEnv(db);

    const request = new Request(
      `https://calendo.dev/api/availability/host/test-meeting?start=${day}&end=${day}&timezone=Pacific/Auckland`,
      { headers: { 'CF-Connecting-IP': '1.2.3.7' } }
    );
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);
    const { slots } = await response.json();

    const busySlotUtc = new Date(`${day}T08:00:00Z`);
    const freeSlotUtc = new Date(`${day}T08:30:00Z`);
    const busyKey = dateInTz(busySlotUtc, 'Pacific/Auckland');
    const busyTime = timeInTz(busySlotUtc, 'Pacific/Auckland');
    const freeKey = dateInTz(freeSlotUtc, 'Pacific/Auckland');
    const freeTime = timeInTz(freeSlotUtc, 'Pacific/Auckland');

    expect(slots[freeKey] || []).toContain(freeTime);
    expect(slots[busyKey] || []).not.toContain(busyTime);
  });
});

// ============================================================
// 9. CORS credentials
// ============================================================

describe('CORS (regression: reflected arbitrary Origin with credentials)', () => {
  it('does not allow credentials for a foreign origin', async () => {
    const worker = await import('../../../src/worker.js');
    const env = createEnv(createMockDB());

    const request = new Request('https://calendo.dev/api/event-types', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    const response = await worker.default.fetch(request, env, {});

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('false');
  });

  it('allows credentials for the deployment own origin', async () => {
    const worker = await import('../../../src/worker.js');
    const env = createEnv(createMockDB());

    const request = new Request('https://calendo.dev/api/event-types', {
      method: 'OPTIONS',
      headers: { Origin: 'https://calendo.dev' },
    });
    const response = await worker.default.fetch(request, env, {});

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://calendo.dev');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('treats the www variant of the host as the same site', async () => {
    const worker = await import('../../../src/worker.js');
    const env = createEnv(createMockDB());

    const request = new Request('https://calendo.dev/api/event-types', {
      method: 'OPTIONS',
      headers: { Origin: 'https://www.calendo.dev' },
    });
    const response = await worker.default.fetch(request, env, {});

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.calendo.dev');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
