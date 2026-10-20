import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Stripe Booking UI Integration Tests
// Tests the booking flow for paid event types, coupon application,
// and free-event fallback from the worker perspective.
// ============================================================

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function createEnv(db) {
  return {
    DB: db,
    ASSETS: { fetch: () => new Response('') },
    STRIPE_SECRET_KEY: 'sk_test_123',
  };
}

// Availability rules: Mon-Fri 09:00-17:00 UTC
const defaultRules = JSON.stringify([
  { day: 1, start: '09:00', end: '17:00' },
  { day: 2, start: '09:00', end: '17:00' },
  { day: 3, start: '09:00', end: '17:00' },
  { day: 4, start: '09:00', end: '17:00' },
  { day: 5, start: '09:00', end: '17:00' },
]);

const defaultSchedule = {
  id: 1,
  user_id: 1,
  timezone: 'UTC',
  rules: defaultRules,
  overrides: '[]',
  holidays: '[]',
  is_default: 1,
};

function paidEventType(overrides = {}) {
  return {
    id: 1,
    user_id: 1,
    slug: 'paid-consult',
    name: 'Paid Consultation',
    duration_minutes: 30,
    is_active: 1,
    price_cents: 5000,
    currency: 'usd',
    requires_confirmation: 0,
    buffer_before: 0,
    buffer_after: 0,
    min_notice_hours: 0,
    max_future_days: 90,
    availability_schedule_id: null,
    location_type: 'google_meet',
    is_secret: 0,
    questions: null,
    locked_timezone: null,
    redirect_url: null,
    group_max_attendees: null,
    max_bookings_per_day: null,
    slot_interval: null,
    org_id: null,
    round_robin_mode: null,
    ...overrides,
  };
}

