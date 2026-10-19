import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = global.fetch;

function createEnv(db, overrides = {}) {
  return {
    DB: db,
    ASSETS: { fetch: () => new Response('') },
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
    ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    APP_ORIGIN: 'https://calendo.dev',
    ...overrides,
  };
}

function createOAuthMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    calendar_connections: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    calendar_connections: 1,
  };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find((user) => user.email === args[0]) || null;
              }
              if (sql.includes('SELECT id, email, password_hash')) {
                return tables.users.find((user) => user.email === args[0]) || null;
              }
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = {
                  id,
                  email: args[0],
                  password_hash: args[1],
                  name: args[2],
                  timezone: args[3],
                  avatar_url: args[4] || null,
                  created_at: new Date().toISOString(),
                };
                tables.users.push(user);
                return {
                  id: user.id,
                  email: user.email,
                  name: user.name,
                  timezone: user.timezone,
                  avatar_url: user.avatar_url,
                  created_at: user.created_at,
                };
              }
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find((page) => page.slug === args[0]) || null;
              }
              if (sql.includes('SELECT id FROM availability_schedules')) {
                return tables.availability_schedules.find((schedule) => schedule.user_id === args[0] && schedule.is_default) || null;
              }
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find((item) => item.token === args[0]);
                if (!session) return null;
                const user = tables.users.find((item) => item.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              if (sql.includes('SELECT id FROM calendar_connections WHERE user_id') && sql.includes('provider') && sql.includes('email')) {
                return tables.calendar_connections.find((connection) => (
                  connection.user_id === args[0] &&
                  connection.provider === args[1] &&
                  connection.email === args[2]
                )) || null;
              }
              if (sql.includes('SELECT id, name, email, timezone FROM users')) {
                return tables.users.find((user) => user.id === args[0]) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes('calendar_connections') && sql.includes('write_events')) {
                const connections = tables.calendar_connections.filter(
                  (connection) => connection.user_id === args[0] && connection.provider === args[1] && connection.write_events === 1
                );
                return { results: connections };
              }
              if (sql.includes('SELECT * FROM webhooks WHERE user_id = ? AND is_active = 1')) {
                return { results: [] };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: args[4] });
              }
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
              }
              if (sql.includes('INSERT INTO calendar_connections')) {
                tables.calendar_connections.push({
                  id: autoIncrement.calendar_connections++,
                  user_id: args[0],
                  provider: args[1],
                  access_token_encrypted: args[2],
                  refresh_token_encrypted: args[3],
                  token_expires_at: args[4],
                  email: args[5],
                  calendar_id: args[6],
                  is_primary: args[7],
                  check_conflicts: args[8],
                  write_events: args[9],
                });
              }
              if (sql.includes('INSERT INTO notification_log')) {
                return { success: true };
              }
              return { success: true };
            },
          };
        },
      };
    },
    _tables: tables,
  };
}

async function registerUser(worker, env) {
  const request = new Request('https://calendo.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' }),
  });
  const response = await worker.default.fetch(request, env, {});
  const cookie = response.headers.get('Set-Cookie');
  return cookie.match(/session=([^;]+)/)[1];
}

