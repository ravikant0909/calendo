import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ============================================================
// Mock DB helper — tailored for dashboard AI tool execution
// ============================================================

function createMockDB(opts = {}) {
  const tables = {
    users: opts.users || [],
    sessions: opts.sessions || [],
    booking_pages: opts.bookingPages || [],
    availability_schedules: opts.availabilitySchedules || [],
    event_types: opts.eventTypes || [],
    bookings: opts.bookings || [],
    calendar_connections: opts.calendarConnections || [],
    ai_conversations: opts.aiConversations || [],
  };
  let autoIncrement = {
    event_types: (opts.eventTypes || []).length + 1,
    bookings: (opts.bookings || []).length + 1,
  };

  // Track all SQL statements for assertions
  const queries = [];

  return {
    _tables: tables,
    _queries: queries,
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return {
            async first() {
              // Auth: session lookup
              if (sql.includes('SELECT s.user_id, u.*') && sql.includes('sessions')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }

              // Event types by id + user_id
              if (sql.includes('FROM event_types WHERE id = ?') && sql.includes('user_id')) {
                return tables.event_types.find(et => et.id === args[0] && et.user_id === args[1]) || null;
              }
              // Event type name by id + user_id (delete_event_type)
              if (sql.includes('SELECT name FROM event_types WHERE id = ?')) {
                return tables.event_types.find(et => et.id === args[0] && et.user_id === args[1]) || null;
              }

              // Booking page slug by user_id
              if (sql.includes('FROM booking_pages WHERE user_id = ?') && !sql.includes('UPDATE')) {
                return tables.booking_pages.find(bp => bp.user_id === args[0]) || null;
              }
              // Booking page by slug
              if (sql.includes('SELECT id FROM booking_pages WHERE slug = ?')) {
                return tables.booking_pages.find(bp => bp.slug === args[0]) || null;
              }

              // Event type slug by id + user_id (get_booking_link)
              if (sql.includes('SELECT slug, name FROM event_types WHERE id = ?')) {
                return tables.event_types.find(et => et.id === args[0] && et.user_id === args[1]) || null;
              }

              // Availability schedule default
              if (sql.includes('FROM availability_schedules WHERE user_id = ?') && sql.includes('is_default = 1')) {
                return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
              }

              // AI conversation by session_id
              if (sql.includes('FROM ai_conversations WHERE session_id')) {
                return tables.ai_conversations.find(c => c.session_id === args[0]) || null;
              }

              // Booking by id + user join (cancel_booking)
              if (sql.includes('FROM bookings b JOIN event_types et') && sql.includes('WHERE b.id = ?')) {
                const booking = tables.bookings.find(b => b.id === args[0]);
                if (!booking) return null;
                const et = tables.event_types.find(e => e.id === booking.event_type_id && e.user_id === args[1]);
                if (!et) return null;
                return booking;
              }

              // Analytics: COUNT(*)
              if (sql.includes('SELECT COUNT(*)') && sql.includes('bookings')) {
                let count = 0;
                const userId = args[0];
                for (const b of tables.bookings) {
                  const et = tables.event_types.find(e => e.id === b.event_type_id && e.user_id === userId);
                  if (!et) continue;
                  if (sql.includes("status = 'cancelled'")) {
                    if (b.status === 'cancelled') count++;
                  } else if (sql.includes("start of month")) {
                    count++; // simplified: count all
                  } else {
                    count++;
                  }
                }
                return { count };
              }

              // Custom domain lookup — return null for calendo.dev
              if (sql.includes('custom_domain')) {
                return null;
              }

              return null;
            },
            async all() {
              // Event types for user
              if (sql.includes('FROM event_types WHERE user_id')) {
                return { results: tables.event_types.filter(et => et.user_id === args[0]) };
              }
              // Bookings with join
              if (sql.includes('FROM bookings b JOIN event_types et') && sql.includes('WHERE et.user_id')) {
                const userId = args[0];
                const userETs = tables.event_types.filter(e => e.user_id === userId);
                const etIds = new Set(userETs.map(e => e.id));
                let filtered = tables.bookings.filter(b => etIds.has(b.event_type_id));
                if (sql.includes("status IN ('confirmed', 'pending')") && sql.includes('start_time >')) {
                  filtered = filtered.filter(b => ['confirmed', 'pending'].includes(b.status));
                } else if (sql.includes("status = 'cancelled'")) {
                  filtered = filtered.filter(b => b.status === 'cancelled');
                }
                return { results: filtered };
              }
              // Calendar connections
              if (sql.includes('FROM calendar_connections WHERE user_id')) {
                return { results: tables.calendar_connections.filter(c => c.user_id === args[0]) };
              }
              // Availability schedules
              if (sql.includes('FROM availability_schedules WHERE user_id')) {
                return { results: tables.availability_schedules.filter(s => s.user_id === args[0]) };
              }
              return { results: [] };
            },
            async run() {
              // INSERT into event_types (create_event_type)
              if (sql.includes('INSERT INTO event_types')) {
                const newET = {
                  id: autoIncrement.event_types++,
                  user_id: args[0],
                  name: args[1],
                  slug: args[2],
                  description: args[3],
                  duration_minutes: args[4],
                  color: args[5],
                  location_type: args[6],
                  availability_schedule_id: args[7],
                };
                tables.event_types.push(newET);
              }
              // DELETE event_types
              if (sql.includes('DELETE FROM event_types WHERE id')) {
                const idx = tables.event_types.findIndex(et => et.id === args[0] && et.user_id === args[1]);
                if (idx !== -1) tables.event_types.splice(idx, 1);
              }
              // UPDATE bookings (cancel)
              if (sql.includes("UPDATE bookings SET status = 'cancelled'")) {
                const b = tables.bookings.find(bk => bk.id === args[0]);
                if (b) b.status = 'cancelled';
              }
              // UPDATE event_types
              if (sql.includes('UPDATE event_types SET')) {
                // no-op for assertion purposes; the query was tracked
              }
              // UPDATE booking_pages
              if (sql.includes('UPDATE booking_pages SET')) {
                // no-op for assertion purposes
              }
              // INSERT / UPDATE ai_conversations
              if (sql.includes('INSERT INTO ai_conversations') || sql.includes('UPDATE ai_conversations')) {
                // no-op
              }
              // INSERT booking_pages (setupNewUserDefaults)
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: tables.booking_pages.length + 1, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              // INSERT availability_schedules (setupNewUserDefaults)
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({
                  id: tables.availability_schedules.length + 1,
                  user_id: args[0],
                  name: args[1],
                  timezone: args[2],
                  rules: args[3],
                  is_default: args[4],
                });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

// ============================================================
// Auth helper — create env with a valid session
// ============================================================

function createAuthEnv(dbOpts = {}, envOverrides = {}) {
  const user = { id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles', password_hash: 'hashed', avatar_url: null, created_at: '2026-01-01T00:00:00Z' };
  const session = { id: 'sess-1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' };

  const defaults = {
    users: [user],
    sessions: [session],
    bookingPages: [{ id: 1, user_id: 1, slug: 'test-user', display_name: 'Test User', bio: null, brand_color: '#2563eb', logo_url: null, hide_branding: 0, custom_domain: null }],
    availabilitySchedules: [{ id: 1, user_id: 1, name: 'Working Hours', timezone: 'America/Los_Angeles', rules: JSON.stringify([{ day: 1, start: '09:00', end: '17:00' }]), overrides: '[]', is_default: true }],
    eventTypes: [],
    bookings: [],
    calendarConnections: [],
    ...dbOpts,
  };

  const db = createMockDB(defaults);

  return {
    env: {
      DB: db,
      ASSETS: { fetch: () => new Response('') },
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      ...envOverrides,
    },
    db,
    user,
    session,
  };
}

function authedRequest(path, body, sessionToken = 'test-session-token') {
  return new Request(`https://calendo.dev${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session=${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
}

// Build a mock Claude API response that calls a single tool
function claudeToolResponse(toolName, toolInput, toolUseId = 'tool-1') {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        content: [
          { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
        ],
        stop_reason: 'tool_use',
      };
    },
    async text() { return ''; },
  };
}

// Build a mock Claude API final text response (no tool use)
function claudeTextResponse(text) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
      };
    },
    async text() { return ''; },
  };
}

// ============================================================
// Tests
// ============================================================

describe('Dashboard AI Assistant (POST /api/ai/dashboard)', () => {
  let worker;
  let originalFetch;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------
  // Validation
  // ----------------------------------------------------------
  describe('validation', () => {
    it('should return 400 if no message provided', async () => {
      const { env } = createAuthEnv();
      const request = authedRequest('/api/ai/dashboard', { session_id: 'abc' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('message');
    });

    it('should return 400 for empty message string', async () => {
      const { env } = createAuthEnv();
      const request = authedRequest('/api/ai/dashboard', { message: '' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });

    it('should return 503 if ANTHROPIC_API_KEY is not set', async () => {
      const { env } = createAuthEnv({}, { ANTHROPIC_API_KEY: undefined });
      delete env.ANTHROPIC_API_KEY;
      const request = authedRequest('/api/ai/dashboard', { message: 'hello' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toContain('AI not configured');
    });

    it('should return 401 without authentication', async () => {
      const { env } = createAuthEnv();
      const request = new Request('https://calendo.dev/api/ai/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });
  });

  // ----------------------------------------------------------
  // Tool: get_event_types
  // ----------------------------------------------------------
  describe('tool: get_event_types', () => {
    it('should return the user\'s event types', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: '15 Minute Chat', slug: '15-minute-chat', description: 'Quick chat', duration_minutes: 15, color: '#10b981', is_active: 1, group_max_attendees: null },
          { id: 2, user_id: 1, name: '30 Minute Meeting', slug: '30-minute-meeting', description: 'Standard meeting', duration_minutes: 30, color: '#2563eb', is_active: 1, group_max_attendees: null },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_event_types', {});
          }
          return claudeTextResponse('You have 2 event types.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'What event types do I have?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.message).toBe('You have 2 event types.');

      // Verify the tool query was issued
      const toolQuery = db._queries.find(q => q.sql.includes('FROM event_types WHERE user_id') && !q.sql.includes('JOIN'));
      expect(toolQuery).toBeTruthy();
      expect(toolQuery.args[0]).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // Tool: get_bookings
  // ----------------------------------------------------------
  describe('tool: get_bookings', () => {
    it('should return upcoming bookings by default', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1, group_max_attendees: null }],
        bookings: [
          { id: 1, event_type_id: 1, invitee_name: 'Alice', invitee_email: 'alice@test.com', start_time: '2099-06-01T10:00:00Z', end_time: '2099-06-01T10:30:00Z', status: 'confirmed' },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_bookings', { filter: 'upcoming' });
          return claudeTextResponse('You have 1 upcoming booking.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show my upcoming bookings' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.message).toBe('You have 1 upcoming booking.');

      // Verify the bookings query was issued with the right user
      const bookingQuery = db._queries.find(q => q.sql.includes('FROM bookings b JOIN event_types et') && q.sql.includes('WHERE et.user_id'));
      expect(bookingQuery).toBeTruthy();
    });

    it('should filter cancelled bookings', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          { id: 1, event_type_id: 1, invitee_name: 'Bob', invitee_email: 'bob@test.com', start_time: '2026-01-15T10:00:00Z', end_time: '2026-01-15T10:30:00Z', status: 'cancelled' },
          { id: 2, event_type_id: 1, invitee_name: 'Carol', invitee_email: 'carol@test.com', start_time: '2099-06-01T14:00:00Z', end_time: '2099-06-01T14:30:00Z', status: 'confirmed' },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_bookings', { filter: 'cancelled' });
          return claudeTextResponse('You have 1 cancelled booking.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show cancelled bookings' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Check that the SQL for cancelled filter was generated
      const cancelledQuery = db._queries.find(q => q.sql.includes("status = 'cancelled'") && q.sql.includes('ORDER BY'));
      expect(cancelledQuery).toBeTruthy();
    });

    it('should filter past bookings', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          { id: 1, event_type_id: 1, invitee_name: 'Dan', invitee_email: 'dan@test.com', start_time: '2025-01-15T10:00:00Z', end_time: '2025-01-15T10:30:00Z', status: 'confirmed' },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_bookings', { filter: 'past' });
          return claudeTextResponse('You have 1 past booking.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show past bookings' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const pastQuery = db._queries.find(q => q.sql.includes("start_time <=") && q.sql.includes("status IN ('confirmed', 'pending')"));
      expect(pastQuery).toBeTruthy();
    });
  });

  // ----------------------------------------------------------
  // Tool: create_event_type
  // ----------------------------------------------------------
  describe('tool: create_event_type', () => {
    it('should create an event type with correct params', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Quick Sync',
              duration_minutes: 15,
              description: 'A quick sync meeting',
              color: '#ef4444',
            });
          }
          return claudeTextResponse('Created "Quick Sync" event type.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 15 min event type called Quick Sync' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.message).toContain('Quick Sync');

      // Verify INSERT query was run with the right params
      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.args[0]).toBe(1); // user_id
      expect(insertQuery.args[1]).toBe('Quick Sync'); // name
      expect(insertQuery.args[2]).toBe('quick-sync'); // slug (auto-generated)
      expect(insertQuery.args[3]).toBe('A quick sync meeting'); // description
      expect(insertQuery.args[4]).toBe(15); // duration_minutes
      expect(insertQuery.args[5]).toBe('#ef4444'); // color

      // Verify the event type was added to the DB
      expect(db._tables.event_types).toHaveLength(1);
      expect(db._tables.event_types[0].name).toBe('Quick Sync');
    });

    it('should use default color when none provided', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Team Standup',
              duration_minutes: 30,
            });
          }
          return claudeTextResponse('Created "Team Standup" event type.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min event called Team Standup' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.args[5]).toBe('#2563eb'); // default blue color
    });
  });

  // ----------------------------------------------------------
  // Tool: update_event_type
  // ----------------------------------------------------------
  describe('tool: update_event_type', () => {
    it('should update specific fields of an event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Old Name', slug: 'old-name', description: 'Old desc', duration_minutes: 30, color: '#2563eb', is_active: 1 },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              name: 'New Name',
              duration_minutes: 45,
            });
          }
          return claudeTextResponse('Updated the event type.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Rename event type 1 to New Name and make it 45 min' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the UPDATE query
      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('name = ?'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.sql).toContain('duration_minutes = ?');
      expect(updateQuery.args).toContain('New Name');
      expect(updateQuery.args).toContain(45);
    });

    it('should return error for non-existent event type', async () => {
      const { env } = createAuthEnv({ eventTypes: [] });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', { event_type_id: 999, name: 'X' });
          }
          return claudeTextResponse('Event type not found.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Update event type 999' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
      // The tool returns error data, but the overall response is 200 since the AI handled it
    });
  });

  // ----------------------------------------------------------
  // Tool: delete_event_type
  // ----------------------------------------------------------
  describe('tool: delete_event_type', () => {
    it('should delete the event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'To Delete', slug: 'to-delete', duration_minutes: 30, color: '#2563eb', is_active: 1 },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('delete_event_type', { event_type_id: 1 });
          }
          return claudeTextResponse('Deleted "To Delete" event type.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Delete event type 1' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify DELETE query was issued
      const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM event_types WHERE id'));
      expect(deleteQuery).toBeTruthy();
      expect(deleteQuery.args[0]).toBe(1); // event_type_id
      expect(deleteQuery.args[1]).toBe(1); // user_id

      // Verify the event type was removed from the mock DB
      expect(db._tables.event_types).toHaveLength(0);
    });

    it('should return error when deleting non-existent event type', async () => {
      const { env, db } = createAuthEnv({ eventTypes: [] });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('delete_event_type', { event_type_id: 999 });
          }
          return claudeTextResponse('That event type was not found.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Delete event type 999' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // No DELETE query should have been issued (only SELECT to look it up)
      const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM event_types'));
      expect(deleteQuery).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // Tool: cancel_booking
  // ----------------------------------------------------------
  describe('tool: cancel_booking', () => {
    it('should cancel a booking via join through event_types', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          { id: 10, event_type_id: 1, invitee_name: 'Eve', invitee_email: 'eve@test.com', start_time: '2099-06-01T10:00:00Z', end_time: '2099-06-01T10:30:00Z', status: 'confirmed' },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('cancel_booking', { booking_id: 10 });
          }
          return claudeTextResponse('Cancelled the booking with Eve.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Cancel booking 10' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the booking lookup query uses JOIN through event_types
      const lookupQuery = db._queries.find(q =>
        q.sql.includes('FROM bookings b JOIN event_types et') &&
        q.sql.includes('WHERE b.id = ?') &&
        q.sql.includes('et.user_id = ?')
      );
      expect(lookupQuery).toBeTruthy();
      expect(lookupQuery.args[0]).toBe(10); // booking_id
      expect(lookupQuery.args[1]).toBe(1);  // user_id

      // Verify the UPDATE query was issued
      const updateQuery = db._queries.find(q => q.sql.includes("UPDATE bookings SET status = 'cancelled'"));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args[0]).toBe(10);

      // Verify the booking status was changed
      expect(db._tables.bookings[0].status).toBe('cancelled');
    });

    it('should not cancel an already cancelled booking', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          { id: 10, event_type_id: 1, invitee_name: 'Eve', invitee_email: 'eve@test.com', start_time: '2099-06-01T10:00:00Z', end_time: '2099-06-01T10:30:00Z', status: 'cancelled' },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('cancel_booking', { booking_id: 10 });
          }
          return claudeTextResponse('That booking is already cancelled.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Cancel booking 10' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // No UPDATE should have been issued (already cancelled)
      const updateQuery = db._queries.find(q => q.sql.includes("UPDATE bookings SET status = 'cancelled'"));
      expect(updateQuery).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // Tool: get_booking_link
  // ----------------------------------------------------------
  describe('tool: get_booking_link', () => {
    it('should return main booking page URL when no event_type_id provided', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_booking_link', {});
          }
          // Capture the tool result from the second call's messages
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here is your booking link.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'What is my booking link?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the tool result contains the correct URL structure
      expect(toolResultData).toBeTruthy();
      expect(toolResultData.url).toContain('/test-user');
      expect(toolResultData.url).not.toContain('/booking/?user=');
    });

    it('should return direct event type URL when event_type_id provided', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 5, user_id: 1, name: '30 Minute Meeting', slug: '30-minute-meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_booking_link', { event_type_id: 5 });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here is the link for 30 Minute Meeting.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Give me the link for event type 5' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.url).toContain('/test-user/30-minute-meeting');
      expect(toolResultData.event_name).toBe('30 Minute Meeting');
    });
  });

  // ----------------------------------------------------------
  // Tool: navigate_to
  // ----------------------------------------------------------
  describe('tool: navigate_to', () => {
    it('should return the tab name as a frontend action', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('navigate_to', { tab: 'analytics' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Navigating to analytics.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Go to analytics' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.frontend_actions).toBeTruthy();
      expect(body.frontend_actions.length).toBe(1);
      expect(body.frontend_actions[0].type).toBe('navigate_to');
      expect(body.frontend_actions[0].description).toBe('analytics');

      // Verify tool result data
      expect(toolResultData).toBeTruthy();
      expect(toolResultData.action).toBe('navigate');
      expect(toolResultData.tab).toBe('analytics');
    });
  });

  // ----------------------------------------------------------
  // Tool: copy_to_clipboard
  // ----------------------------------------------------------
  describe('tool: copy_to_clipboard', () => {
    it('should return the text as a frontend action', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('copy_to_clipboard', { text: 'https://calendo.dev/booking/?user=test-user' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Copied to clipboard!');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Copy my booking link' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.frontend_actions).toBeTruthy();
      expect(body.frontend_actions.length).toBe(1);
      expect(body.frontend_actions[0].type).toBe('copy_to_clipboard');

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.action).toBe('copy');
      expect(toolResultData.text).toBe('https://calendo.dev/booking/?user=test-user');
    });
  });

  // ----------------------------------------------------------
  // Tool: get_availability
  // ----------------------------------------------------------
  describe('tool: get_availability', () => {
    it('should return parsed availability schedules', async () => {
      const { env, db } = createAuthEnv({
        availabilitySchedules: [
          { id: 1, user_id: 1, name: 'Working Hours', timezone: 'America/Los_Angeles', rules: JSON.stringify([{ day: 1, start: '09:00', end: '17:00' }]), overrides: JSON.stringify([{ date: '2026-04-01', available: false }]), is_default: true },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_availability', {});
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Your availability is set.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show my availability' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the tool result contains parsed (not stringified) rules
      expect(toolResultData).toBeTruthy();
      expect(Array.isArray(toolResultData)).toBe(true);
      expect(toolResultData[0].rules).toBeInstanceOf(Array);
      expect(toolResultData[0].rules[0].day).toBe(1);
      expect(toolResultData[0].overrides).toBeInstanceOf(Array);
    });
  });

  // ----------------------------------------------------------
  // Tool: get_connected_calendars
  // ----------------------------------------------------------
  describe('tool: get_connected_calendars', () => {
    it('should return connected calendar accounts', async () => {
      const { env, db } = createAuthEnv({
        calendarConnections: [
          { id: 1, user_id: 1, provider: 'google', email: 'test@gmail.com' },
          { id: 2, user_id: 1, provider: 'outlook', email: 'test@outlook.com' },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_connected_calendars', {});
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('You have 2 connected calendars.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'What calendars are connected?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData).toHaveLength(2);
      expect(toolResultData[0].provider).toBe('google');
      expect(toolResultData[1].provider).toBe('outlook');
    });
  });

  // ----------------------------------------------------------
  // Tool: get_settings
  // ----------------------------------------------------------
  describe('tool: get_settings', () => {
    it('should return booking page settings', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_settings', {});
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here are your settings.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show my settings' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.slug).toBe('test-user');
      expect(toolResultData.display_name).toBe('Test User');
    });
  });

  // ----------------------------------------------------------
  // Tool: get_analytics
  // ----------------------------------------------------------
  describe('tool: get_analytics', () => {
    it('should return analytics summary with counts and cancellation rate', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          { id: 1, event_type_id: 1, invitee_name: 'A', invitee_email: 'a@test.com', start_time: '2026-03-15T10:00:00Z', status: 'confirmed' },
          { id: 2, event_type_id: 1, invitee_name: 'B', invitee_email: 'b@test.com', start_time: '2026-03-16T10:00:00Z', status: 'cancelled' },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_analytics', {});
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here are your analytics.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show analytics' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.total_bookings).toBeDefined();
      expect(toolResultData.this_month).toBeDefined();
      expect(toolResultData.cancellation_rate).toBeDefined();
      expect(toolResultData.cancellation_rate).toContain('%');
    });
  });

  // ----------------------------------------------------------
  // Tool: update_settings
  // ----------------------------------------------------------
  describe('tool: update_settings', () => {
    it('should update booking page settings', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_settings', {
              display_name: 'New Display Name',
              bio: 'Hello, I am a scheduler',
            });
          }
          return claudeTextResponse('Updated your settings.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Update my display name and bio' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE booking_pages SET') && q.sql.includes('display_name'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.sql).toContain('bio = ?');
      expect(updateQuery.args).toContain('New Display Name');
      expect(updateQuery.args).toContain('Hello, I am a scheduler');
    });
  });

  // ----------------------------------------------------------
  // Response structure
  // ----------------------------------------------------------
  describe('response structure', () => {
    it('should return session_id and message in response', async () => {
      const { env } = createAuthEnv();

      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          return claudeTextResponse('Hello! How can I help?');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Hi', session_id: 'my-session-123' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.session_id).toBe('my-session-123');
      expect(body.message).toBe('Hello! How can I help?');
    });

    it('should not include actions_taken for read-only tool calls', async () => {
      const { env } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1, group_max_attendees: null }],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_event_types', {});
          return claudeTextResponse('You have 1 event type.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'List event types' });
      const response = await worker.default.fetch(request, env, {});
      const body = await response.json();

      // get_event_types starts with 'get_' so it's filtered from actions_taken
      expect(body.actions_taken).toBeUndefined();
    });

    it('should include actions_taken for write operations', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', { name: 'New Type', duration_minutes: 30 });
          }
          return claudeTextResponse('Created.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min event type' });
      const response = await worker.default.fetch(request, env, {});
      const body = await response.json();

      expect(body.actions_taken).toBeTruthy();
      expect(body.actions_taken.length).toBe(1);
      expect(body.actions_taken[0].type).toBe('create_event_type');
    });

    it('should handle Claude API errors gracefully', async () => {
      const { env } = createAuthEnv();

      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          return {
            ok: false,
            status: 500,
            async text() { return 'Internal server error'; },
            async json() { return { error: 'Internal server error' }; },
          };
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Hello' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      // Errors are caught and returned as a clear, classified message (OI-9).
      // A 500 from the provider must read as a temporary outage, not a generic
      // "something went wrong" — so the user knows it's not their fault.
      expect(body.message).toMatch(/temporarily unavailable|outage/i);
      expect(body.session_id).toBeTruthy();
    });
  });
});

// ============================================================
// setupNewUserDefaults — 3 default event types
// ============================================================

describe('setupNewUserDefaults', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  it('should create 4 default event types (15 min, 30 min, 45 min, 60 min) on registration', async () => {
    const tables = {
      users: [],
      sessions: [],
      booking_pages: [],
      availability_schedules: [],
      event_types: [],
    };
    let autoIncrement = { users: 1, booking_pages: 1, availability_schedules: 1, event_types: 1 };
    const queries = [];

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            queries.push({ sql, args });
            return {
              async first() {
                if (sql.includes('SELECT id FROM users WHERE email')) {
                  return tables.users.find(u => u.email === args[0]) || null;
                }
                if (sql.includes('SELECT id, email, password_hash')) {
                  return tables.users.find(u => u.email === args[0]) || null;
                }
                if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                  return tables.booking_pages.find(p => p.slug === args[0]) || null;
                }
                if (sql.includes('SELECT id FROM availability_schedules') && sql.includes('is_default')) {
                  return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
                }
                if (sql.includes('INSERT INTO users')) {
                  const id = autoIncrement.users++;
                  const user = { id, email: args[0], password_hash: args[1], name: args[2], timezone: args[3], avatar_url: null, created_at: new Date().toISOString() };
                  tables.users.push(user);
                  return { id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
                }
                if (sql.includes('SELECT s.user_id, u.*')) {
                  const session = tables.sessions.find(s => s.token === args[0]);
                  if (!session) return null;
                  const user = tables.users.find(u => u.id === session.user_id);
                  return user ? { ...user, user_id: user.id } : null;
                }
                return null;
              },
              async all() {
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
                if (sql.includes('INSERT INTO event_types')) {
                  tables.event_types.push({
                    id: autoIncrement.event_types++,
                    user_id: args[0],
                    name: args[1],
                    slug: args[2],
                    description: args[3],
                    duration_minutes: args[4],
                    color: args[5],
                    location_type: args[6],
                    availability_schedule_id: args[7],
                    min_notice_hours: args[8],
                    max_future_days: args[9],
                  });
                }
                return { success: true };
              },
            };
          },
        };
      },
    };

    const env = {
      DB: db,
      ASSETS: { fetch: () => new Response('') },
    };

    // Register a user, which triggers setupNewUserDefaults
    const request = new Request('https://calendo.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'password123', name: 'New User' }),
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    // Verify 4 default event types were created
    expect(tables.event_types).toHaveLength(4);

    // 15 minute chat
    const chat15 = tables.event_types.find(et => et.duration_minutes === 15);
    expect(chat15).toBeTruthy();
    expect(chat15.name).toBe('15 Minute Chat');
    expect(chat15.slug).toBe('15-minute-chat');
    expect(chat15.color).toBe('#10b981');

    // 30 minute meeting
    const meeting30 = tables.event_types.find(et => et.duration_minutes === 30);
    expect(meeting30).toBeTruthy();
    expect(meeting30.name).toBe('30 Minute Meeting');
    expect(meeting30.slug).toBe('30-minute-meeting');
    expect(meeting30.color).toBe('#2563eb');

    // 45 minute meeting
    const meeting45 = tables.event_types.find(et => et.duration_minutes === 45);
    expect(meeting45).toBeTruthy();
    expect(meeting45.name).toBe('45 Minute Meeting');
    expect(meeting45.slug).toBe('45-minute-meeting');
    expect(meeting45.color).toBe('#f59e0b');

    // 60 minute deep dive
    const deepDive60 = tables.event_types.find(et => et.duration_minutes === 60);
    expect(deepDive60).toBeTruthy();
    expect(deepDive60.name).toBe('60 Minute Deep Dive');
    expect(deepDive60.slug).toBe('60-minute-deep-dive');
    expect(deepDive60.color).toBe('#7c3aed');

    // All should have google_meet as location type
    for (const et of tables.event_types) {
      expect(et.location_type).toBe('google_meet');
      expect(et.min_notice_hours).toBe(4);
      expect(et.max_future_days).toBe(60);
      expect(et.user_id).toBe(1);
    }
  });

  it('should create a booking page and default availability schedule for new users', async () => {
    const tables = {
      users: [],
      sessions: [],
      booking_pages: [],
      availability_schedules: [],
      event_types: [],
    };
    let autoIncrement = { users: 1, booking_pages: 1, availability_schedules: 1, event_types: 1 };

    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('SELECT id FROM users WHERE email')) {
                  return tables.users.find(u => u.email === args[0]) || null;
                }
                if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                  return tables.booking_pages.find(p => p.slug === args[0]) || null;
                }
                if (sql.includes('SELECT id FROM availability_schedules') && sql.includes('is_default')) {
                  return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
                }
                if (sql.includes('INSERT INTO users')) {
                  const id = autoIncrement.users++;
                  const user = { id, email: args[0], password_hash: args[1], name: args[2], timezone: args[3], created_at: new Date().toISOString() };
                  tables.users.push(user);
                  return { id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
                }
                if (sql.includes('SELECT s.user_id, u.*')) {
                  return null;
                }
                return null;
              },
              async all() { return { results: [] }; },
              async run() {
                if (sql.includes('INSERT INTO booking_pages')) {
                  tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
                }
                if (sql.includes('INSERT INTO availability_schedules')) {
                  // is_default is hardcoded as 1 in the SQL, not a bind param
                  const isDefault = sql.includes('is_default) VALUES') && sql.includes(', 1)') ? 1 : (args[4] ?? 0);
                  tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: isDefault });
                }
                if (sql.includes('INSERT INTO sessions')) {
                  tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
                }
                if (sql.includes('INSERT INTO event_types')) {
                  tables.event_types.push({ id: autoIncrement.event_types++ });
                }
                return { success: true };
              },
            };
          },
        };
      },
    };

    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };

    const request = new Request('https://calendo.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'setup@example.com', password: 'password123', name: 'Setup Test' }),
    });

    await worker.default.fetch(request, env, {});

    // Verify booking page was created
    expect(tables.booking_pages).toHaveLength(1);
    expect(tables.booking_pages[0].user_id).toBe(1);

    // Verify default availability schedule was created with Mon-Fri 9-5
    expect(tables.availability_schedules).toHaveLength(1);
    const schedule = tables.availability_schedules[0];
    expect(schedule.name).toBe('Working Hours');
    expect(schedule.timezone).toBe('America/Los_Angeles');
    expect(schedule.is_default).toBe(1);
    const rules = JSON.parse(schedule.rules);
    expect(rules).toHaveLength(5); // Mon-Fri
    expect(rules[0]).toEqual({ day: 1, start: '09:00', end: '17:00' });
    expect(rules[4]).toEqual({ day: 5, start: '09:00', end: '17:00' });
  });
});