function createBookingDB(options = {}) {
  const eventType = options.eventType || paidEventType();
  const coupon = options.coupon || null;
  const user = { id: 1, email: 'host@example.com', name: 'Test User', timezone: 'UTC' };
  let insertCount = 0;

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // Booking page lookup (booking route)
              if (sql.includes('FROM booking_pages') && sql.includes('slug')) {
                return { user_id: 1, blocked_emails: null, slug: 'testuser' };
              }
              // Event type lookup (booking route - no is_secret filter)
              if (sql.includes('SELECT * FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1')) {
                if (args[1] === eventType.slug) return eventType;
                return null;
              }
              // Availability schedule by id
              if (sql.includes('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?')) {
                return defaultSchedule;
              }
              // Default availability schedule
              if (sql.includes('SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1')) {
                return defaultSchedule;
              }
              // User lookup
              if (sql.includes('SELECT * FROM users WHERE id')) {
                return user;
              }
              // Max bookings per day
              if (sql.includes('COUNT') && sql.includes('bookings')) {
                return { cnt: 0 };
              }
              // Calendar connections
              if (sql.includes('calendar_connections')) {
                return null;
              }
              // Booking insert
              if (sql.includes('INSERT INTO bookings')) {
                insertCount++;
                return {
                  id: 100 + insertCount,
                  uid: 'bk-' + (100 + insertCount),
                  event_type_id: eventType.id,
                  invitee_name: args[3],
                  invitee_email: args[2],
                  invitee_timezone: args[4],
                  invitee_phone: args[5],
                  start_time: args[6],
                  end_time: args[7],
                  status: args[8],
                  cancel_token: args[10],
                  created_at: new Date().toISOString(),
                };
              }
              // Cancel token insert
              if (sql.includes('INSERT INTO booking_cancel_tokens')) {
                return { token: 'cancel-tok-' + args[0] };
              }
              // Coupon lookup
              if (sql.includes('coupons') && sql.includes('code')) {
                if (coupon && args[1] === coupon.code) return coupon;
                return null;
              }
              // Single-use link
              if (sql.includes('single_use_links')) {
                return null;
              }
              return null;
            },
            async all() {
              // Bookings conflict check
              if (sql.includes('SELECT start_time, end_time, status FROM bookings')) {
                return { results: [] };
              }
              // Webhooks
              if (sql.includes('webhooks')) {
                return { results: [] };
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
}

/**
 * Get a future date string for a given day of week.
 * day: 1=Monday, 2=Tuesday, etc. (ISO weekday)
 * Returns a YYYY-MM-DD for a date 2+ weeks in the future on that weekday.
 */
function getFutureWeekday(isoDay) {
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0=Sun
  // Convert ISO day to JS day (1=Mon -> 1, 5=Fri -> 5)
  const jsDay = isoDay % 7; // Mon=1, Tue=2, ..., Sun=0
  let diff = jsDay - currentDay;
  if (diff <= 0) diff += 7;
  const target = new Date(now);
  target.setUTCDate(target.getUTCDate() + diff + 14); // +14 to be well in future
  return target.toISOString().slice(0, 10);
}

// ============================================================
// Paid Booking Flow Tests
// ============================================================

describe('Paid Booking Flow', () => {
  it('booking with price_cents returns checkout_url', async () => {
    const worker = await import('../../../src/worker.js');
    const checkoutUrl = 'https://checkout.stripe.com/pay/cs_test_paid';

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: checkoutUrl }),
    });

    const db = createBookingDB();
    const env = createEnv(db);

    const futureDate = getFutureWeekday(1); // Monday
    const request = new Request('https://calendo.dev/api/book/testuser/paid-consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jane Doe',
        email: 'jane@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T14:00:00Z`,
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.checkout_url).toBe(checkoutUrl);
    expect(data.booking).toBeDefined();
    expect(data.booking.status).toBe('pending_payment');

    // Verify Stripe was called with correct price
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const body = new URLSearchParams(opts.body);
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('5000');
  });

  it('free event types do not require payment', async () => {
    const worker = await import('../../../src/worker.js');
    global.fetch = vi.fn();

    const freeEvent = paidEventType({
      slug: 'free-chat',
      name: 'Free Chat',
      duration_minutes: 15,
      price_cents: null,
      currency: null,
    });

    const db = createBookingDB({ eventType: freeEvent });
    const env = createEnv(db);

    const futureDate = getFutureWeekday(2); // Tuesday
    const request = new Request('https://calendo.dev/api/book/testuser/free-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob Smith',
        email: 'bob@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T15:00:00Z`,
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.checkout_url).toBeUndefined();
    expect(data.booking).toBeDefined();
    expect(data.booking.status).toBe('confirmed');

    // Stripe should NOT have been called
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('booking with price_cents=0 does not require payment', async () => {
    const worker = await import('../../../src/worker.js');
    global.fetch = vi.fn();

    const zeroEvent = paidEventType({
      slug: 'zero-price',
      name: 'Zero Price Event',
      price_cents: 0,
    });

    const db = createBookingDB({ eventType: zeroEvent });
    const env = createEnv(db);

    const futureDate = getFutureWeekday(3); // Wednesday
    const request = new Request('https://calendo.dev/api/book/testuser/zero-price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Charlie',
        email: 'charlie@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T10:00:00Z`,
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.checkout_url).toBeUndefined();
    expect(data.booking.status).toBe('confirmed');
  });
});

// ============================================================
// Coupon Flow Tests
// ============================================================