async function encryptTokenForTest(token, keyBase64) {
  const keyData = Uint8Array.from(atob(keyBase64), (char) => char.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

async function computeStripeSignature(secret, payload) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const signature = Array.from(new Uint8Array(signatureBytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestamp},v1=${signature}`;
}

describe('Review regression fixes', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    worker = await import('../../../src/worker.js');
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('blocks duplicate paid bookings when a legacy pending_payment slot already exists', async () => {
    const eventType = {
      id: 1,
      user_id: 1,
      slug: 'paid-demo',
      name: 'Paid Demo',
      duration_minutes: 30,
      is_active: 1,
      price_cents: 5000,
      currency: 'usd',
      requires_confirmation: 0,
      buffer_before: 0,
      buffer_after: 0,
      min_notice_hours: 0,
      max_future_days: 60,
      availability_schedule_id: null,
    };
    const schedule = {
      id: 1,
      user_id: 1,
      timezone: 'UTC',
      rules: JSON.stringify([{ day: 3, start: '09:00', end: '10:00' }]),
      overrides: '[]',
      is_default: 1,
    };

    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM booking_pages') && sql.includes('WHERE') && sql.includes('slug')) return { user_id: 1 };
                if (sql.includes('SELECT * FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1')) return eventType;
                if (sql.includes('SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1')) return schedule;
                return null;
              },
              async all() {
                if (sql.includes('SELECT start_time, end_time, status FROM bookings')) {
                  expect(sql).toContain('pending_payment');
                  return {
                    results: [
                      {
                        start_time: '2026-06-03 09:00:00',
                        end_time: '2026-06-03 09:30:00',
                        status: 'pending_payment',
                      },
                    ],
                  };
                }
                return { results: [] };
              },
              async run() {
                throw new Error(`Unexpected write query: ${sql}`);
              },
            };
          },
        };
      },
    };

    const request = new Request('https://calendo.dev/api/book/ravi/paid-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        timezone: 'UTC',
        start_time: '2026-06-03T09:00:00Z',
      }),
    });

    const response = await worker.default.fetch(request, createEnv(db), {});
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'This time slot is no longer available',
    });
  });

  it('uses the host name when emailing invitee cancellations to the host', async () => {
    const mailPayloads = [];
    global.fetch = vi.fn(async (url, options) => {
      if (url === 'https://api.resend.com/emails') {
        mailPayloads.push(JSON.parse(options.body));
        return {
          ok: true,
          text: async () => '{"id":"re_123"}',
        };
      }
      return { ok: true, text: async () => '' };
    });

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('SELECT b.id, b.uid, b.status, b.start_time FROM bookings b WHERE b.cancel_token = ?')) {
                  return { id: 42, uid: 'booking-123', status: 'confirmed', start_time: futureDate };
                }
                if (sql.includes('SELECT b.*, et.name as event_type_name, et.user_id, u.name as host_name, u.email as host_email')) {
                  return {
                    id: 42,
                    uid: 'booking-123',
                    event_type_id: 3,
                    invitee_name: 'Invitee Name',
                    invitee_email: 'invitee@example.com',
                    invitee_timezone: 'UTC',
                    start_time: futureDate,
                    end_time: futureDate,
                    event_type_name: 'Support Call',
                    user_id: 7,
                    host_name: 'Ravi Host',
                    host_email: 'host@example.com',
                  };
                }
                return null;
              },
              async all() {
                if (sql.includes('SELECT * FROM webhooks WHERE user_id = ? AND is_active = 1')) {
                  return { results: [] };
                }
                return { results: [] };
              },
              async run() {
                if (
                  sql.includes("UPDATE bookings SET status = 'cancelled'") ||
                  sql.includes('INSERT INTO notification_log')
                ) {
                  return { success: true };
                }
                throw new Error(`Unexpected write query: ${sql} (${args.join(',')})`);
              },
            };
          },
        };
      },
    };

    const request = new Request('https://calendo.dev/api/bookings/cancel-by-token/cancel-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Conflict' }),
    });

    const response = await worker.default.fetch(request, createEnv(db), {});
    expect(response.status).toBe(200);
    expect(mailPayloads).toHaveLength(1);
    const textBody = mailPayloads[0].text;
    expect(textBody).toContain('Hi Ravi Host');
    expect(textBody).not.toContain('Hi invitee');
  });

  it('rejects forged Microsoft OAuth callback state before exchanging tokens', async () => {
    global.fetch = vi.fn();

    const request = new Request('https://calendo.dev/api/auth/callback/microsoft?code=test-code&state=forged-state', {
      method: 'GET',
      redirect: 'manual',
    });

    const db = {
      prepare() {
        return { bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) };
      },
    };

    const response = await worker.default.fetch(request, createEnv(db), {});
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('error=invalid_state');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('accepts a signed Outlook calendar state and stores the connection', async () => {
    const db = createOAuthMockDB();
    const env = createEnv(db);
    const sessionToken = await registerUser(worker, env);

    const connectRequest = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
      redirect: 'manual',
    });
    const connectResponse = await worker.default.fetch(connectRequest, env, {});
    const state = new URL(connectResponse.headers.get('Location')).searchParams.get('state');

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'outlook-access', refresh_token: 'outlook-refresh', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ mail: 'outlook@example.com', userPrincipalName: 'outlook@example.com' }),
      });

    const callbackRequest = new Request(
      `https://calendo.dev/api/auth/callback/outlook-calendar?code=test-code&state=${encodeURIComponent(state)}`,
      { method: 'GET', redirect: 'manual' }
    );

    const callbackResponse = await worker.default.fetch(callbackRequest, env, {});
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get('Location')).toContain('calendar=connected');
    expect(env.DB._tables.calendar_connections).toHaveLength(1);
    expect(env.DB._tables.calendar_connections[0]).toMatchObject({
      provider: 'outlook',
      email: 'outlook@example.com',
    });
    expect(env.DB._tables.calendar_connections[0].token_expires_at).toMatch(/Z$/);
  });

  it('refreshes an expired Google token that already has a trailing Z before checking busy times', async () => {
    // Use the next Wednesday (schedule day=3) at least 2 days out, so the date is
    // always in the future no matter when the suite runs (was hardcoded 2026-06-03).
    const _d = new Date(); _d.setUTCHours(0, 0, 0, 0);
    do { _d.setUTCDate(_d.getUTCDate() + 1); } while (_d.getUTCDay() !== 3 || (_d.getTime() - Date.now()) < 2 * 86400000);
    const RDATE = _d.toISOString().slice(0, 10);
    const encryptedAccessToken = await encryptTokenForTest('stale-access', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const encryptedRefreshToken = await encryptTokenForTest('refresh-token', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const connection = {
      id: 1,
      user_id: 1,
      provider: 'google',
      access_token_encrypted: encryptedAccessToken,
      refresh_token_encrypted: encryptedRefreshToken,
      token_expires_at: '2026-03-01T00:00:00Z',
      email: 'host@example.com',
      calendar_id: 'primary',
      check_conflicts: 1,
      write_events: 1,
    };
    const schedule = {
      id: 1,
      user_id: 1,
      timezone: 'UTC',
      rules: JSON.stringify([{ day: 3, start: '09:00', end: '10:00' }]),
      overrides: '[]',
      is_default: 1,
    };

    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          json: async () => ({ access_token: 'fresh-access', expires_in: 3600 }),
        };
      }
      if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
        expect(options.headers.Authorization).toBe('Bearer fresh-access');
        return {
          ok: true,
          json: async () => ({
            calendars: {
              primary: {
                busy: [{ start: `${RDATE}T09:00:00Z`, end: `${RDATE}T09:30:00Z` }],
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('SELECT bp.user_id FROM booking_pages')) return { user_id: 1 };
                if (sql.includes('SELECT * FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1')) {
                  return {
                    id: 2,
                    user_id: 1,
                    slug: 'consultation',
                    name: 'Consultation',
                    duration_minutes: 30,
                    is_active: 1,
                    buffer_before: 0,
                    buffer_after: 0,
                    min_notice_hours: 0,
                    max_future_days: 60,
                    availability_schedule_id: null,
                  };
                }
                if (sql.includes('SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1')) return schedule;
                return null;
              },
              async all() {
                if (sql.includes('SELECT start_time, end_time, status FROM bookings')) return { results: [] };
                if (sql.includes('SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1')) {
                  return { results: args[1] === 'google' ? [connection] : [] };
                }
                if (sql.includes('SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1')) {
                  return { results: [] };
                }
                return { results: [] };
              },
              async run() {
                if (sql.includes('UPDATE calendar_connections SET access_token_encrypted = ?, token_expires_at = ?, updated_at = datetime(\'now\') WHERE id = ?')) {
                  connection.access_token_encrypted = args[0];
                  connection.token_expires_at = args[1];
                  return { success: true };
                }
                throw new Error(`Unexpected write query: ${sql}`);
              },
            };
          },
        };
      },
    };

    const request = new Request(`https://calendo.dev/api/availability/ravi/consultation?start=${RDATE}&end=${RDATE}&timezone=UTC`);
    const response = await worker.default.fetch(request, createEnv(db), {});
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.slots[RDATE]).not.toContain('09:00');
    expect(body.slots[RDATE]).toContain('09:30');
    expect(global.fetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.any(Object));
  });

  it('sends paid-booking side effects exactly once when Stripe confirms payment', async () => {
    const mailPayloads = [];
    global.fetch = vi.fn(async (url, options) => {
      if (url === 'https://api.resend.com/emails') {
        mailPayloads.push(JSON.parse(options.body));
        return {
          ok: true,
          text: async () => '{"id":"re_123"}',
        };
      }
      return { ok: true, text: async () => '' };
    });

    const tables = {
      bookings: [
        {
          id: 1,
          uid: 'booking-paid-1',
          event_type_id: 10,
          invitee_email: 'alice@example.com',
          invitee_name: 'Alice',
          invitee_timezone: 'UTC',
          start_time: '2026-04-10 09:00:00',
          end_time: '2026-04-10 09:30:00',
          status: 'pending_payment',
          cancel_token: 'cancel-token-1',
          invitee_phone: null,
        },
      ],
      event_types: [
        {
          id: 10,
          user_id: 7,
          name: 'Paid Intro',
          duration_minutes: 30,
          price_cents: 5000,
          currency: 'usd',
          location_type: null,
        },
      ],
      users: [
        {
          id: 7,
          name: 'Host User',
          email: 'host@example.com',
          timezone: 'UTC',
        },
      ],
      payments: [],
      notification_log: [],
    };

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('SELECT * FROM bookings WHERE uid = ?')) {
                  return tables.bookings.find((booking) => booking.uid === args[0]) || null;
                }
                if (sql.includes('SELECT * FROM event_types WHERE id = ?')) {
                  return tables.event_types.find((eventType) => eventType.id === args[0]) || null;
                }
                if (sql.includes('SELECT id, name, email, timezone FROM users WHERE id = ?')) {
                  return tables.users.find((user) => user.id === args[0]) || null;
                }
                return null;
              },
              async all() {
                if (sql.includes('SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1')) {
                  return { results: [] };
                }
                if (sql.includes('SELECT * FROM webhooks WHERE user_id = ? AND is_active = 1')) {
                  return { results: [] };
                }
                return { results: [] };
              },
              async run() {
                if (sql.includes("UPDATE bookings SET status = 'confirmed', updated_at = ? WHERE uid = ?")) {
                  const booking = tables.bookings.find((item) => item.uid === args[1]);
                  if (booking) {
                    booking.status = 'confirmed';
                    booking.updated_at = args[0];
                  }
                  return { success: true };
                }
                if (sql.includes('INSERT OR IGNORE INTO payments')) {
                  const existing = tables.payments.find((payment) => payment.stripe_payment_intent_id === args[3]);
                  if (!existing) {
                    tables.payments.push({
                      booking_id: args[0],
                      amount_cents: args[1],
                      currency: args[2],
                      stripe_payment_intent_id: args[3],
                      status: 'succeeded',
                    });
                  }
                  return { success: true };
                }
                if (sql.includes('INSERT INTO notification_log')) {
                  tables.notification_log.push({
                    booking_id: args[0],
                    type: args[1],
                    recipient: args[2],
                    subject: args[3],
                    status: args[4],
                  });
                  return { success: true };
                }
                throw new Error(`Unexpected write query: ${sql}`);
              },
            };
          },
        };
      },
    };

    const eventPayload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { booking_uid: 'booking-paid-1' },
          payment_intent: 'pi_test_123',
          amount_total: 5000,
        },
      },
    });
    const signature = await computeStripeSignature('whsec_test_secret', eventPayload);

    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': signature },
      body: eventPayload,
    });

    const env = createEnv(db);
    const firstResponse = await worker.default.fetch(request.clone(), env, {});
    expect(firstResponse.status).toBe(200);
    expect(tables.bookings[0].status).toBe('confirmed');
    expect(tables.payments).toHaveLength(1);
    expect(mailPayloads).toHaveLength(2);

    const secondResponse = await worker.default.fetch(request, env, {});
    expect(secondResponse.status).toBe(200);
    expect(tables.payments).toHaveLength(1);
    expect(mailPayloads).toHaveLength(2);
  });
});
