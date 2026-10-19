import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ============================================================
// Mock DB helper — tailored for new 99% coverage AI tool tests
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
    audit_log: opts.auditLog || [],
    organizations: opts.organizations || [],
    org_members: opts.orgMembers || [],
    email_verification_tokens: opts.emailVerificationTokens || [],
  };
  let autoIncrement = {
    event_types: (opts.eventTypes || []).length + 1,
    bookings: (opts.bookings || []).length + 1,
    email_verification_tokens: 1,
  };

  const queries = [];

  return {
    _tables: tables,
    _queries: queries,
    prepare(sql) {
      return {
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

              // Booking by id + user join
              if (sql.includes('FROM bookings b JOIN event_types et') && sql.includes('WHERE b.id = ?')) {
                const booking = tables.bookings.find(b => b.id === args[0]);
                if (!booking) return null;
                const et = tables.event_types.find(e => e.id === booking.event_type_id && e.user_id === args[1]);
                if (!et) return null;
                return booking;
              }

              // Analytics
              if (sql.includes('SELECT COUNT(*)') && sql.includes('bookings')) {
                return { count: 0 };
              }

              // Slack webhook lookup
              if (sql.includes('slack_webhook_url') && sql.includes('FROM users WHERE id')) {
                const u = tables.users.find(u => u.id === args[0]);
                return u ? { slack_webhook_url: u.slack_webhook_url || null } : null;
              }

              // PayPal credentials lookup
              if (sql.includes('paypal_client_id_encrypted') && sql.includes('FROM users WHERE id')) {
                const u = tables.users.find(u => u.id === args[0]);
                return u ? { paypal_client_id_encrypted: u.paypal_client_id_encrypted || null, paypal_client_secret_encrypted: u.paypal_client_secret_encrypted || null, paypal_mode: u.paypal_mode || 'sandbox' } : null;
              }

              // GA/Pixel tracking from booking_pages
              if (sql.includes('ga_measurement_id') && sql.includes('FROM booking_pages WHERE user_id')) {
                const bp = tables.booking_pages.find(bp => bp.user_id === args[0]);
                return bp ? { ga_measurement_id: bp.ga_measurement_id || null, meta_pixel_id: bp.meta_pixel_id || null } : null;
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
              // Audit log
              if (sql.includes('FROM audit_log')) {
                let entries = tables.audit_log.filter(e => e.user_id === args[0]);
                if (sql.includes('AND action = ?')) {
                  const actionFilter = args[1];
                  entries = entries.filter(e => e.action === actionFilter);
                }
                return { results: entries };
              }
              // Organizations for user
              if (sql.includes('FROM organizations') && sql.includes('org_members')) {
                const memberOrgs = tables.org_members.filter(m => m.user_id === args[0]);
                const orgIds = new Set(memberOrgs.map(m => m.org_id));
                return { results: tables.organizations.filter(o => orgIds.has(o.id)) };
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
              // UPDATE users
              if (sql.includes('UPDATE users SET')) {
                // no-op
              }
              // INSERT email_verification_tokens
              if (sql.includes('INSERT INTO email_verification_tokens')) {
                tables.email_verification_tokens.push({
                  id: autoIncrement.email_verification_tokens++,
                  user_id: args[0],
                  token: args[1],
                  expires_at: args[2],
                  used: 0,
                });
              }
              // UPDATE email_verification_tokens
              if (sql.includes('UPDATE email_verification_tokens')) {
                // no-op
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
  const user = {
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    timezone: 'America/Los_Angeles',
    password_hash: 'hashed',
    avatar_url: null,
    email_verified: 0,
    slack_webhook_url: null,
    paypal_client_id_encrypted: null,
    paypal_client_secret_encrypted: null,
    paypal_mode: 'sandbox',
    created_at: '2026-01-01T00:00:00Z',
  };
  const session = { id: 'sess-1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' };

  const defaults = {
    users: [user],
    sessions: [session],
    bookingPages: [{ id: 1, user_id: 1, slug: 'test-user', display_name: 'Test User', bio: null, brand_color: '#2563eb', logo_url: null, hide_branding: 0, custom_domain: null, ga_measurement_id: null, meta_pixel_id: null }],
    availabilitySchedules: [{ id: 1, user_id: 1, name: 'Working Hours', timezone: 'America/Los_Angeles', rules: JSON.stringify([{ day: 1, start: '09:00', end: '17:00' }]), overrides: '[]', is_default: true }],
    eventTypes: [],
    bookings: [],
    calendarConnections: [],
    auditLog: [],
    organizations: [],
    orgMembers: [],
    emailVerificationTokens: [],
    ...dbOpts,
  };

  // Merge user overrides if any
  if (dbOpts.users) {
    defaults.users = dbOpts.users;
  }

  const db = createMockDB(defaults);

  return {
    env: {
      DB: db,
      ASSETS: { fetch: () => new Response('') },
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      RESEND_API_KEY: 'test-resend-key',
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 bytes base64
      ...envOverrides,
    },
    db,
    user: defaults.users[0],
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
// Tests — AI Tools for 99% Coverage Features
// ============================================================

describe('AI Dashboard Tools — 99% Coverage Features', () => {
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
  // get_audit_log
  // ----------------------------------------------------------
  describe('get_audit_log', () => {
    it('should return audit log entries for the user', async () => {
      const { env } = createAuthEnv({
        auditLog: [
          { id: 1, user_id: 1, action: 'event_type.created', entity_type: 'event_type', entity_id: 1, details: '{}', ip_address: '1.2.3.4', created_at: '2026-04-01T10:00:00Z' },
          { id: 2, user_id: 1, action: 'settings.updated', entity_type: 'booking_page', entity_id: 1, details: '{}', ip_address: '1.2.3.4', created_at: '2026-04-02T10:00:00Z' },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_audit_log', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here are your recent audit log entries.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show me my audit log' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.length).toBe(2);
      expect(toolResultData[0].action).toBe('event_type.created');
    });

    it('should filter audit log by action', async () => {
      const { env, db } = createAuthEnv({
        auditLog: [
          { id: 1, user_id: 1, action: 'event_type.created', entity_type: 'event_type', entity_id: 1, details: '{}', ip_address: null, created_at: '2026-04-01T10:00:00Z' },
          { id: 2, user_id: 1, action: 'settings.updated', entity_type: 'booking_page', entity_id: 1, details: '{}', ip_address: null, created_at: '2026-04-02T10:00:00Z' },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_audit_log', { action: 'settings.updated' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here are your settings audit entries.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show me settings changes in audit log' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the SQL includes the action filter
      const auditQuery = db._queries.find(q => q.sql.includes('FROM audit_log') && q.sql.includes('action = ?'));
      expect(auditQuery).toBeTruthy();
      expect(auditQuery.args).toContain('settings.updated');
    });

    it('should respect the limit parameter', async () => {
      const { env, db } = createAuthEnv({
        auditLog: Array.from({ length: 30 }, (_, i) => ({
          id: i + 1, user_id: 1, action: 'event_type.created', entity_type: 'event_type', entity_id: i + 1, details: '{}', ip_address: null, created_at: '2026-04-01T10:00:00Z',
        })),
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_audit_log', { limit: 5 });
          }
          return claudeTextResponse('Here are the last 5 entries.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show last 5 audit entries' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const auditQuery = db._queries.find(q => q.sql.includes('FROM audit_log') && q.sql.includes('LIMIT'));
      expect(auditQuery).toBeTruthy();
      // Limit should be 5
      expect(auditQuery.args).toContain(5);
    });
  });

  // ----------------------------------------------------------
  // get_team_page_url
  // ----------------------------------------------------------
  describe('get_team_page_url', () => {
    it('should return team page URLs for user organizations', async () => {
      const { env } = createAuthEnv({
        organizations: [
          { id: 1, name: 'My Team', slug: 'my-team' },
        ],
        orgMembers: [
          { org_id: 1, user_id: 1, role: 'owner' },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_team_page_url', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here is your team page URL.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'What is my team page URL?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.organizations).toBeTruthy();
      expect(toolResultData.organizations.length).toBe(1);
      expect(toolResultData.organizations[0].slug).toBe('my-team');
      expect(toolResultData.organizations[0].url).toContain('/team/?org=my-team');
    });

    it('should return error when user has no organizations', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_team_page_url', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('You are not part of any organization.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Show me my team page' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('not a member');
    });
  });

  // ----------------------------------------------------------
  // manage_tracking
  // ----------------------------------------------------------
  describe('manage_tracking', () => {
    it('should get current tracking IDs', async () => {
      const { env } = createAuthEnv({
        bookingPages: [{ id: 1, user_id: 1, slug: 'test-user', display_name: 'Test User', bio: null, brand_color: '#2563eb', logo_url: null, hide_branding: 0, custom_domain: null, ga_measurement_id: 'G-ABC123', meta_pixel_id: '12345' }],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_tracking', { action: 'get' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Your tracking IDs are set.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'What are my tracking IDs?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.ga_measurement_id).toBe('G-ABC123');
      expect(toolResultData.meta_pixel_id).toBe('12345');
    });

    it('should set GA measurement ID', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_tracking', { action: 'set', ga_measurement_id: 'G-XYZ789' });
          }
          return claudeTextResponse('GA tracking ID set.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set my GA ID to G-XYZ789' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE booking_pages SET') && q.sql.includes('ga_measurement_id'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain('G-XYZ789');
    });

    it('should set Meta Pixel ID', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_tracking', { action: 'set', meta_pixel_id: '9876543' });
          }
          return claudeTextResponse('Meta Pixel ID set.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set my Meta Pixel to 9876543' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE booking_pages SET') && q.sql.includes('meta_pixel_id'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain('9876543');
    });

    it('should clear tracking IDs with empty strings', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_tracking', { action: 'set', ga_measurement_id: '', meta_pixel_id: '' });
          }
          return claudeTextResponse('Tracking IDs cleared.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Remove all tracking IDs' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE booking_pages SET') && q.sql.includes('ga_measurement_id'));
      expect(updateQuery).toBeTruthy();
      // Empty strings should become null
      expect(updateQuery.args).toContain(null);
    });
  });

  // ----------------------------------------------------------
  // manage_slack
  // ----------------------------------------------------------
  describe('manage_slack', () => {
    it('should get current Slack webhook status (not configured)', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'get' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Slack is not configured.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Is Slack connected?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.configured).toBe(false);
      expect(toolResultData.slack_webhook_url).toBeNull();
    });

    it('should set a valid Slack webhook URL', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'set', webhook_url: 'https://hooks.slack.com/services/T123/B456/abc' });
          }
          return claudeTextResponse('Slack webhook saved.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set my Slack webhook' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE users SET') && q.sql.includes('slack_webhook_url'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args[0]).toBe('https://hooks.slack.com/services/T123/B456/abc');
    });

    it('should reject invalid Slack webhook URL', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'set', webhook_url: 'https://example.com/webhook' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Invalid Slack URL.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set Slack webhook to https://example.com/webhook' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('Invalid Slack webhook');
    });

    it('should remove Slack webhook', async () => {
      const { env, db } = createAuthEnv({
        users: [{
          id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles',
          password_hash: 'hashed', avatar_url: null, email_verified: 0,
          slack_webhook_url: 'https://hooks.slack.com/services/old', created_at: '2026-01-01T00:00:00Z',
        }],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'remove' });
          }
          return claudeTextResponse('Slack disconnected.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Remove Slack integration' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE users SET') && q.sql.includes('slack_webhook_url = NULL'));
      expect(updateQuery).toBeTruthy();
    });

    it('should test Slack webhook (no webhook configured)', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'test' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('No Slack webhook configured.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Test my Slack webhook' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('No Slack webhook');
    });

    it('should test Slack webhook successfully', async () => {
      const { env } = createAuthEnv({
        users: [{
          id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles',
          password_hash: 'hashed', avatar_url: null, email_verified: 0,
          slack_webhook_url: 'https://hooks.slack.com/services/T123/B456/xyz', created_at: '2026-01-01T00:00:00Z',
        }],
      });

      let fetchCallCount = 0;
      let slackCalled = false;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'test' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Test message sent.');
        }
        if (typeof url === 'string' && url.includes('hooks.slack.com')) {
          slackCalled = true;
          return { ok: true, status: 200, async text() { return 'ok'; } };
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Test my Slack webhook' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(slackCalled).toBe(true);
      expect(toolResultData).toBeTruthy();
      expect(toolResultData.ok).toBe(true);
    });

    it('should return error when set is called without webhook_url', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_slack', { action: 'set' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Missing webhook URL.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set my Slack webhook' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('webhook_url is required');
    });
  });

  // ----------------------------------------------------------
  // manage_paypal
  // ----------------------------------------------------------
  describe('manage_paypal', () => {
    it('should get PayPal status (not configured)', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_paypal', { action: 'get' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('PayPal is not configured.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Is PayPal set up?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.has_paypal).toBe(false);
    });

    it('should remove PayPal credentials', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_paypal', { action: 'remove' });
          }
          return claudeTextResponse('PayPal removed.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Remove PayPal' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE users SET') && q.sql.includes('paypal_client_id_encrypted = NULL'));
      expect(updateQuery).toBeTruthy();
    });

    it('should fail to set PayPal without credentials', async () => {
      const { env } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_paypal', { action: 'set' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Missing PayPal credentials.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set up PayPal' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('client_id and client_secret are required');
    });

    it('should set PayPal credentials successfully', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('manage_paypal', { action: 'set', client_id: 'pp-client-123', client_secret: 'pp-secret-456', mode: 'live' });
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('PayPal credentials saved.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set PayPal credentials' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.ok).toBe(true);
      expect(toolResultData.has_paypal).toBe(true);
      expect(toolResultData.mode).toBe('live');

      // Verify encrypted credentials were stored
      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE users SET') && q.sql.includes('paypal_client_id_encrypted'));
      expect(updateQuery).toBeTruthy();
      // Should have 4 bind args: encryptedId, encryptedSecret, mode, userId
      expect(updateQuery.args.length).toBe(4);
      expect(updateQuery.args[2]).toBe('live');
      expect(updateQuery.args[3]).toBe(1); // user.id
    });
  });

  // ----------------------------------------------------------
  // resend_verification
  // ----------------------------------------------------------
  describe('resend_verification', () => {
    it('should send verification email when email is not verified', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      let toolResultData = null;
      // Mock sendEmail via fetch (Resend API call)
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('resend_verification', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Verification email sent.');
        }
        // Mock Resend email API
        if (typeof url === 'string' && url.includes('resend.com')) {
          return { ok: true, status: 200, async json() { return { id: 'msg-123' }; } };
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Resend verification email' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.ok).toBe(true);
      expect(toolResultData.message).toContain('Verification email sent');

      // Verify token was created
      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO email_verification_tokens'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.args[0]).toBe(1); // user.id
    });

    it('should return error when email is already verified', async () => {
      const { env } = createAuthEnv({
        users: [{
          id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles',
          password_hash: 'hashed', avatar_url: null, email_verified: 1,
          slack_webhook_url: null, created_at: '2026-01-01T00:00:00Z',
        }],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('resend_verification', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Your email is already verified.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Resend verification email' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toContain('already verified');
    });
  });

  // ----------------------------------------------------------
  // create_event_type with payment_method and reconfirmation_hours
  // ----------------------------------------------------------
  describe('create_event_type with payment_method and reconfirmation_hours', () => {
    it('should create event type with PayPal payment method', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Paid Consultation',
              duration_minutes: 60,
              payment_method: 'paypal',
            });
          }
          return claudeTextResponse('Created "Paid Consultation" with PayPal.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 60 min paid consultation with PayPal' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.sql).toContain('payment_method');
      expect(insertQuery.args).toContain('paypal');
    });

    it('should create event type with reconfirmation_hours', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Important Meeting',
              duration_minutes: 30,
              reconfirmation_hours: 24,
            });
          }
          return claudeTextResponse('Created "Important Meeting" with 24h reconfirmation.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min meeting with 24h reconfirmation' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      expect(insertQuery.sql).toContain('reconfirmation_hours');
      expect(insertQuery.args).toContain(24);
    });

    it('should default payment_method to stripe and reconfirmation_hours to null', async () => {
      const { env, db } = createAuthEnv();

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('create_event_type', {
              name: 'Standard Meeting',
              duration_minutes: 30,
            });
          }
          return claudeTextResponse('Created "Standard Meeting".');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Create a 30 min meeting' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
      expect(insertQuery).toBeTruthy();
      // payment_method should be 'stripe' (default), reconfirmation_hours should be null
      expect(insertQuery.args).toContain('stripe');
      expect(insertQuery.args).toContain(null); // reconfirmation_hours
    });
  });

  // ----------------------------------------------------------
  // update_event_type with payment_method and reconfirmation_hours
  // ----------------------------------------------------------
  describe('update_event_type with payment_method and reconfirmation_hours', () => {
    it('should update payment_method on event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Paid Meeting', slug: 'paid-meeting', duration_minutes: 60, color: '#2563eb', is_active: 1, payment_method: 'stripe', reconfirmation_hours: null },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              payment_method: 'paypal',
            });
          }
          return claudeTextResponse('Updated to PayPal.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Switch event 1 to PayPal' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('payment_method'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain('paypal');
    });

    it('should update reconfirmation_hours on event type', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'My Meeting', slug: 'my-meeting', duration_minutes: 30, color: '#2563eb', is_active: 1, reconfirmation_hours: null },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              reconfirmation_hours: 48,
            });
          }
          return claudeTextResponse('Set 48h reconfirmation.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Set 48h reconfirmation on event 1' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('reconfirmation_hours'));
      expect(updateQuery).toBeTruthy();
      expect(updateQuery.args).toContain(48);
    });

    it('should disable reconfirmation by setting to 0', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1, reconfirmation_hours: 24 },
        ],
      });

      let fetchCallCount = 0;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('update_event_type', {
              event_type_id: 1,
              reconfirmation_hours: 0,
            });
          }
          return claudeTextResponse('Disabled reconfirmation.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'Disable reconfirmation on event 1' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET') && q.sql.includes('reconfirmation_hours'));
      expect(updateQuery).toBeTruthy();
      // 0 should become null
      expect(updateQuery.args).toContain(null);
    });
  });

  // ----------------------------------------------------------
  // get_event_types includes new fields
  // ----------------------------------------------------------
  describe('get_event_types includes payment_method and reconfirmation_hours', () => {
    it('should include payment_method and reconfirmation_hours in response', async () => {
      const { env, db } = createAuthEnv({
        eventTypes: [
          { id: 1, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30, color: '#2563eb', is_active: 1, is_secret: 0, redirect_url: null, allow_guests: 1, group_max_attendees: null, payment_method: 'paypal', reconfirmation_hours: 24 },
        ],
      });

      let fetchCallCount = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          fetchCallCount++;
          if (fetchCallCount === 1) {
            return claudeToolResponse('get_event_types', {});
          }
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Here are your event types.');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'List my event types' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      // Verify the SQL query includes the new columns
      const selectQuery = db._queries.find(q => q.sql.includes('FROM event_types WHERE user_id') && q.sql.includes('payment_method') && q.sql.includes('reconfirmation_hours'));
      expect(selectQuery).toBeTruthy();
    });
  });

  // ----------------------------------------------------------
  // Tool definitions validation
  // ----------------------------------------------------------
  describe('DASHBOARD_TOOLS definitions', () => {
    it('should include all new tool definitions', async () => {
      // Import the module and check the tools are defined by verifying
      // the AI endpoint accepts requests for these tools
      const { env } = createAuthEnv();

      // Test each new tool name by checking the tool response works
      const newTools = ['get_audit_log', 'get_team_page_url', 'manage_tracking', 'manage_slack', 'manage_paypal', 'resend_verification'];

      for (const toolName of newTools) {
        let fetchCallCount = 0;
        globalThis.fetch = async (url, options) => {
          if (typeof url === 'string' && url.includes('anthropic')) {
            fetchCallCount++;
            if (fetchCallCount === 1) {
              // Check that Claude was sent the tools by inspecting the request body
              const body = JSON.parse(options.body);
              const tool = body.tools.find(t => t.name === toolName);
              expect(tool).toBeTruthy();
              return claudeTextResponse(`Tool ${toolName} is available.`);
            }
            return claudeTextResponse('Done.');
          }
          // Mock Resend for resend_verification
          if (typeof url === 'string' && url.includes('resend.com')) {
            return { ok: true, status: 200, async json() { return { id: 'msg-1' }; } };
          }
          return originalFetch(url);
        };

        const request = authedRequest('/api/ai/dashboard', { message: `test ${toolName}` });
        const response = await worker.default.fetch(request, env, {});
        expect(response.status).toBe(200);
      }
    });

    it('should include payment_method and reconfirmation_hours in create_event_type schema', async () => {
      const { env } = createAuthEnv();

      let toolSchema = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          const body = JSON.parse(options.body);
          toolSchema = body.tools.find(t => t.name === 'create_event_type');
          return claudeTextResponse('OK');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'test' });
      await worker.default.fetch(request, env, {});

      expect(toolSchema).toBeTruthy();
      expect(toolSchema.input_schema.properties.payment_method).toBeTruthy();
      expect(toolSchema.input_schema.properties.reconfirmation_hours).toBeTruthy();
    });

    it('should include payment_method and reconfirmation_hours in update_event_type schema', async () => {
      const { env } = createAuthEnv();

      let toolSchema = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          const body = JSON.parse(options.body);
          toolSchema = body.tools.find(t => t.name === 'update_event_type');
          return claudeTextResponse('OK');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'test' });
      await worker.default.fetch(request, env, {});

      expect(toolSchema).toBeTruthy();
      expect(toolSchema.input_schema.properties.payment_method).toBeTruthy();
      expect(toolSchema.input_schema.properties.reconfirmation_hours).toBeTruthy();
    });
  });

  // ----------------------------------------------------------
  // Knowledge base updates
  // ----------------------------------------------------------
  describe('DASHBOARD_KNOWLEDGE_BASE updates', () => {
    it('should include new feature topics in the system prompt', async () => {
      const { env } = createAuthEnv();

      let systemPromptContent = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          const body = JSON.parse(options.body);
          systemPromptContent = body.system;
          return claudeTextResponse('OK');
        }
        return originalFetch(url);
      };

      const request = authedRequest('/api/ai/dashboard', { message: 'test' });
      await worker.default.fetch(request, env, {});

      expect(systemPromptContent).toBeTruthy();
      // Verify all new feature topics are mentioned
      expect(systemPromptContent).toContain('Analytics Tracking');
      expect(systemPromptContent).toContain('UTM');
      expect(systemPromptContent).toContain('Conditional Questions');
      expect(systemPromptContent).toContain('SMS Reminders');
      expect(systemPromptContent).toContain('QR Codes');
      expect(systemPromptContent).toContain('Reconfirmation');
      expect(systemPromptContent).toContain('Slack Notifications');
      expect(systemPromptContent).toContain('Email Verification');
      expect(systemPromptContent).toContain('Team Pages');
      expect(systemPromptContent).toContain('Audit Log');
      expect(systemPromptContent).toContain('PayPal');
      expect(systemPromptContent).toContain('Chrome Extension');
    });
  });
});