describe('Coupon Application in Paid Bookings', () => {
  it('booking with valid percentage coupon reduces price in Stripe checkout', async () => {
    const worker = await import('../../../src/worker.js');
    const checkoutUrl = 'https://checkout.stripe.com/pay/cs_test_coupon';

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: checkoutUrl }),
    });

    const coupon = {
      id: 1,
      user_id: 1,
      code: 'SAVE20',
      discount_type: 'percent',
      discount_value: 20,
      is_active: 1,
      max_uses: 100,
      use_count: 5,
      applies_to: '"all"',
      expires_at: null,
    };

    const db = createBookingDB({ coupon });
    const env = createEnv(db);

    const futureDate = getFutureWeekday(1);
    const request = new Request('https://calendo.dev/api/book/testuser/paid-consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Coupon User',
        email: 'coupon@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T14:00:00Z`,
        coupon_code: 'SAVE20',
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.checkout_url).toBe(checkoutUrl);
    expect(data.coupon_applied).toBeDefined();
    expect(data.coupon_applied.code).toBe('SAVE20');

    // Verify Stripe was called with reduced price (5000 * 0.8 = 4000)
    const [, opts] = global.fetch.mock.calls[0];
    const body = new URLSearchParams(opts.body);
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('4000');
  });

  it('booking with 100% coupon auto-confirms without Stripe', async () => {
    const worker = await import('../../../src/worker.js');
    global.fetch = vi.fn();

    const coupon = {
      id: 2,
      user_id: 1,
      code: 'FREE100',
      discount_type: 'percent',
      discount_value: 100,
      is_active: 1,
      max_uses: null,
      use_count: 0,
      applies_to: '"all"',
      expires_at: null,
    };

    const db = createBookingDB({ coupon });
    const env = createEnv(db);

    const futureDate = getFutureWeekday(2);
    const request = new Request('https://calendo.dev/api/book/testuser/paid-consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Free User',
        email: 'free@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T11:00:00Z`,
        coupon_code: 'FREE100',
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    // No Stripe redirect -- booking confirmed directly
    expect(data.checkout_url).toBeUndefined();
    expect(data.booking.status).toBe('confirmed');
    expect(data.coupon_applied).toBeDefined();
    expect(data.coupon_applied.code).toBe('FREE100');

    // Stripe should NOT have been called
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('booking with fixed-amount coupon that exceeds price auto-confirms', async () => {
    const worker = await import('../../../src/worker.js');
    global.fetch = vi.fn();

    const coupon = {
      id: 3,
      user_id: 1,
      code: 'BIGDISCOUNT',
      discount_type: 'fixed',
      discount_value: 10000, // $100 off a $50 event
      is_active: 1,
      max_uses: null,
      use_count: 0,
      applies_to: '"all"',
      expires_at: null,
    };

    const db = createBookingDB({ coupon });
    const env = createEnv(db);

    const futureDate = getFutureWeekday(3);
    const request = new Request('https://calendo.dev/api/book/testuser/paid-consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Big Discount User',
        email: 'big@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T13:00:00Z`,
        coupon_code: 'BIGDISCOUNT',
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.checkout_url).toBeUndefined();
    expect(data.booking.status).toBe('confirmed');
    expect(data.coupon_applied.code).toBe('BIGDISCOUNT');

    // Stripe should NOT have been called
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('booking with partial fixed-amount coupon still requires Stripe', async () => {
    const worker = await import('../../../src/worker.js');
    const checkoutUrl = 'https://checkout.stripe.com/pay/cs_test_partial';

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: checkoutUrl }),
    });

    const coupon = {
      id: 4,
      user_id: 1,
      code: 'SAVE10',
      discount_type: 'fixed',
      discount_value: 1000, // $10 off a $50 event
      is_active: 1,
      max_uses: null,
      use_count: 0,
      applies_to: '"all"',
      expires_at: null,
    };

    const db = createBookingDB({ coupon });
    const env = createEnv(db);

    const futureDate = getFutureWeekday(4);
    const request = new Request('https://calendo.dev/api/book/testuser/paid-consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Partial Coupon User',
        email: 'partial@example.com',
        timezone: 'UTC',
        start_time: `${futureDate}T16:00:00Z`,
        coupon_code: 'SAVE10',
      }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.checkout_url).toBe(checkoutUrl);
    expect(data.coupon_applied.code).toBe('SAVE10');

    // Verify Stripe was called with reduced price (5000 - 1000 = 4000)
    const [, opts] = global.fetch.mock.calls[0];
    const body = new URLSearchParams(opts.body);
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('4000');
  });
});

// ============================================================
// Coupon Validation Endpoint Tests
// ============================================================

