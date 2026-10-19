import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ============================================================
// Regression tests for: AI telling users a STALE booking-URL format.
//
// The bug: the live dashboard AI userContext hardcoded the OLD
// `${appOrigin}/booking/?user=${slug}` format, which drifted from the
// real clean short links (`/<slug>` and `/<slug>/<event-slug>`).
//
// The fix: single-source-of-truth EXPORTED helpers — bookingPageUrl()
// and eventTypeBookingUrl() — used by the AI context, the AI tools, and
// everything else. The system prompt also instructs the model to use the
// URLs from context/tools verbatim and never invent a `?user=` format.
//
// These tests fail if the fix is reverted (helpers removed / context goes
// back to building `booking/?user=` inline / the prompt rule disappears).
// Reference: tests/unit/worker/ai-dashboard.test.js
// ============================================================

// ------------------------------------------------------------
// Mock DB helper — tailored for dashboard AI tool execution
// (mirrors tests/unit/worker/ai-dashboard.test.js createMockDB)
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
              // get_booking_link: event type slug+name by id+user_id
              if (sql.includes('SELECT slug, name FROM event_types WHERE id = ?')) {
                return tables.event_types.find(et => et.id === args[0] && et.user_id === args[1]) || null;
              }
              // get_booking_link: booking page slug by user_id
              if (sql.includes('SELECT slug FROM booking_pages WHERE user_id = ?')) {
                return tables.booking_pages.find(bp => bp.user_id === args[0]) || null;
              }
              // dashboard context: full booking page by user_id
              if (sql.includes('FROM booking_pages WHERE user_id = ?')) {
                return tables.booking_pages.find(bp => bp.user_id === args[0]) || null;
              }
              // zoom connection lookup — none in tests
              if (sql.includes('zoom_connections')) {
                return null;
              }
              // AI conversation by session_id
              if (sql.includes('FROM ai_conversations WHERE session_id')) {
                return tables.ai_conversations.find(c => c.session_id === args[0]) || null;
              }
              // custom domain lookup
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
              // ai_conversations upsert — no-op
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function createAuthEnv(dbOpts = {}, envOverrides = {}) {
  const user = { id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles', password_hash: 'hashed', avatar_url: null, created_at: '2026-01-01T00:00:00Z' };
  const session = { id: 'sess-1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' };

  const defaults = {
    users: [user],
    sessions: [session],
    bookingPages: [{ id: 1, user_id: 1, slug: 'rg', display_name: 'Test User', bio: null, brand_color: '#2563eb', logo_url: null, hide_branding: 0, custom_domain: null }],
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

// Capture the tool_result JSON the worker feeds BACK to the model on the 2nd
// Anthropic request (this is what the AI sees, hence what it tells the user).
function makeToolThenTextFetch(originalFetch, toolName, toolInput, captureRef) {
  let fetchCallCount = 0;
  return async (url, options) => {
    if (typeof url === 'string' && url.includes('anthropic')) {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return claudeToolResponse(toolName, toolInput);
      }
      if (options?.body) {
        const bodyData = JSON.parse(options.body);
        const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
        if (toolResultMsg) {
          captureRef.value = JSON.parse(toolResultMsg.content[0].content);
        }
      }
      return claudeTextResponse('Here is your link');
    }
    return originalFetch(url);
  };
}

// ============================================================
// Tests
// ============================================================

describe('AI booking-URL freshness (no stale ?user= format)', () => {
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
  // 1. Functional — the helpers are EXPORTED and produce short links.
  //    If reverted (helpers deleted), import fails / values change.
  // ----------------------------------------------------------
  describe('exported URL helpers (single source of truth)', () => {
    it('exports bookingPageUrl producing a clean /<slug> short link', () => {
      expect(typeof worker.bookingPageUrl).toBe('function');
      expect(worker.bookingPageUrl('https://calendo.dev', 'rg')).toBe('https://calendo.dev/rg');
      // never the legacy query format
      expect(worker.bookingPageUrl('https://calendo.dev', 'rg')).not.toContain('booking/?user=');
    });

    it('exports eventTypeBookingUrl producing /<slug>/<event-slug>', () => {
      expect(typeof worker.eventTypeBookingUrl).toBe('function');
      expect(worker.eventTypeBookingUrl('https://calendo.dev', 'rg', 'intro')).toBe('https://calendo.dev/rg/intro');
      expect(worker.eventTypeBookingUrl('https://calendo.dev', 'rg', 'intro')).not.toContain('booking/?user=');
    });
  });

  // ----------------------------------------------------------
  // 2. Functional — the tool_result fed back to the model carries the
  //    SHORT url and never the stale `booking/?user=` form. This is the
  //    exact text the AI repeats to the user.
  // ----------------------------------------------------------
  describe('get_booking_link tool result (what the AI sees)', () => {
    it('main booking page link is the short /<slug> form, not booking/?user=', async () => {
      const { env } = createAuthEnv(); // slug = 'rg'
      const capture = { value: null };
      globalThis.fetch = makeToolThenTextFetch(originalFetch, 'get_booking_link', {}, capture);

      const request = authedRequest('/api/ai/dashboard', { message: 'What is my booking link?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(capture.value).toBeTruthy();
      expect(capture.value.url).toBe('https://calendo.dev/rg');
      expect(capture.value.url).toContain('/rg');
      // Hard negative: the stale format must be gone.
      expect(capture.value.url).not.toContain('booking/?user=');
      expect(JSON.stringify(capture.value)).not.toContain('booking/?user=');
    });

    it('event-type link is the short /<slug>/<event-slug> form, not booking/?user=', async () => {
      const { env } = createAuthEnv({
        eventTypes: [
          { id: 5, user_id: 1, name: '30 Minute Meeting', slug: '30-minute-meeting', duration_minutes: 30, color: '#2563eb', is_active: 1 },
        ],
      });
      const capture = { value: null };
      globalThis.fetch = makeToolThenTextFetch(originalFetch, 'get_booking_link', { event_type_id: 5 }, capture);

      const request = authedRequest('/api/ai/dashboard', { message: 'Link for event type 5?' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      expect(capture.value).toBeTruthy();
      expect(capture.value.url).toBe('https://calendo.dev/rg/30-minute-meeting');
      expect(capture.value.event_name).toBe('30 Minute Meeting');
      expect(capture.value.url).not.toContain('booking/?user=');
    });
  });

  // ----------------------------------------------------------
  // 3. Source-structure — assert BOTH the new code is present (helpers
  //    used in context/tools) AND the old buggy pattern is absent from
  //    the AI prompt/context construction region.
  // ----------------------------------------------------------
  describe('dashboard AI prompt/context source structure', () => {
    let source;
    let promptRegion;

    beforeEach(() => {
      const here = dirname(fileURLToPath(import.meta.url));
      const workerPath = join(here, '../../../src/worker.js');
      source = readFileSync(workerPath, 'utf8');

      // Scope to the AI prompt/context region: from the real userContext
      // construction ('## Current User Context', which appears exactly once —
      // the bare phrase also shows up earlier in the knowledge base, so we
      // anchor on the '## ' markdown heading) through the end of the Rules
      // list. `booking/?user=` legitimately appears elsewhere (inbound
      // URL-rewrite comments near the top, and one explanatory comment on the
      // helpers) — those are out of scope.
      const start = source.indexOf('## Current User Context');
      expect(start).toBeGreaterThan(-1);
      // Guard the anchor's uniqueness so the region can't silently re-broaden
      // if the heading text is duplicated elsewhere in future.
      expect(source.indexOf('## Current User Context', start + 1)).toBe(-1);
      // The Rules list ends with rule 11's off-topic refusal sentinel.
      const end = source.indexOf('Do NOT answer off-topic questions under any circumstances.', start);
      expect(end).toBeGreaterThan(start);
      promptRegion = source.slice(start, end);
    });

    it('booking page URL context line uses bookingPageUrl(), not an inline booking/?user= literal', () => {
      // New code present: the booking-page URL line calls the helper.
      expect(promptRegion).toMatch(/Booking page URL\*\*:[\s\S]*?bookingPageUrl\(appOrigin/);
    });

    it('per-event-type context line uses eventTypeBookingUrl()', () => {
      expect(promptRegion).toContain('eventTypeBookingUrl(appOrigin');
    });

    it('system prompt has a rule to use URLs from context/tools verbatim and never invent ?user=', () => {
      // The rule must tell the model to use given URLs verbatim...
      expect(promptRegion).toMatch(/verbatim/i);
      // ...and explicitly warn off the legacy ?user= format.
      expect(promptRegion).toMatch(/\?user=/);
      expect(promptRegion).toMatch(/short link/i);
    });

    it('the stale booking/?user= format does NOT appear in the prompt/context region', () => {
      // This is the core anti-regression: nothing in the AI prompt/context
      // construction may hand-build the old query-string URL format.
      expect(promptRegion).not.toContain('booking/?user=');
      expect(promptRegion).not.toContain('/booking/?user=');
      expect(promptRegion).not.toContain('${appOrigin}/booking');
    });
  });
});
