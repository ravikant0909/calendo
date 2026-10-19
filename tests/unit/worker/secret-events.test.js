import { describe, it, expect, beforeEach } from 'vitest';

// Helper to create a mock D1 database with event type support
function createMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    event_types: [],
    bookings: [],
    org_members: [],
    calendar_connections: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    event_types: 1,
  };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // Auth - session lookup
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              // User lookup by email (for registration)
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              // Insert user
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = {
                  id,
                  email: args[0],
                  password_hash: args[1],
                  name: args[2],
                  timezone: args[3],
                  avatar_url: null,
                  email_verified: 0,
                  created_at: new Date().toISOString(),
                };
                tables.users.push(user);
                return { id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
              }
              // Booking page slug check
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find(p => p.slug === args[0]) || null;
              }
              // Default availability schedule
              if (sql.includes('SELECT id FROM availability_schedules')) {
                return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
              }
              // Booking page with user info (public)
              if (sql.includes('SELECT bp.*, u.name, u.avatar_url') && sql.includes('booking_pages')) {
                const page = tables.booking_pages.find(p => p.slug === args[0]);
                if (!page) return null;
                const user = tables.users.find(u => u.id === page.user_id);
                return { ...page, name: user?.name, avatar_url: user?.avatar_url };
              }
              // Event type slug uniqueness check
              if (sql.includes('SELECT id FROM event_types WHERE user_id') && sql.includes('slug')) {
                return tables.event_types.find(e => e.user_id === args[0] && e.slug === args[1] && e.is_active) || null;
              }
              // Get single event type by id and user_id
              if (sql.includes('SELECT * FROM event_types WHERE id = ? AND user_id = ?')) {
                return tables.event_types.find(e => e.id == args[0] && e.user_id == args[1]) || null;
              }
              // Get single event type by id only (for update permission check)
              if (sql.includes('SELECT * FROM event_types WHERE id = ?') && !sql.includes('user_id')) {
                return tables.event_types.find(e => e.id == args[0]) || null;
              }
              // Secret event lookup for booking page
              if (sql.includes('FROM event_types') && sql.includes('is_secret = 1') && sql.includes('slug')) {
                return tables.event_types.find(e => e.user_id == args[0] && e.slug === args[1] && e.is_active && e.is_secret) || null;
              }
              // Insert event type
              if (sql.includes('INSERT INTO event_types')) {
                const id = autoIncrement.event_types++;
                const et = {
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
                  is_active: 1,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };
                tables.event_types.push(et);
                return { ...et };
              }
              // Update event type
              if (sql.includes('UPDATE event_types SET') && sql.includes('RETURNING *')) {
                // The last arg is the id (WHERE id = ?)
                const etId = args[args.length - 1];
                const et = tables.event_types.find(e => e.id == etId);
                if (!et) return null;
                // Parse SET clauses to figure out what changed
                const setClauses = sql.match(/SET (.+?) WHERE/)?.[1] || '';
                const fields = setClauses.split(',').map(f => f.trim().split('=')[0].trim()).filter(f => f !== "updated_at");
                let argIdx = 0;
                for (const field of fields) {
                  if (field.includes('datetime')) continue;
                  et[field] = args[argIdx++];
                }
                et.updated_at = new Date().toISOString();
                return { ...et };
              }
              return null;
            },
            async all() {
              // List all event types for user (dashboard - includes secret)
              if (sql.includes('SELECT * FROM event_types WHERE user_id') && !sql.includes('is_secret')) {
                const userId = args[0];
                return { results: tables.event_types.filter(e => e.user_id === userId) };
              }
              // List public event types (non-secret only)
              if (sql.includes('FROM event_types') && sql.includes('is_secret = 0')) {
                const userId = args[0];
                return { results: tables.event_types.filter(e => e.user_id === userId && e.is_active && !e.is_secret) };
              }
              // Org event types
              if (sql.includes('FROM event_types et') && sql.includes('org_members')) {
                return { results: [] };
              }
              // Calendar connections
              if (sql.includes('calendar_connections')) {
                return { results: [] };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({
                  id: autoIncrement.booking_pages++,
                  user_id: args[0],
                  slug: args[1],
                  display_name: args[2],
                  blocked_emails: null,
                });
              }
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({
                  id: autoIncrement.availability_schedules++,
                  user_id: args[0],
                  name: args[1],
                  timezone: args[2],
                  rules: args[3],
                  is_default: args[4],
                });
              }
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({
                  id: args[0],
                  user_id: args[1],
                  token: args[2],
                  expires_at: args[3],
                });
              }
              if (sql.includes('DELETE FROM sessions')) {
                tables.sessions = tables.sessions.filter(s => s.token !== args[0]);
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

function createEnv(db) {
  return {
    DB: db || createMockDB(),
    ASSETS: { fetch: () => new Response('') },
  };
}

describe('Secret/Hidden Event Types', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  // Register a user and return { env, sessionToken }
  async function registerUser(env, email = 'host@example.com') {
    const regReq = new Request('https://calendo.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', name: 'Test Host' }),
    });
    const regRes = await worker.default.fetch(regReq, env, {});
    const setCookie = regRes.headers.get('Set-Cookie') || '';
    const tokenMatch = setCookie.match(/session=([^;]+)/);
    const sessionToken = tokenMatch ? tokenMatch[1] : null;
    return sessionToken;
  }

  // Create an event type
  async function createEventType(env, sessionToken, overrides = {}) {
    const payload = {
      name: overrides.name || 'Test Meeting',
      duration_minutes: overrides.duration_minutes || 30,
      is_secret: overrides.is_secret || false,
      ...overrides,
    };
    const req = new Request('https://calendo.dev/api/event-types', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    const res = await worker.default.fetch(req, env, {});
    return { response: res, data: await res.json() };
  }

  describe('Creating secret event types', () => {
    it('should create an event type with is_secret=true', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      const { response, data } = await createEventType(env, sessionToken, {
        name: 'VIP Meeting',
        is_secret: true,
      });

      expect(response.status).toBe(201);
      expect(data.is_secret).toBe(1);
      expect(data.name).toBe('VIP Meeting');
    });

    it('should create an event type with is_secret=false by default', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      const { response, data } = await createEventType(env, sessionToken, {
        name: 'Public Meeting',
      });

      expect(response.status).toBe(201);
      expect(data.is_secret).toBe(0);
    });
  });

  describe('Dashboard lists all event types including secret', () => {
    it('should return both secret and non-secret event types in GET /api/event-types', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      await createEventType(env, sessionToken, { name: 'Public Meeting' });
      await createEventType(env, sessionToken, { name: 'Secret VIP', is_secret: true });

      const req = new Request('https://calendo.dev/api/event-types', {
        method: 'GET',
        headers: { Cookie: `session=${sessionToken}` },
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.length).toBe(2);
      const names = data.map(e => e.name);
      expect(names).toContain('Public Meeting');
      expect(names).toContain('Secret VIP');
    });
  });

  describe('Public booking page excludes secret event types', () => {
    it('should NOT include secret event types in public listing', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      await createEventType(env, sessionToken, { name: 'Public Meeting' });
      await createEventType(env, sessionToken, { name: 'Secret VIP', is_secret: true });

      const req = new Request('https://calendo.dev/api/booking-page/test-host', {
        method: 'GET',
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const data = await res.json();
      const names = data.eventTypes.map(e => e.name);
      expect(names).toContain('Public Meeting');
      expect(names).not.toContain('Secret VIP');
    });

    it('should include a secret event type when accessed via direct link with ?event= param', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      await createEventType(env, sessionToken, { name: 'Public Meeting' });
      const { data: secretEt } = await createEventType(env, sessionToken, { name: 'Secret VIP', is_secret: true });

      const req = new Request(`https://calendo.dev/api/booking-page/test-host?event=${secretEt.slug}`, {
        method: 'GET',
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const data = await res.json();
      const names = data.eventTypes.map(e => e.name);
      expect(names).toContain('Public Meeting');
      expect(names).toContain('Secret VIP');
    });

    it('should not include non-existent event slug when ?event= is provided', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      await createEventType(env, sessionToken, { name: 'Public Meeting' });

      const req = new Request('https://calendo.dev/api/booking-page/test-host?event=non-existent', {
        method: 'GET',
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.eventTypes.length).toBe(1);
      expect(data.eventTypes[0].name).toBe('Public Meeting');
    });
  });

  describe('Toggle is_secret on/off via PUT', () => {
    it('should toggle is_secret from false to true', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      const { data: et } = await createEventType(env, sessionToken, { name: 'My Meeting' });
      expect(et.is_secret).toBe(0);

      const req = new Request(`https://calendo.dev/api/event-types/${et.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${sessionToken}`,
        },
        body: JSON.stringify({ is_secret: true }),
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const updated = await res.json();
      expect(updated.is_secret).toBe(1);
    });

    it('should toggle is_secret from true to false', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      const { data: et } = await createEventType(env, sessionToken, { name: 'Secret Meeting', is_secret: true });
      expect(et.is_secret).toBe(1);

      const req = new Request(`https://calendo.dev/api/event-types/${et.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${sessionToken}`,
        },
        body: JSON.stringify({ is_secret: false }),
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const updated = await res.json();
      expect(updated.is_secret).toBe(0);
    });
  });

  describe('GET single event type returns is_secret', () => {
    it('should include is_secret field in GET /api/event-types/:id', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(env);

      const { data: et } = await createEventType(env, sessionToken, { name: 'Secret Meeting', is_secret: true });

      const req = new Request(`https://calendo.dev/api/event-types/${et.id}`, {
        method: 'GET',
        headers: { Cookie: `session=${sessionToken}` },
      });
      const res = await worker.default.fetch(req, env, {});
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.is_secret).toBe(1);
      expect(data.name).toBe('Secret Meeting');
    });
  });
});