describe('Coupon Validation Endpoint', () => {
  it('validates a valid coupon and returns discount info', async () => {
    const worker = await import('../../../src/worker.js');

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('booking_pages') && sql.includes('slug')) {
                  return { user_id: 1, slug: 'testuser' };
                }
                if (sql.includes('coupons') && sql.includes('code')) {
                  return {
                    id: 1, user_id: 1, code: 'WELCOME20',
                    discount_type: 'percent', discount_value: 20,
                    is_active: 1, max_uses: null, use_count: 0,
                    applies_to: '"all"', expires_at: null,
                  };
                }
                return null;
              },
              async all() { return { results: [] }; },
              async run() { return {}; },
            };
          },
        };
      },
    };

    const request = new Request(
      'https://calendo.dev/api/validate-coupon/WELCOME20?user=testuser&event_type_id=1',
      { method: 'GET' }
    );

    const response = await worker.default.fetch(request, { DB: db, ASSETS: { fetch: () => new Response('') } }, {});
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.discount_type).toBe('percent');
    expect(data.discount_value).toBe(20);
  });

  it('rejects invalid coupon code', async () => {
    const worker = await import('../../../src/worker.js');

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('booking_pages') && sql.includes('slug')) return { user_id: 1 };
                return null;
              },
              async all() { return { results: [] }; },
              async run() { return {}; },
            };
          },
        };
      },
    };

    const request = new Request('https://calendo.dev/api/validate-coupon/BADCODE?user=testuser', { method: 'GET' });
    const response = await worker.default.fetch(request, { DB: db, ASSETS: { fetch: () => new Response('') } }, {});
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('Invalid');
  });

  it('rejects expired coupon', async () => {
    const worker = await import('../../../src/worker.js');

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('booking_pages') && sql.includes('slug')) return { user_id: 1 };
                if (sql.includes('coupons') && sql.includes('code')) {
                  return {
                    id: 1, user_id: 1, code: 'EXPIRED',
                    discount_type: 'percent', discount_value: 50,
                    is_active: 1, max_uses: null, use_count: 0,
                    applies_to: '"all"', expires_at: '2020-01-01 00:00:00',
                  };
                }
                return null;
              },
              async all() { return { results: [] }; },
              async run() { return {}; },
            };
          },
        };
      },
    };

    const request = new Request('https://calendo.dev/api/validate-coupon/EXPIRED?user=testuser', { method: 'GET' });
    const response = await worker.default.fetch(request, { DB: db, ASSETS: { fetch: () => new Response('') } }, {});
    expect(response.status).toBe(410);
    const data = await response.json();
    expect(data.error).toContain('expired');
  });

  it('rejects fully-redeemed coupon', async () => {
    const worker = await import('../../../src/worker.js');

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('booking_pages') && sql.includes('slug')) return { user_id: 1 };
                if (sql.includes('coupons') && sql.includes('code')) {
                  return {
                    id: 1, user_id: 1, code: 'MAXED',
                    discount_type: 'percent', discount_value: 10,
                    is_active: 1, max_uses: 5, use_count: 5,
                    applies_to: '"all"', expires_at: null,
                  };
                }
                return null;
              },
              async all() { return { results: [] }; },
              async run() { return {}; },
            };
          },
        };
      },
    };

    const request = new Request('https://calendo.dev/api/validate-coupon/MAXED?user=testuser', { method: 'GET' });
    const response = await worker.default.fetch(request, { DB: db, ASSETS: { fetch: () => new Response('') } }, {});
    expect(response.status).toBe(410);
    const data = await response.json();
    expect(data.error).toContain('redeemed');
  });
});

// ============================================================
// Booking Page Price Display Tests
// ============================================================

describe('Booking Page Data - Price Exposure', () => {
  it('booking page API returns price_cents and currency for event types', async () => {
    const worker = await import('../../../src/worker.js');

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('u.name, u.avatar_url') && sql.includes('booking_pages')) {
                  return { user_id: 1, slug: 'testuser', display_name: 'Test User', name: 'Test User', avatar_url: null };
                }
                if (sql.includes('FROM event_types') && sql.includes('is_secret = 1')) return null;
                return null;
              },
              async all() {
                if (sql.includes('FROM event_types') && sql.includes('is_active = 1') && sql.includes('is_secret = 0')) {
                  return {
                    results: [
                      { id: 1, name: 'Free Chat', slug: 'free-chat', description: null, duration_minutes: 15, color: '#0069ff', location_type: 'google_meet', questions: null, locked_timezone: null, price_cents: null, currency: null, redirect_url: null },
                      { id: 2, name: 'Paid Consult', slug: 'paid-consult', description: null, duration_minutes: 60, color: '#16a34a', location_type: 'zoom', questions: null, locked_timezone: null, price_cents: 7500, currency: 'usd', redirect_url: null },
                    ],
                  };
                }
                return { results: [] };
              },
              async run() { return {}; },
            };
          },
        };
      },
    };

    const request = new Request('https://calendo.dev/api/booking-page/testuser', { method: 'GET' });
    const response = await worker.default.fetch(request, { DB: db, ASSETS: { fetch: () => new Response('') } }, {});
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.eventTypes).toHaveLength(2);

    const freeType = data.eventTypes.find(e => e.slug === 'free-chat');
    expect(freeType.price_cents).toBeNull();

    const paidType = data.eventTypes.find(e => e.slug === 'paid-consult');
    expect(paidType.price_cents).toBe(7500);
    expect(paidType.currency).toBe('usd');
  });
});
