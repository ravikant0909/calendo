import { describe, it, expect, beforeEach, vi } from 'vitest';

// Helper to create a mock DB that handles event_types with redirect_url
function createMockDB(options = {}) {
  const eventTypes = options.eventTypes || [];
  const users = options.users || [];
  const sessions = options.sessions || [];
  const bookingPages = options.bookingPages || [];
  const availabilitySchedules = options.availabilitySchedules || [];
  let etAutoId = 100;

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // Auth: session lookup
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              // Event type by id and user_id
              if (sql.includes('SELECT * FROM event_types WHERE id = ? AND user_id = ?')) {
                return eventTypes.find(et => et.id === Number(args[0]) && et.user_id === Number(args[1])) || null;
              }
              // Event type by id only (for update with org permission check)
              if (sql.includes('SELECT * FROM event_types WHERE id = ?') && !sql.includes('user_id')) {
                return eventTypes.find(et => et.id === Number(args[0])) || null;
              }
              // Slug uniqueness check
              if (sql.includes('SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1')) {
                return eventTypes.find(et => et.user_id === args[0] && et.slug === args[1] && et.is_active) || null;
              }
              // Default availability schedule
              if (sql.includes('SELECT id FROM availability_schedules WHERE user_id = ? AND is_default = 1')) {
                return availabilitySchedules.find(s => s.user_id === args[0] && s.is_default) || null;
              }
              // Booking page lookup
              if (sql.includes('booking_pages') && sql.includes('slug')) {
                return bookingPages.find(bp => bp.slug === args[0]) || null;
              }
              // Event type for public booking page
              if (sql.includes('FROM event_types') && sql.includes('user_id = ? AND slug = ? AND is_active = 1') && sql.includes('is_secret = 0')) {
                return null;
              }
              if (sql.includes('FROM event_types') && sql.includes('user_id = ? AND slug = ? AND is_active = 1') && sql.includes('is_secret = 1')) {
                return eventTypes.find(et => et.user_id === args[0] && et.slug === args[1] && et.is_active && et.is_secret) || null;
              }
              // INSERT returning
              if (sql.includes('INSERT INTO event_types')) {
                const id = etAutoId++;
                const result = {
                  id,
                  user_id: args[0],
                  name: args[1],
                  slug: args[2],
                  description: args[3],
                  duration_minutes: args[4],
                  color: args[5],
                  location_type: args[6],
                  location_config: args[7],
                  questions: args[8],
                  is_secret: args[9],
                  requires_confirmation: args[10],
                  max_bookings_per_day: args[11],
                  slot_interval: args[12],
                  buffer_before: args[13],
                  buffer_after: args[14],
                  min_notice_hours: args[15],
                  max_future_days: args[16],
                  availability_schedule_id: args[17],
                  org_id: args[18],
                  round_robin_mode: args[19],
                  price_cents: args[20],
                  currency: args[21],
                  payment_method: args[22],
                  group_max_attendees: args[23],
                  sort_order: args[24],
                  locked_timezone: args[25],
                  redirect_url: args[26],
                  is_active: 1,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };
                eventTypes.push(result);
                return result;
              }
              // UPDATE returning
              if (sql.includes('UPDATE event_types SET') && sql.includes('RETURNING')) {
                const etId = args[args.length - 1];
                const et = eventTypes.find(e => e.id === Number(etId));
                if (!et) return null;
                // Apply fields from the SET clause
                const setMatch = sql.match(/SET (.+?) WHERE/);
                if (setMatch) {
                  const fields = setMatch[1].split(',').map(f => f.trim().split(' = ')[0]);
                  for (let i = 0; i < fields.length; i++) {
                    et[fields[i]] = args[i];
                  }
                }
                return et;
              }
              // User lookup
              if (sql.includes('SELECT id, name, email, timezone FROM users WHERE id = ?')) {
                return users.find(u => u.id === args[0]) || null;
              }
              return null;
            },
            async all() {
              // Event types for booking page
              if (sql.includes('FROM event_types') && sql.includes('is_active = 1') && sql.includes('is_secret = 0')) {
                const results = eventTypes.filter(et => et.user_id === args[0] && et.is_active && !et.is_secret);
                return { results };
              }
              // Event types list for user
              if (sql.includes('SELECT * FROM event_types WHERE user_id = ?')) {
                return { results: eventTypes.filter(et => et.user_id === args[0]) };
              }
              // Org event types
              if (sql.includes('org_members')) {
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

function createEnv(db, overrides = {}) {
  return {
    DB: db,
    ASSETS: { fetch: () => new Response('') },
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    MICROSOFT_CLIENT_ID: 'test-ms-client-id',
    MICROSOFT_CLIENT_SECRET: 'test-ms-client-secret',
    ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ...overrides,
  };
}

describe('Post-booking Redirect URL', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
  });

  describe('Create event type with redirect_url', () => {
    it('should accept a valid redirect_url when creating an event type', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const schedules = [{ id: 1, user_id: 1, is_default: true }];
      const db = createMockDB({ users, sessions, availabilitySchedules: schedules });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          name: 'Test Meeting',
          duration_minutes: 30,
          redirect_url: 'https://example.com/thank-you',
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.redirect_url).toBe('https://example.com/thank-you');
    });

    it('should accept null redirect_url', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const schedules = [{ id: 1, user_id: 1, is_default: true }];
      const db = createMockDB({ users, sessions, availabilitySchedules: schedules });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          name: 'No Redirect Meeting',
          duration_minutes: 30,
          redirect_url: null,
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.redirect_url).toBeNull();
    });

    it('should reject invalid redirect_url', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const schedules = [{ id: 1, user_id: 1, is_default: true }];
      const db = createMockDB({ users, sessions, availabilitySchedules: schedules });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          name: 'Bad Redirect Meeting',
          duration_minutes: 30,
          redirect_url: 'not-a-valid-url',
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('redirect_url must be a valid URL');
    });

    it('should reject non-http/https redirect_url', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const schedules = [{ id: 1, user_id: 1, is_default: true }];
      const db = createMockDB({ users, sessions, availabilitySchedules: schedules });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          name: 'FTP Redirect',
          duration_minutes: 30,
          redirect_url: 'ftp://files.example.com/thanks',
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('http or https protocol');
    });
  });

  describe('Update event type redirect_url', () => {
    it('should update redirect_url on an event type', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const eventTypes = [{
        id: 10, user_id: 1, name: 'Meeting', slug: 'meeting',
        redirect_url: null, is_active: 1,
      }];
      const db = createMockDB({ users, sessions, eventTypes });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types/10', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          redirect_url: 'https://my-site.com/booked',
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.redirect_url).toBe('https://my-site.com/booked');
    });

    it('should clear redirect_url with empty string', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const eventTypes = [{
        id: 10, user_id: 1, name: 'Meeting', slug: 'meeting',
        redirect_url: 'https://example.com/old', is_active: 1,
      }];
      const db = createMockDB({ users, sessions, eventTypes });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types/10', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          redirect_url: '',
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.redirect_url).toBeNull();
    });

    it('should reject invalid URL on update', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', password_hash: 'hash' }];
      const sessions = [{ token: 'valid-session', user_id: 1 }];
      const eventTypes = [{
        id: 10, user_id: 1, name: 'Meeting', slug: 'meeting',
        redirect_url: null, is_active: 1,
      }];
      const db = createMockDB({ users, sessions, eventTypes });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/event-types/10', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=valid-session',
        },
        body: JSON.stringify({
          redirect_url: 'totally-not-a-url',
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('redirect_url must be a valid URL');
    });
  });

  describe('Public booking page includes redirect_url', () => {
    it('should return redirect_url in public event type data', async () => {
      const users = [{ id: 1, email: 'host@example.com', name: 'Host', timezone: 'UTC', avatar_url: null }];
      const bookingPages = [{ slug: 'testhost', user_id: 1, display_name: 'Host', blocked_emails: null }];
      const eventTypes = [{
        id: 10, user_id: 1, name: 'Quick Call', slug: 'quick-call',
        description: 'A quick call', duration_minutes: 15, color: '#0069ff',
        location_type: 'google_meet', location_config: '{}', questions: '[]',
        locked_timezone: null, price_cents: null, currency: 'usd',
        redirect_url: 'https://example.com/thank-you',
        is_active: 1, is_secret: 0, sort_order: 0,
      }];
      const db = createMockDB({ users, bookingPages, eventTypes });
      const env = createEnv(db);

      const request = new Request('https://calendo.dev/api/booking-page/testhost', {
        method: 'GET',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.eventTypes).toBeDefined();
      expect(data.eventTypes.length).toBeGreaterThanOrEqual(1);
      const et = data.eventTypes.find(e => e.slug === 'quick-call');
      expect(et).toBeDefined();
      expect(et.redirect_url).toBe('https://example.com/thank-you');
    });
  });

  describe('URL parameter encoding', () => {
    it('should properly encode URL parameters with special characters', () => {
      // Simulate what the booking page frontend does
      const redirectUrl = 'https://example.com/thank-you';
      const rUrl = new URL(redirectUrl);
      rUrl.searchParams.set('invitee_name', 'John O\'Brien');
      rUrl.searchParams.set('invitee_email', 'john+test@example.com');
      rUrl.searchParams.set('event_type', 'quick-call');
      rUrl.searchParams.set('start_time', '2026-04-10T14:00:00Z');

      const result = rUrl.toString();
      expect(result).toContain('invitee_name=John');
      expect(result).toContain('invitee_email=john%2Btest%40example.com');
      expect(result).toContain('event_type=quick-call');
      expect(result).toContain('start_time=2026-04-10T14%3A00%3A00Z');

      // Verify it's a valid URL that can be parsed back
      const parsed = new URL(result);
      expect(parsed.searchParams.get('invitee_name')).toBe('John O\'Brien');
      expect(parsed.searchParams.get('invitee_email')).toBe('john+test@example.com');
      expect(parsed.searchParams.get('event_type')).toBe('quick-call');
      expect(parsed.searchParams.get('start_time')).toBe('2026-04-10T14:00:00Z');
    });

    it('should handle redirect URLs that already have query parameters', () => {
      const redirectUrl = 'https://example.com/thank-you?source=calendo';
      const rUrl = new URL(redirectUrl);
      rUrl.searchParams.set('invitee_name', 'Alice');
      rUrl.searchParams.set('invitee_email', 'alice@example.com');
      rUrl.searchParams.set('event_type', 'meeting');
      rUrl.searchParams.set('start_time', '2026-04-10T10:00:00Z');

      const result = rUrl.toString();
      expect(result).toContain('source=calendo');
      expect(result).toContain('invitee_name=Alice');
      expect(result).toContain('invitee_email=alice%40example.com');
    });
  });
});
