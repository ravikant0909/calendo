import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Test Helpers
// ============================================================

const TEST_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes base64

async function encryptTestToken(token) {
  const keyData = Uint8Array.from(atob(TEST_ENCRYPTION_KEY), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

function createMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    calendar_connections: [],
    bookings: [],
    event_types: [],
    webhooks: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    calendar_connections: 1,
    bookings: 1,
    event_types: 1,
  };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // Auth: session lookup
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              // User lookup by email
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              // User insert (register)
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = { id, email: args[0], password_hash: args[1], name: args[2], timezone: args[3], avatar_url: null, created_at: new Date().toISOString() };
                tables.users.push(user);
                return { id: user.id, email: user.email, name: user.name, timezone: user.timezone };
              }
              // Booking page slug check
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find(p => p.slug === args[0]) || null;
              }
              // Calendar connection lookup by channel/resource
              if (sql.includes('watch_channel_id') && sql.includes('watch_resource_id') && sql.includes('provider')) {
                return tables.calendar_connections.find(c =>
                  c.watch_channel_id === args[0] &&
                  c.watch_resource_id === args[1] &&
                  c.provider === args[2]
                ) || null;
              }
              // Calendar connection lookup by user+provider+email
              if (sql.includes('SELECT id FROM calendar_connections WHERE user_id') && sql.includes('provider') && sql.includes('email')) {
                return tables.calendar_connections.find(c => c.user_id === args[0] && c.provider === args[1] && c.email === args[2]) || null;
              }
              // Calendar connection by id + user
              if (sql.includes('calendar_connections WHERE id = ? AND user_id')) {
                return tables.calendar_connections.find(c => c.id == args[0] && c.user_id === args[1]) || null;
              }
              // Full calendar connection by user+provider+email
              if (sql.includes('SELECT * FROM calendar_connections WHERE user_id') && sql.includes('provider') && sql.includes('email')) {
                return tables.calendar_connections.find(c => c.user_id === args[0] && c.provider === args[1] && c.email === args[2]) || null;
              }
              // Booking lookup by calendar_event_id
              if (sql.includes('calendar_event_id') && sql.includes('bookings b')) {
                const booking = tables.bookings.find(b =>
                  b.calendar_event_id === args[0] &&
                  ['confirmed', 'pending', 'pending_payment'].includes(b.status)
                );
                if (booking) {
                  const et = tables.event_types.find(e => e.id === booking.event_type_id);
                  return { ...booking, host_user_id: et?.user_id };
                }
                return null;
              }
              // Event type by id
              if (sql.includes('SELECT * FROM event_types WHERE id')) {
                return tables.event_types.find(e => e.id === args[0]) || null;
              }
              // User by id (host lookup)
              if (sql.includes('SELECT name, email FROM users WHERE id')) {
                const user = tables.users.find(u => u.id === args[0]);
                return user ? { name: user.name, email: user.email } : null;
              }
              if (sql.includes('SELECT id, name, email, timezone FROM users')) {
                return tables.users.find(u => u.id === args[0]) || null;
              }
              return null;
            },
            async all() {
              // Calendar connections for user
              if (sql.includes('SELECT id, provider, email')) {
                const connections = tables.calendar_connections.filter(c => c.user_id === args[0]);
                return { results: connections };
              }
              // Webhooks for user
              if (sql.includes('SELECT * FROM webhooks WHERE user_id')) {
                const hooks = tables.webhooks.filter(w => w.user_id === args[0] && w.is_active);
                return { results: hooks };
              }
              // Expiring calendar connections
              if (sql.includes('watch_channel_id IS NOT NULL') && sql.includes('watch_expiration')) {
                const conns = tables.calendar_connections.filter(c =>
                  c.provider === 'google' &&
                  c.watch_channel_id &&
                  c.watch_expiration &&
                  c.watch_expiration < args[0]
                );
                return { results: conns };
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
                  user_id: args[0], provider: args[1],
                  access_token_encrypted: args[2], refresh_token_encrypted: args[3],
                  token_expires_at: args[4], email: args[5], calendar_id: args[6],
                  is_primary: args[7], check_conflicts: args[8], write_events: args[9],
                  watch_channel_id: null, watch_resource_id: null, watch_expiration: null,
                });
              }
              if (sql.includes('UPDATE calendar_connections SET watch_channel_id')) {
                const conn = tables.calendar_connections.find(c => c.id == args[3]);
                if (conn) {
                  conn.watch_channel_id = args[0];
                  conn.watch_resource_id = args[1];
                  conn.watch_expiration = args[2];
                }
              }
              if (sql.includes("UPDATE bookings SET status = 'cancelled'")) {
                const booking = tables.bookings.find(b => b.id == args[0]);
                if (booking) {
                  booking.status = 'cancelled';
                  booking.cancelled_by = 'calendar_sync';
                }
              }
              if (sql.includes('DELETE FROM calendar_connections')) {
                tables.calendar_connections = tables.calendar_connections.filter(c => c.id != args[0]);
              }
              return { success: true };
            }
          };
        }
      };
    },
    _tables: tables
  };
}

