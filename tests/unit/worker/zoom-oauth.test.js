import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ============================================================
// Per-user Zoom OAuth — locks in the migration away from the
// old SHARED Server-to-Server credential (which created every
// user's Zoom meeting inside the platform owner's account).
//
// Reference helpers mirror tests/unit/worker/ai-dashboard.test.js.
// The mock DB here is EXTENDED to understand the zoom_connections
// table so we can seed connections and observe DELETE statements.
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC_PATH = path.resolve(__dirname, '../../../src/worker.js');
const WORKER_SOURCE = readFileSync(WORKER_SRC_PATH, 'utf8');

// ------------------------------------------------------------
// Mock DB — knows the same tables as ai-dashboard.test.js plus
// zoom_connections.
// ------------------------------------------------------------
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
    zoom_connections: opts.zoomConnections || [],
  };

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

              // getAIApiKey BYOK lookup → fall back to env key
              if (sql.includes('SELECT ai_api_key_encrypted FROM users WHERE id = ?')) {
                return null;
              }

              // ----- zoom_connections lookups -----
              if (sql.includes('zoom_connections') && sql.includes('WHERE user_id = ?') && !sql.includes('DELETE')) {
                const row = tables.zoom_connections.find(z => z.user_id === args[0]);
                return row || null;
              }

              // Booking page slug by user_id
              if (sql.includes('FROM booking_pages WHERE user_id = ?') && !sql.includes('UPDATE')) {
                return tables.booking_pages.find(bp => bp.user_id === args[0]) || null;
              }
              // Booking page id by slug
              if (sql.includes('SELECT id FROM booking_pages WHERE slug = ?')) {
                return tables.booking_pages.find(bp => bp.slug === args[0]) || null;
              }

              // AI conversation by session_id
              if (sql.includes('FROM ai_conversations WHERE session_id')) {
                return tables.ai_conversations.find(c => c.session_id === args[0]) || null;
              }

              // Custom domain lookup
              if (sql.includes('custom_domain')) {
                return null;
              }

              return null;
            },
            async all() {
              if (sql.includes('FROM event_types WHERE user_id')) {
                return { results: tables.event_types.filter(et => et.user_id === args[0]) };
              }
              if (sql.includes('FROM bookings b JOIN event_types et') && sql.includes('WHERE et.user_id')) {
                const userId = args[0];
                const userETs = tables.event_types.filter(e => e.user_id === userId);
                const etIds = new Set(userETs.map(e => e.id));
                return { results: tables.bookings.filter(b => etIds.has(b.event_type_id)) };
              }
              if (sql.includes('FROM calendar_connections WHERE user_id')) {
                return { results: tables.calendar_connections.filter(c => c.user_id === args[0]) };
              }
              if (sql.includes('FROM availability_schedules WHERE user_id')) {
                return { results: tables.availability_schedules.filter(s => s.user_id === args[0]) };
              }
              return { results: [] };
            },
            async run() {
              // DELETE zoom_connections (disconnect)
              if (sql.includes('DELETE FROM zoom_connections WHERE user_id')) {
                const idx = tables.zoom_connections.findIndex(z => z.user_id === args[0]);
                if (idx !== -1) tables.zoom_connections.splice(idx, 1);
              }
              // INSERT / UPDATE zoom_connections (callback path)
              if (sql.includes('INSERT INTO zoom_connections')) {
                tables.zoom_connections.push({ user_id: args[0] });
              }
              // ai_conversations no-ops
              if (sql.includes('INSERT INTO ai_conversations') || sql.includes('UPDATE ai_conversations')) {
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

// ------------------------------------------------------------
// Auth env — valid session for user 1. envOverrides lets each
// test toggle the Zoom OAuth client id/secret.
// ------------------------------------------------------------
function createAuthEnv(dbOpts = {}, envOverrides = {}) {
  const user = { id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles', password_hash: 'hashed', avatar_url: null, created_at: '2026-01-01T00:00:00Z' };
  const session = { id: 'sess-1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' };

  const defaults = {
    users: [user],
    sessions: [session],
    bookingPages: [{ id: 1, user_id: 1, slug: 'test-user', display_name: 'Test User', bio: null, brand_color: '#2563eb', logo_url: null, hide_branding: 0, custom_domain: null }],
    availabilitySchedules: [{ id: 1, user_id: 1, name: 'Working Hours', timezone: 'America/Los_Angeles', rules: '[]', overrides: '[]', is_default: true }],
    eventTypes: [],
    bookings: [],
    calendarConnections: [],
    zoomConnections: [],
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

function getRequest(path, sessionToken = 'test-session-token') {
  return new Request(`https://calendo.dev${path}`, {
    method: 'GET',
    headers: { Cookie: `session=${sessionToken}` },
  });
}

function authedPost(path, body, sessionToken = 'test-session-token') {
  return new Request(`https://calendo.dev${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `session=${sessionToken}`,
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
        content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }],
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

// Env keys that make Zoom OAuth "configured".
const ZOOM_CONFIGURED = {
  ZOOM_OAUTH_CLIENT_ID: 'zoom-client-id-abc',
  ZOOM_OAUTH_CLIENT_SECRET: 'zoom-client-secret-xyz',
};

describe('Per-user Zoom OAuth', () => {
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
  // 1. GET /api/zoom/connect
  // ----------------------------------------------------------
  describe('GET /api/zoom/connect', () => {
    it('returns 503 JSON error when ZOOM_OAUTH_CLIENT_ID is not set', async () => {
      const { env } = createAuthEnv(); // no zoom env
      const res = await worker.default.fetch(getRequest('/api/zoom/connect'), env, {});
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/zoom/i);
      expect(body.error).toMatch(/not configured/i);
    });

    it('returns 401 without authentication', async () => {
      const { env } = createAuthEnv({}, ZOOM_CONFIGURED);
      const res = await worker.default.fetch(
        new Request('https://calendo.dev/api/zoom/connect', { method: 'GET' }),
        env,
        {}
      );
      expect(res.status).toBe(401);
    });

    it('redirects (302) to Zoom authorize URL with client_id, redirect_uri, response_type=code and state when configured', async () => {
      const { env } = createAuthEnv({}, ZOOM_CONFIGURED);
      const res = await worker.default.fetch(getRequest('/api/zoom/connect'), env, {});
      expect(res.status).toBe(302);

      const location = res.headers.get('Location');
      expect(location).toBeTruthy();
      expect(location.startsWith('https://zoom.us/oauth/authorize?')).toBe(true);

      const parsed = new URL(location);
      expect(parsed.searchParams.get('client_id')).toBe('zoom-client-id-abc');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      const redirectUri = parsed.searchParams.get('redirect_uri');
      expect(redirectUri).toBeTruthy();
      expect(redirectUri.endsWith('/api/auth/callback/zoom')).toBe(true);
      const state = parsed.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(state.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------
  // 2. GET /api/zoom/status
  // ----------------------------------------------------------
  describe('GET /api/zoom/status', () => {
    it('reports configured=false, connected=false, email=null when nothing is set up', async () => {
      const { env } = createAuthEnv(); // not configured, no connection
      const res = await worker.default.fetch(getRequest('/api/zoom/status'), env, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(false);
      expect(body.connected).toBe(false);
      expect(body.email).toBeNull();
    });

    it('reports configured=true when env has the client id+secret', async () => {
      const { env } = createAuthEnv({}, ZOOM_CONFIGURED);
      const res = await worker.default.fetch(getRequest('/api/zoom/status'), env, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(true);
      // No row seeded → not connected even though configured.
      expect(body.connected).toBe(false);
      expect(body.email).toBeNull();
    });

    it('reports connected=true and the row email when a zoom_connections row exists', async () => {
      const { env } = createAuthEnv(
        { zoomConnections: [{ user_id: 1, email: 'host@zoom.example', zoom_user_id: 'zu-1' }] },
        ZOOM_CONFIGURED
      );
      const res = await worker.default.fetch(getRequest('/api/zoom/status'), env, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configured).toBe(true);
      expect(body.connected).toBe(true);
      expect(body.email).toBe('host@zoom.example');
    });

    it('connected reflects per-user rows (other user\'s connection does not leak)', async () => {
      const { env } = createAuthEnv(
        { zoomConnections: [{ user_id: 2, email: 'someone-else@zoom.example' }] },
        ZOOM_CONFIGURED
      );
      const res = await worker.default.fetch(getRequest('/api/zoom/status'), env, {});
      const body = await res.json();
      expect(body.connected).toBe(false);
      expect(body.email).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 3. POST /api/zoom/disconnect
  // ----------------------------------------------------------
  describe('POST /api/zoom/disconnect', () => {
    it('returns 200 {ok:true} and issues DELETE FROM zoom_connections for the user', async () => {
      const { env, db } = createAuthEnv(
        { zoomConnections: [{ user_id: 1, email: 'host@zoom.example' }] },
        ZOOM_CONFIGURED
      );
      // disconnect with a configured server attempts a best-effort revoke fetch;
      // stub fetch so the (decrypt-based) revoke path can't make a real call.
      globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return ''; }, async json() { return {}; } });

      const res = await worker.default.fetch(authedPost('/api/zoom/disconnect', {}), env, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const deleteQuery = db._queries.find(q =>
        q.sql.includes('DELETE FROM zoom_connections') && q.sql.includes('WHERE user_id = ?')
      );
      expect(deleteQuery).toBeTruthy();
      expect(deleteQuery.args[0]).toBe(1);

      // Row actually removed from the mock store.
      expect(db._tables.zoom_connections).toHaveLength(0);
    });

    it('still deletes (returns 200) when no connection exists', async () => {
      const { env, db } = createAuthEnv({}, ZOOM_CONFIGURED);
      const res = await worker.default.fetch(authedPost('/api/zoom/disconnect', {}), env, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM zoom_connections'));
      expect(deleteQuery).toBeTruthy();
    });
  });

  // ----------------------------------------------------------
  // 4. connect_zoom AI tool (functional via /api/ai/dashboard)
  // ----------------------------------------------------------
  describe('connect_zoom AI tool', () => {
    it('emits a usable connect_zoom frontend action (NOT in actions_taken) when Zoom is configured', async () => {
      const { env } = createAuthEnv({}, ZOOM_CONFIGURED);

      let calls = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          calls++;
          if (calls === 1) return claudeToolResponse('connect_zoom', {});
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Opening Zoom to connect your account.');
        }
        return originalFetch(url);
      };

      const res = await worker.default.fetch(
        authedPost('/api/ai/dashboard', { message: 'Connect my Zoom account' }),
        env,
        {}
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // A connect_zoom frontend action is emitted...
      expect(body.frontend_actions).toBeTruthy();
      const fa = body.frontend_actions.find(a => a.type === 'connect_zoom');
      expect(fa).toBeTruthy();
      // ...and it is the SUCCESS variant (the tool ran, no error).
      expect(fa.description).toBe('Opening Zoom connection');

      // The tool result fed back to Claude carries the connect action, no error.
      expect(toolResultData).toBeTruthy();
      expect(toolResultData.action).toBe('connect_zoom');
      expect(toolResultData.error).toBeUndefined();

      // connect_zoom must be a frontend action, never a "write action"
      // (it is excluded from actions_taken so the dashboard never lists it
      // alongside real mutations like create/delete).
      const inActionsTaken = (body.actions_taken || []).some(a => a.type === 'connect_zoom');
      expect(inActionsTaken).toBe(false);
    });

    it('returns a tool error (and a non-actionable connect_zoom action) when Zoom is NOT configured', async () => {
      const { env } = createAuthEnv(); // no zoom client id/secret

      let calls = 0;
      let toolResultData = null;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('anthropic')) {
          calls++;
          if (calls === 1) return claudeToolResponse('connect_zoom', {});
          // Capture the tool_result fed back to Claude on the 2nd round.
          if (options?.body) {
            const bodyData = JSON.parse(options.body);
            const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
            if (toolResultMsg) {
              toolResultData = JSON.parse(toolResultMsg.content[0].content);
            }
          }
          return claudeTextResponse('Zoom is not configured on this server, so I cannot connect it.');
        }
        return originalFetch(url);
      };

      const res = await worker.default.fetch(
        authedPost('/api/ai/dashboard', { message: 'Connect my Zoom account' }),
        env,
        {}
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      // The executeDashboardTool 'connect_zoom' case must short-circuit to an
      // error when the server has no Zoom OAuth client configured. This is the
      // load-bearing guard: it returns { error: ... } (NOT { action: ... }).
      expect(toolResultData).toBeTruthy();
      expect(toolResultData.error).toBeTruthy();
      expect(String(toolResultData.error)).toMatch(/not configured/i);
      expect(toolResultData.action).toBeUndefined();

      // NOTE on actual shipped behaviour: because the dashboard loop pushes every
      // tool name into actionsTaken before inspecting the result, a connect_zoom
      // entry is still present in frontend_actions — BUT it is the error variant
      // carrying description 'Zoom not configured', NOT the actionable
      // 'Opening Zoom connection'. If the not-configured guard were reverted, the
      // tool would instead emit the actionable variant, so we pin the description.
      const fa = (body.frontend_actions || []).find(a => a.type === 'connect_zoom');
      expect(fa).toBeTruthy();
      expect(fa.description).toBe('Zoom not configured');
      expect(fa.description).not.toBe('Opening Zoom connection');
    });

    // Source-structure: connect_zoom is a real registered tool with a handler.
    it('declares connect_zoom in DASHBOARD_TOOLS and handles it in executeDashboardTool', () => {
      expect(WORKER_SOURCE).toMatch(/name:\s*'connect_zoom'/);
      expect(WORKER_SOURCE).toMatch(/case\s*'connect_zoom':/);
    });
  });

  // ----------------------------------------------------------
  // 5. Source-structure: shared-credential function removed,
  //    per-user createZoomMeeting in place.
  // ----------------------------------------------------------
  describe('source structure — shared credential removed, per-user token flow', () => {
    it('completely removes the old getZoomAccessToken (account_credentials) function', () => {
      expect(WORKER_SOURCE).not.toContain('getZoomAccessToken');
      expect(WORKER_SOURCE).not.toContain('grant_type=account_credentials');
      expect(WORKER_SOURCE).not.toContain("grant_type: 'account_credentials'");
      expect(WORKER_SOURCE).not.toContain('account_credentials');
    });

    it('createZoomMeeting is DECLARED with (env, hostUserId, booking, eventType) and uses the per-user token', () => {
      // Pin the function DECLARATION specifically (not just any call) so a revert
      // of the signature to the old (env, booking, eventType) form fails here.
      expect(WORKER_SOURCE).toMatch(/async function createZoomMeeting\s*\(\s*env\s*,\s*hostUserId\s*,\s*booking\s*,\s*eventType\s*\)/);
      // Resolves a per-user token and bails out when there isn't one.
      expect(WORKER_SOURCE).toMatch(/getValidZoomToken\s*\(\s*env\s*,\s*hostUserId\s*\)/);
      expect(WORKER_SOURCE).toMatch(/if\s*\(\s*!accessToken\s*\)\s*return null/);
      // POSTs to the per-user "me" meetings endpoint, not a shared user id.
      expect(WORKER_SOURCE).toContain('https://api.zoom.us/v2/users/me/meetings');
    });

    it('the booking-flow call site passes hostUserId into createZoomMeeting', () => {
      // Pin the actual INVOCATION (`await createZoomMeeting(...)`), not the function
      // declaration — the declaration regex would match either, so we require the
      // `await`-prefixed call form carrying hostUserId.
      expect(WORKER_SOURCE).toMatch(/await\s+createZoomMeeting\s*\(\s*env\s*,\s*hostUserId\s*,\s*booking\s*,\s*eventType\s*\)/);
      // And the old shape (no hostUserId) must NOT be present anywhere — if the call
      // site reverts to createZoomMeeting(env, booking, eventType), this fails.
      expect(WORKER_SOURCE).not.toMatch(/createZoomMeeting\s*\(\s*env\s*,\s*booking\s*,\s*eventType\s*\)/);
    });

    it('getValidZoomToken reads the zoom_connections row and returns null with no connection', () => {
      expect(WORKER_SOURCE).toMatch(/async function getValidZoomToken\s*\(\s*env\s*,\s*userId\s*\)/);
      expect(WORKER_SOURCE).toMatch(/FROM zoom_connections WHERE user_id = \?/);
      expect(WORKER_SOURCE).toMatch(/if\s*\(\s*!connection\s*\)\s*return null/);
    });

    it('refreshZoomToken persists the rotated refresh token back to zoom_connections', () => {
      // Scope the assertions to the refreshZoomToken function body so they can't be
      // satisfied by the (separate) OAuth-callback UPDATE statement.
      const declMatch = WORKER_SOURCE.match(/async function refreshZoomToken\s*\([^)]*\)/);
      expect(declMatch).toBeTruthy();
      const start = declMatch.index;
      // Body runs until the next top-level `async function` declaration.
      const next = WORKER_SOURCE.indexOf('async function ', start + declMatch[0].length);
      const body = WORKER_SOURCE.slice(start, next === -1 ? undefined : next);

      // Sends a refresh_token grant to Zoom's token endpoint.
      expect(body).toMatch(/grant_type:\s*'refresh_token'/);
      // Updates BOTH the stored access AND refresh token in zoom_connections.
      expect(body).toMatch(/UPDATE zoom_connections SET access_token_encrypted = \?, refresh_token_encrypted = \?/);
      // Uses the newly returned refresh token (rotation), falling back to the old one.
      // If rotation were dropped (always reuse the old refresh token), this fails.
      expect(body).toMatch(/tokens\.refresh_token[\s\S]{0,120}connection\.refresh_token_encrypted/);
    });
  });

  // ----------------------------------------------------------
  // 6. Source-structure: 'zoom' present in both location_type enums.
  // ----------------------------------------------------------
  describe('source structure — zoom location_type enums restored', () => {
    // Slice the source between a given tool's `name:` declaration and the next
    // tool's `name:` so each assertion is pinned to THAT tool's input_schema.
    // This way, removing 'zoom' from one specific tool's enum fails the matching
    // assertion (a global "any 2 enums contain zoom" check could be fooled by an
    // unrelated enum, so we tie each enum to its tool by name).
    function toolBlock(toolName) {
      const start = WORKER_SOURCE.indexOf(`name: '${toolName}'`);
      expect(start, `tool ${toolName} must exist`).toBeGreaterThan(-1);
      const next = WORKER_SOURCE.indexOf("name: '", start + 1);
      return WORKER_SOURCE.slice(start, next === -1 ? undefined : next);
    }

    function locationEnum(block) {
      const m = block.match(/location_type:\s*\{[^}]*enum:\s*\[([^\]]*)\]/);
      expect(m, 'block must declare a location_type enum').toBeTruthy();
      return m[1];
    }

    it("includes 'zoom' in the create_event_type location_type enum", () => {
      const enumContents = locationEnum(toolBlock('create_event_type'));
      expect(enumContents).toContain("'zoom'");
    });

    it("includes 'zoom' in the update_event_type location_type enum", () => {
      const enumContents = locationEnum(toolBlock('update_event_type'));
      expect(enumContents).toContain("'zoom'");
    });

    it('still has at least two location_type enums and all of them include zoom', () => {
      // Sanity backstop: every location_type enum schema in the file must list zoom.
      const enumMatches = [...WORKER_SOURCE.matchAll(/location_type:\s*\{[^}]*enum:\s*\[([^\]]*)\]/g)];
      expect(enumMatches.length).toBeGreaterThanOrEqual(2);
      const enumsWithZoom = enumMatches.filter(m => m[1].includes("'zoom'"));
      expect(enumsWithZoom.length).toBe(enumMatches.length);
    });
  });
});
