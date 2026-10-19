import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ============================================================
// Mock DB helper — tailored for new AI tool tests
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
    password_reset_tokens: opts.passwordResetTokens || [],
  };
  let autoIncrement = {
    event_types: (opts.eventTypes || []).length + 1,
    bookings: (opts.bookings || []).length + 1,
    password_reset_tokens: 1,
  };

  const queries = [];

  return {
    _tables: tables,
    _queries: queries,
    prepare(sql) {
      return {
        // Direct run() without bind() — used by some statements like CREATE TABLE
        async run() {
          queries.push({ sql, args: [] });
          return { success: true };
        },
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

              // Booking by id + user join
              if (sql.includes('FROM bookings b JOIN event_types et') && sql.includes('WHERE b.id = ?')) {
                const booking = tables.bookings.find(b => b.id === args[0]);
                if (!booking) return null;
                const et = tables.event_types.find(e => e.id === booking.event_type_id && e.user_id === args[1]);
                if (!et) return null;
                return booking;
              }

              // User by email (for forgot-password)
              if (sql.includes('SELECT id, email FROM users WHERE email = ?')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }

              // Analytics
              if (sql.includes('SELECT COUNT(*)') && sql.includes('bookings')) {
                return { count: 0 };
              }

              // Custom domain lookup
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
              // UPDATE event_types
              if (sql.includes('UPDATE event_types SET')) {
                // no-op for assertion purposes; the query was tracked
              }
              // UPDATE booking_pages
              if (sql.includes('UPDATE booking_pages SET')) {
                // no-op
              }
              // INSERT / UPDATE ai_conversations
              if (sql.includes('INSERT INTO ai_conversations') || sql.includes('UPDATE ai_conversations')) {
                // no-op
              }
              // INSERT booking_pages
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: tables.booking_pages.length + 1, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              // INSERT availability_schedules
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
              // CREATE TABLE for password_reset_tokens
              if (sql.includes('CREATE TABLE IF NOT EXISTS password_reset_tokens')) {
                // no-op
              }
              // UPDATE password_reset_tokens
              if (sql.includes('UPDATE password_reset_tokens SET used = 1')) {
                // no-op
              }
              // INSERT password_reset_tokens
              if (sql.includes('INSERT INTO password_reset_tokens')) {
                tables.password_reset_tokens.push({
                  id: autoIncrement.password_reset_tokens++,
                  user_id: args[0],
                  token: args[1],
                  expires_at: args[2],
                  used: 0,
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
// Auth + env helpers
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
      RESEND_API_KEY: 'test-resend-key',
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
// Tests — New AI Tools
// ============================================================

describe('New AI Dashboard Tools', () => {
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
  // Secret Event Types via AI
  // ----------------------------------------------------------
  describe('create secret event type via AI', () => {
    it('should create an event type with is_secret=true', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'VIP Consultation',
              duration_minutes: 60,
              is_secret: true,
            });
          }
          return claudeTextResponse('Created "VIP Consultation" as a secret event type.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a secret 60 min event called VIP Consultation' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.message).toContain('VIP Consultation');

      // Verify INSERT query includes is_secret
      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.sql).toContain('is_secret');
      expect(insertQuery.args).toContain(1); // is_secret = 1 (true)
      expect(insertQuery.args[1]).toBe('VIP Consultation');
    });

    it('should default is_secret to false when not provided', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Public Event',
              duration_minutes: 30,
            });
          }
          return claudeTextResponse('Created "Public Event".');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min event called Public Event' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      // is_secret should be 0 (false) by default
      expect(insertQuery.sql).toContain('is_secret');
      // The is_secret arg should be 0
      const isSecretArgIndex = insertQuery.sql.split('?').length - 1; // all bind params
      // Easier: just check the insert includes 0 for is_secret
      // is_secret is the 12th param (index 11): user_id, name, slug, desc, duration, color, location, sched, min_notice, max_future, allow_guests, is_secret, redirect_url
      expect(insertQuery.args[11]).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Update event type with is_secret via AI
  // ----------------------------------------------------------
  describe('update event type is_secret via AI', () => {
    it('should update is_secret on an existing event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Regular Meeting', slug: 'regular-meeting', description: null, duration_minutes: 30, color: '#2563eb', is_active: 1, is_secret: 0 },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              is_secret: true,
            });
          }
          return claudeTextResponse('Updated event type to secret.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Make event type 1 secret' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('is_secret'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain(1); // is_secret = 1
    });
  });

  // ----------------------------------------------------------
  // Redirect URL via AI
  // ----------------------------------------------------------
  describe('update redirect_url via AI', () => {
    it('should update redirect_url on an event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', description: null, duration_minutes: 30, color: '#2563eb', is_active: 1, redirect_url: null },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              redirect_url: 'https://example.com/thank-you',
            });
          }
          return claudeTextResponse('Updated redirect URL.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set redirect URL for event 1 to https://example.com/thank-you' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('redirect_url'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain('https://example.com/thank-you');
    });

    it('should clear redirect_url with empty string', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', description: null, duration_minutes: 30, color: '#2563eb', is_active: 1, redirect_url: 'https://old.com' },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              redirect_url: '',
            });
          }
          return claudeTextResponse('Cleared redirect URL.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Remove redirect URL from event 1' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('redirect_url'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain(null); // cleared to null
    });

    it('should create event type with redirect_url', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Onboarding Call',
              duration_minutes: 45,
              redirect_url: 'https://mysite.com/thanks',
            });
          }
          return claudeTextResponse('Created with redirect.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 45 min Onboarding Call with redirect to https://mysite.com/thanks' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.sql).toContain('redirect_url');
      expect(insertQuery.args).toContain('https://mysite.com/thanks');
    });
  });

  // ----------------------------------------------------------
  // Get Embed Code via AI
  // ----------------------------------------------------------
  describe('get embed code via AI', () => {
    it('should return inline embed code by default', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_embed_code', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here is your inline embed code.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Give me the embed code for my booking page' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.mode).toBe('inline');
      expect(toolResultData.code).toContain('calendo-inline');
      expect(toolResultData.code).toContain('data-mode="inline"');
      expect(toolResultData.code).toContain('calendo-embed.js');
      expect(toolResultData.code).toContain('test-user');
    });

    it('should return popup embed code when mode is popup', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_embed_code', { mode: 'popup' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here is your popup embed code.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Give me the popup embed code' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.mode).toBe('popup');
      expect(toolResultData.code).toContain('calendo-popup');
      expect(toolResultData.code).toContain('data-mode="popup"');
      expect(toolResultData.code).toContain('Book a Meeting');
    });

    it('should return badge embed code when mode is badge', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_embed_code', { mode: 'badge' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here is your badge embed code.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Give me the floating badge embed code' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.mode).toBe('badge');
      expect(toolResultData.code).toContain('data-calendo-mode="badge"');
      expect(toolResultData.code).toContain('data-calendo-user="test-user"');
    });

    it('should return error when no booking page exists', async () => {
      const { env } = createAuthEnv({ bookingPages: [] });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_embed_code', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('No booking page found.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Get embed code' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('No booking page');
    });
  });

  // ----------------------------------------------------------
  // Allow Guests via AI
  // ----------------------------------------------------------
  describe('create event with allow_guests=false via AI', () => {
    it('should create event type with guests disabled', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Private Session',
              duration_minutes: 30,
              allow_guests: false,
            });
          }
          return claudeTextResponse('Created "Private Session" with guests disabled.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min Private Session with no guests allowed' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.sql).toContain('allow_guests');
      // allow_guests is the 11th param (index 10): user_id, name, slug, desc, duration, color, location, sched, min_notice, max_future, allow_guests
      expect(insertQuery.args[10]).toBe(0); // guests disabled
    });

    it('should default allow_guests to true', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Open Session',
              duration_minutes: 30,
            });
          }
          return claudeTextResponse('Created "Open Session".');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min Open Session' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.args[10]).toBe(1); // guests enabled by default
    });
  });

  // ----------------------------------------------------------
  // Get Bookings shows guest_emails
  // ----------------------------------------------------------
  describe('get bookings shows guest_emails', () => {
    it('should include guest_emails in booking data', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          {
            id: 1,
            event_type_id: 1,
            invitee_name: 'Alice',
            invitee_email: 'alice@test.com',
            start_time: '2099-06-01T10:00:00Z',
            end_time: '2099-06-01T10:30:00Z',
            status: 'confirmed',
            guest_emails: '["bob@test.com","carol@test.com"]',
          },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_bookings', { filter: 'upcoming' });
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('You have 1 upcoming booking with guests.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show my upcoming bookings' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the SQL query includes guest_emails
      const bookingQuery = db._queries.find(q =>
        q.sql.includes('FROM bookings b JOIN event_types et') &&
        q.sql.includes('guest_emails') &&
        q.sql.includes('WHERE et.user_id')
      );
      expect(bookingQuery).toBeTruthy();

      // Verify tool result contains guest_emails
      expect(toolResultData).toBeTruthy();
      expect(Array.isArray(toolResultData)).toBe(true);
      expect(toolResultData[0].guest_emails).toBe('["bob@test.com","carol@test.com"]');
    });

    it('should show null guest_emails for bookings without guests', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [{ id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 }],
        bookings: [
          {
            id: 1,
            event_type_id: 1,
            invitee_name: 'Alice',
            invitee_email: 'alice@test.com',
            start_time: '2099-06-01T10:00:00Z',
            end_time: '2099-06-01T10:30:00Z',
            status: 'confirmed',
            guest_emails: null,
          },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_bookings', { filter: 'upcoming' });
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('You have 1 upcoming booking.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show bookings' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData[0].guest_emails).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // Get Event Types includes new fields
  // ----------------------------------------------------------
  describe('get_event_types includes is_secret, redirect_url, allow_guests', () => {
    it('should return is_secret, redirect_url, and allow_guests for each event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Public Meeting', slug: 'public-meeting', description: null, duration_minutes: 30, color: '#2563eb', is_active: 1, is_secret: 0, redirect_url: null, allow_guests: 1, group_max_attendees: null },
          { id: 2, user_id: 1, name: 'Secret VIP', slug: 'secret-vip', description: 'VIP only', duration_minutes: 60, color: '#ef4444', is_active: 1, is_secret: 1, redirect_url: 'https://example.com/thanks', allow_guests: 0, group_max_attendees: null },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) return claudeToolResponse('get_event_types', {});
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('You have 2 event types.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'List my event types' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the SELECT query includes the new fields
      const etQuery = db._queries.find(q => q.sql.includes('is_secret') && q.sql.includes('redirect_url') && q.sql.includes('allow_guests') && q.sql.includes('FROM event_types'));
      expect(etQuery).toBeTruthy();

      expect(toolResultData).toBeTruthy();
      expect(toolResultData).toHaveLength(2);
      expect(toolResultData[0].is_secret).toBe(0);
      expect(toolResultData[0].redirect_url).toBeNull();
      expect(toolResultData[0].allow_guests).toBe(1);
      expect(toolResultData[1].is_secret).toBe(1);
      expect(toolResultData[1].redirect_url).toBe('https://example.com/thanks');
      expect(toolResultData[1].allow_guests).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // Trigger Password Reset via AI
  // ----------------------------------------------------------
  describe('trigger_password_reset via AI', () => {
    it('should trigger a password reset for a valid email', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('trigger_password_reset', { email: 'test@example.com' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('A password reset link has been sent to your email.');
        }
        // Mock Resend API for sending email
        if (typeof url === 'string' && url.includes('resend.com')) {
          return { ok: true, status: 200, async json() { return { id: 'email-123' }; } };
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'I forgot my password' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.ok).toBe(true);
      expect(toolResultData.message).toContain('password reset link');
    });

    it('should reject invalid email format', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('trigger_password_reset', { email: 'not-an-email' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Invalid email address.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Reset password for not-an-email' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('valid email');
    });
  });

  // ----------------------------------------------------------
  // Tool definitions include new parameters
  // ----------------------------------------------------------
  describe('DASHBOARD_TOOLS definitions', () => {
    it('should have is_secret and redirect_url in create_event_type tool', async () => {
      // We check this by verifying the tool schema sent to Claude
      const { env } = createAuthEnv();

      let sentTools = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            if (bodyData.tools) sentTools = bodyData.tools;
          }
          return claudeTextResponse('Hello!');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'hello' });
      await worker.default.fetch(request, env, {});

      expect(sentTools).toBeTruthy();

      const createTool = sentTools.find(t => t.name === 'create_event_type');
      expect(createTool).toBeTruthy();
      expect(createTool.input_schema.properties.is_secret).toBeDefined();
      expect(createTool.input_schema.properties.is_secret.type).toBe('boolean');
      expect(createTool.input_schema.properties.redirect_url).toBeDefined();
      expect(createTool.input_schema.properties.redirect_url.type).toBe('string');
      expect(createTool.input_schema.properties.allow_guests).toBeDefined();

      const updateTool = sentTools.find(t => t.name === 'update_event_type');
      expect(updateTool).toBeTruthy();
      expect(updateTool.input_schema.properties.is_secret).toBeDefined();
      expect(updateTool.input_schema.properties.redirect_url).toBeDefined();
      expect(updateTool.input_schema.properties.allow_guests).toBeDefined();
    });

    it('should have trigger_password_reset tool', async () => {
      const { env } = createAuthEnv();

      let sentTools = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            if (bodyData.tools) sentTools = bodyData.tools;
          }
          return claudeTextResponse('Hello!');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'hello' });
      await worker.default.fetch(request, env, {});

      const resetTool = sentTools.find(t => t.name === 'trigger_password_reset');
      expect(resetTool).toBeTruthy();
      expect(resetTool.input_schema.properties.email).toBeDefined();
      expect(resetTool.input_schema.required).toContain('email');
    });

    it('should have get_embed_code tool', async () => {
      const { env } = createAuthEnv();

      let sentTools = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            if (bodyData.tools) sentTools = bodyData.tools;
          }
          return claudeTextResponse('Hello!');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'hello' });
      await worker.default.fetch(request, env, {});

      const embedTool = sentTools.find(t => t.name === 'get_embed_code');
      expect(embedTool).toBeTruthy();
      expect(embedTool.input_schema.properties.mode).toBeDefined();
      expect(embedTool.input_schema.properties.mode.enum).toContain('inline');
      expect(embedTool.input_schema.properties.mode.enum).toContain('popup');
      expect(embedTool.input_schema.properties.mode.enum).toContain('badge');
    });
  });
});