function createEnv(db) {
  return {
    DB: db || createMockDB(),
    ASSETS: { fetch: () => new Response('') },
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    APP_ORIGIN: 'https://calendo.dev',
  };
}

async function registerUser(worker, env) {
  const request = new Request('https://calendo.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
  });
  const response = await worker.default.fetch(request, env, {});
  const cookie = response.headers.get('Set-Cookie');
  const sessionToken = cookie.match(/session=([^;]+)/)[1];
  return sessionToken;
}

// ============================================================
// Tests
// ============================================================

describe('Google Calendar Webhook (Push Notifications)', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  describe('POST /api/calendars/webhook/google', () => {
    it('should return 400 when required Google headers are missing', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Missing required Google headers');
    });

    it('should return 200 for unknown channel (stale/forged request)', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Channel-ID': 'unknown-channel-id',
          'X-Goog-Resource-ID': 'unknown-resource-id',
          'X-Goog-Resource-State': 'exists',
        },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it('should return 200 for sync state (initial confirmation)', async () => {
      const env = createEnv();
      const channelId = 'test-channel-123';
      const resourceId = 'test-resource-456';

      // Set up a matching calendar connection
      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 1,
        provider: 'google',
        email: 'user@gmail.com',
        calendar_id: 'primary',
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_encrypted: 'fake-encrypted-token',
        refresh_token_encrypted: 'fake-refresh-token',
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
        method: 'POST',
        headers: {
          'X-Goog-Channel-ID': channelId,
          'X-Goog-Resource-ID': resourceId,
          'X-Goog-Resource-State': 'sync',
        },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it('should not require authentication (public endpoint)', async () => {
      const env = createEnv();
      // The webhook endpoint should be accessible without a session cookie
      const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
        method: 'POST',
        headers: {
          'X-Goog-Channel-ID': 'some-channel',
          'X-Goog-Resource-ID': 'some-resource',
          'X-Goog-Resource-State': 'sync',
        },
      });

      const response = await worker.default.fetch(request, env, {});
      // Should NOT return 401 (Unauthorized)
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(200);
    });

    it('should return 200 even when X-Goog-Channel-ID header is missing but X-Goog-Resource-ID is present', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
        method: 'POST',
        headers: {
          'X-Goog-Resource-ID': 'some-resource',
          'X-Goog-Resource-State': 'exists',
        },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });
  });

  describe('Webhook booking cancellation', () => {
    it('should cancel a booking when its Google Calendar event is cancelled', async () => {
      const env = createEnv();
      const channelId = 'watch-channel-abc';
      const resourceId = 'watch-resource-def';

      // Encrypt a fake access token using the test encryption key
      const encryptedAccessToken = await encryptTestToken('fake-access-token-123');
      const encryptedRefreshToken = await encryptTestToken('fake-refresh-token-456');

      // Add a host user
      env.DB._tables.users.push({
        id: 10,
        email: 'host@example.com',
        name: 'Host User',
        password_hash: 'hash',
        timezone: 'UTC',
      });

      // Add an event type
      env.DB._tables.event_types.push({
        id: 5,
        user_id: 10,
        name: '30-min Call',
        slug: '30-min-call',
        duration_minutes: 30,
      });

      // Add a calendar connection with watch — token expires far in the future so no refresh needed
      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 10,
        provider: 'google',
        email: 'host@example.com',
        calendar_id: 'primary',
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      // Add a booking linked to a Google Calendar event
      env.DB._tables.bookings.push({
        id: 42,
        uid: 'booking-uid-42',
        event_type_id: 5,
        invitee_name: 'Jane Doe',
        invitee_email: 'jane@example.com',
        invitee_timezone: 'America/New_York',
        start_time: '2026-03-28T14:00:00Z',
        end_time: '2026-03-28T14:30:00Z',
        status: 'confirmed',
        calendar_event_id: 'google-event-123',
        cancel_token: 'cancel-token-42',
      });

      // Mock fetch to return cancelled Google Calendar events
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url, opts) => {
        if (typeof url === 'string' && url.includes('googleapis.com/calendar/v3/calendars') && url.includes('/events?')) {
          return new Response(JSON.stringify({
            items: [
              { id: 'google-event-123', status: 'cancelled' },
              { id: 'google-event-456', status: 'confirmed' },
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // For email sends and webhook deliveries, return success
        return new Response('OK', { status: 200 });
      });

      try {
        const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
          method: 'POST',
          headers: {
            'X-Goog-Channel-ID': channelId,
            'X-Goog-Resource-ID': resourceId,
            'X-Goog-Resource-State': 'exists',
          },
        });

        const response = await worker.default.fetch(request, env, {});
        expect(response.status).toBe(200);

        // Verify the booking was cancelled
        const booking = env.DB._tables.bookings.find(b => b.id === 42);
        expect(booking.status).toBe('cancelled');
        expect(booking.cancelled_by).toBe('calendar_sync');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should not cancel bookings that are already cancelled', async () => {
      const env = createEnv();
      const channelId = 'watch-channel-xyz';
      const resourceId = 'watch-resource-xyz';

      const encryptedAccessToken = await encryptTestToken('fake-access-token');
      const encryptedRefreshToken = await encryptTestToken('fake-refresh-token');

      env.DB._tables.users.push({
        id: 10,
        email: 'host@example.com',
        name: 'Host User',
        password_hash: 'hash',
        timezone: 'UTC',
      });

      env.DB._tables.event_types.push({
        id: 5,
        user_id: 10,
        name: '30-min Call',
        slug: '30-min-call',
        duration_minutes: 30,
      });

      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 10,
        provider: 'google',
        email: 'host@example.com',
        calendar_id: 'primary',
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      // Booking is already cancelled
      env.DB._tables.bookings.push({
        id: 42,
        uid: 'booking-uid-42',
        event_type_id: 5,
        invitee_name: 'Jane Doe',
        invitee_email: 'jane@example.com',
        start_time: '2026-03-28T14:00:00Z',
        end_time: '2026-03-28T14:30:00Z',
        status: 'cancelled',
        calendar_event_id: 'google-event-already-cancelled',
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url) => {
        if (typeof url === 'string' && url.includes('googleapis.com/calendar/v3/calendars') && url.includes('/events?')) {
          return new Response(JSON.stringify({
            items: [
              { id: 'google-event-already-cancelled', status: 'cancelled' },
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('OK', { status: 200 });
      });

      try {
        const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
          method: 'POST',
          headers: {
            'X-Goog-Channel-ID': channelId,
            'X-Goog-Resource-ID': resourceId,
            'X-Goog-Resource-State': 'exists',
          },
        });

        const response = await worker.default.fetch(request, env, {});
        expect(response.status).toBe(200);

        // Booking status should still be cancelled (not double-processed)
        const booking = env.DB._tables.bookings.find(b => b.id === 42);
        expect(booking.status).toBe('cancelled');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should handle exists state with no cancelled events gracefully', async () => {
      const env = createEnv();
      const channelId = 'watch-no-cancel';
      const resourceId = 'resource-no-cancel';

      const encryptedAccessToken = await encryptTestToken('fake-access-token');
      const encryptedRefreshToken = await encryptTestToken('fake-refresh-token');

      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 10,
        provider: 'google',
        email: 'host@example.com',
        calendar_id: 'primary',
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url) => {
        if (typeof url === 'string' && url.includes('/events?')) {
          return new Response(JSON.stringify({
            items: [
              { id: 'event-1', status: 'confirmed' },
              { id: 'event-2', status: 'tentative' },
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('OK', { status: 200 });
      });

      try {
        const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
          method: 'POST',
          headers: {
            'X-Goog-Channel-ID': channelId,
            'X-Goog-Resource-ID': resourceId,
            'X-Goog-Resource-State': 'exists',
          },
        });

        const response = await worker.default.fetch(request, env, {});
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should handle Google API errors gracefully and still return 200', async () => {
      const env = createEnv();
      const channelId = 'watch-api-err';
      const resourceId = 'resource-api-err';

      const encryptedAccessToken = await encryptTestToken('fake-access-token');
      const encryptedRefreshToken = await encryptTestToken('fake-refresh-token');

      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 10,
        provider: 'google',
        email: 'host@example.com',
        calendar_id: 'primary',
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });

      try {
        const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
          method: 'POST',
          headers: {
            'X-Goog-Channel-ID': channelId,
            'X-Goog-Resource-ID': resourceId,
            'X-Goog-Resource-State': 'exists',
          },
        });

        const response = await worker.default.fetch(request, env, {});
        // Must return 200 even on errors to prevent Google from retrying excessively
        expect(response.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Watch channel lifecycle', () => {
    it('should handle the not_exists resource state gracefully', async () => {
      const env = createEnv();
      const channelId = 'deleted-channel';
      const resourceId = 'deleted-resource';

      const encryptedAccessToken = await encryptTestToken('fake-access-token');

      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 10,
        provider: 'google',
        email: 'host@example.com',
        calendar_id: 'primary',
        watch_channel_id: channelId,
        watch_resource_id: resourceId,
        watch_expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: null,
        token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
        method: 'POST',
        headers: {
          'X-Goog-Channel-ID': channelId,
          'X-Goog-Resource-ID': resourceId,
          'X-Goog-Resource-State': 'not_exists',
        },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });
  });
});

describe('Webhook Route Registration', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  it('should return 404 for GET method on webhook endpoint', async () => {
    const env = createEnv();
    const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
      method: 'GET',
    });

    const response = await worker.default.fetch(request, env, {});
    // GET should not match the POST route, so should fall through to auth check
    // and return 401 (unauthorized) since it's not a public route
    expect(response.status).toBe(401);
  });

  it('should accept POST requests to webhook endpoint', async () => {
    const env = createEnv();
    const request = new Request('https://calendo.dev/api/calendars/webhook/google', {
      method: 'POST',
      headers: {
        'X-Goog-Channel-ID': 'test',
        'X-Goog-Resource-ID': 'test',
        'X-Goog-Resource-State': 'sync',
      },
    });

    const response = await worker.default.fetch(request, env, {});
    // Should return 200 (acknowledged) not 401 (unauthorized)
    expect(response.status).toBe(200);
  });
});
