import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ============================================================
// FEATURE #3 (server side) — first-login product tour
//
// 1. POST /api/product-tour/complete (authed) -> 200 { ok: true }
//    and runs UPDATE users SET product_tour_completed = 1 ... WHERE id = <user.id>.
//    No cookie -> 401.
// 2. start_product_tour AI tool: drive POST /api/ai/dashboard and assert the
//    JSON response has a frontend_actions item with type 'start_product_tour'
//    and that actions_taken (writeActions) does NOT contain it. Plus source
//    asserts on the DASHBOARD_TOOLS array and executeDashboardTool case.
// 3. Schema: schema.sql users table has product_tour_completed; migration
//    0029_product_tour.sql ALTERs users to add it.
// ============================================================

// ------------------------------------------------------------
// Mock DB helper (copied from ai-dashboard.test.js conventions)
// Exposes db._queries = [{ sql, args }] and db._tables.
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
              // AI conversation by session_id
              if (sql.includes('FROM ai_conversations WHERE session_id')) {
                return tables.ai_conversations.find(c => c.session_id === args[0]) || null;
              }
              // Custom domain lookup — return null for calendo.dev
              if (sql.includes('custom_domain')) {
                return null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              // UPDATE users SET product_tour_completed = 1 ...
              if (sql.includes('UPDATE users SET product_tour_completed')) {
                const u = tables.users.find(usr => usr.id === args[args.length - 1]);
                if (u) u.product_tour_completed = 1;
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function createAuthEnv(dbOpts = {}, envOverrides = {}) {
  const user = { id: 1, email: 'test@example.com', name: 'Test User', timezone: 'America/Los_Angeles', password_hash: 'hashed', avatar_url: null, created_at: '2026-01-01T00:00:00Z', product_tour_completed: 0 };
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

// Mock Claude API response that calls a single tool
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

// Mock Claude API final text response (no tool use)
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKER_PATH = path.join(REPO_ROOT, 'src/worker.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'schema.sql');
const MIGRATION_PATH = path.join(REPO_ROOT, 'migrations/0029_product_tour.sql');

// ============================================================
// 1. POST /api/product-tour/complete
// ============================================================
describe('POST /api/product-tour/complete', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  it('returns 200 { ok: true } and marks product_tour_completed = 1 for the user', async () => {
    const { env, db } = createAuthEnv();

    const request = authedRequest('/api/product-tour/complete', {});
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    // The UPDATE must set product_tour_completed = 1, bound to the user's id.
    const updateQuery = db._queries.find(q =>
      q.sql.includes('UPDATE users SET product_tour_completed = 1')
    );
    expect(updateQuery).toBeTruthy();
    expect(updateQuery.sql).toContain('WHERE id = ?');
    // The bound argument (last positional) is the authenticated user's id.
    expect(updateQuery.args[updateQuery.args.length - 1]).toBe(1);

    // And the row was flipped in the mock.
    expect(db._tables.users[0].product_tour_completed).toBe(1);
  });

  it('returns 401 without authentication (no session cookie)', async () => {
    const { env, db } = createAuthEnv();

    const request = new Request('https://calendo.dev/api/product-tour/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(401);

    // No UPDATE should have been issued when unauthenticated.
    const updateQuery = db._queries.find(q =>
      q.sql.includes('UPDATE users SET product_tour_completed')
    );
    expect(updateQuery).toBeUndefined();
  });
});

// ============================================================
// 2. start_product_tour AI tool (POST /api/ai/dashboard)
// ============================================================
describe('start_product_tour AI tool (POST /api/ai/dashboard)', () => {
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

  it('emits a start_product_tour frontend action and does NOT put it in actions_taken', async () => {
    const { env } = createAuthEnv();

    let fetchCallCount = 0;
    let toolResultData = null;
    globalThis.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('anthropic')) {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return claudeToolResponse('start_product_tour', {});
        }
        // Capture the tool result fed back into the second Claude call.
        if (options?.body) {
          const bodyData = JSON.parse(options.body);
          const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
          if (toolResultMsg) {
            toolResultData = JSON.parse(toolResultMsg.content[0].content);
          }
        }
        return claudeTextResponse('Starting the tour');
      }
      return originalFetch(url);
    };

    const request = authedRequest('/api/ai/dashboard', { message: 'Show me around' });
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.message).toBe('Starting the tour');

    // frontend_actions must contain exactly the start_product_tour action and
    // nothing else (this turn triggered only the tour). If the action were
    // dropped from the frontendActions filter this whole array would be omitted.
    expect(Array.isArray(body.frontend_actions)).toBe(true);
    expect(body.frontend_actions).toHaveLength(1);
    const tourAction = body.frontend_actions[0];
    expect(tourAction.type).toBe('start_product_tour');
    // The description is surfaced from executeDashboardTool's start_product_tour case.
    expect(tourAction.description).toBe('Starting the product tour');

    // It must NOT leak into actions_taken (writeActions) — start_product_tour
    // is a frontend-only action, not a recorded write. Since this turn only
    // triggered start_product_tour, writeActions is empty and the handler omits
    // actions_taken entirely. If the filter were reverted (dropping the
    // `a.type !== 'start_product_tour'` exclusion from writeActions),
    // actions_taken would be defined and contain this action.
    expect(body.actions_taken).toBeUndefined();

    // The tool's data payload (fed back to Claude as the tool_result) signals
    // the frontend to start the tour. This is the contract the client reads.
    expect(toolResultData).toBeTruthy();
    expect(toolResultData.action).toBe('start_tour');
  });

  it('keeps start_product_tour out of writeActions even when a real write also runs in the same turn', async () => {
    // Round 1: Claude calls BOTH a real write (create_event_type) and start_product_tour.
    // Expectation: actions_taken (writeActions) contains ONLY create_event_type,
    // and frontend_actions contains ONLY start_product_tour. This is the case that
    // a reverted writeActions filter (missing the start_product_tour exclusion)
    // would break — actions_taken would then contain start_product_tour too.
    const { env } = createAuthEnv();

    let fetchCallCount = 0;
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('anthropic')) {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                content: [
                  { type: 'tool_use', id: 'tu-1', name: 'create_event_type', input: { name: 'Quick Sync', duration_minutes: 15 } },
                  { type: 'tool_use', id: 'tu-2', name: 'start_product_tour', input: {} },
                ],
                stop_reason: 'tool_use',
              };
            },
            async text() { return ''; },
          };
        }
        return claudeTextResponse('Done and starting the tour.');
      }
      return originalFetch(url);
    };

    const request = authedRequest('/api/ai/dashboard', { message: 'Make a 15 min event and show me around' });
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const body = await response.json();

    // actions_taken must contain ONLY the write, never start_product_tour.
    expect(Array.isArray(body.actions_taken)).toBe(true);
    expect(body.actions_taken).toHaveLength(1);
    expect(body.actions_taken[0].type).toBe('create_event_type');
    expect(body.actions_taken.some(a => a.type === 'start_product_tour')).toBe(false);

    // frontend_actions must contain ONLY start_product_tour, not the write.
    expect(Array.isArray(body.frontend_actions)).toBe(true);
    expect(body.frontend_actions).toHaveLength(1);
    expect(body.frontend_actions[0].type).toBe('start_product_tour');
    expect(body.frontend_actions.some(a => a.type === 'create_event_type')).toBe(false);
  });
});

// ============================================================
// 2b. Source-structure asserts: DASHBOARD_TOOLS + executeDashboardTool
// ============================================================
describe('start_product_tour wiring (source structure)', () => {
  const workerSrc = readFileSync(WORKER_PATH, 'utf8');

  it('declares start_product_tour as a dashboard tool', () => {
    expect(workerSrc).toContain("name: 'start_product_tour'");
  });

  it('handles the start_product_tour case returning the start_tour action', () => {
    // Tie the start_tour payload to the start_product_tour case specifically
    // (not a free-floating match elsewhere): the case body, in the few lines
    // following the case label, must return data.action === 'start_tour'.
    const caseIdx = workerSrc.indexOf("case 'start_product_tour':");
    expect(caseIdx).toBeGreaterThan(-1);
    const caseBody = workerSrc.slice(caseIdx, caseIdx + 300);
    expect(caseBody).toMatch(/action:\s*'start_tour'/);
    // It must NOT be a DB write/mutation — a reverted impl that persisted a row
    // here would be wrong. The case body should not run an INSERT/UPDATE/DELETE.
    expect(caseBody).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
  });

  it('routes start_product_tour into frontend actions, not write actions', () => {
    // writeActions must EXCLUDE start_product_tour ...
    const writeLine = workerSrc
      .split('\n')
      .find(l => l.includes('writeActions') && l.includes('filter'));
    expect(writeLine).toBeTruthy();
    expect(writeLine).toContain("a.type !== 'start_product_tour'");

    // ... and frontendActions must INCLUDE start_product_tour.
    const frontendLine = workerSrc
      .split('\n')
      .find(l => l.includes('frontendActions') && l.includes('filter'));
    expect(frontendLine).toBeTruthy();
    expect(frontendLine).toContain("a.type === 'start_product_tour'");
  });
});

// ============================================================
// 3. Schema + migration
// ============================================================
describe('product_tour schema + migration', () => {
  it('schema.sql users table has a product_tour_completed INTEGER column defaulting to 0', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    // Must default to 0 so existing/new users start "not toured" (the tour
    // auto-launches only while this is 0). A column without a 0 default would
    // break the first-login gate.
    expect(schema).toMatch(/product_tour_completed\s+INTEGER\s+DEFAULT\s+0/i);
  });

  it('migration 0029_product_tour.sql ALTERs users to add product_tour_completed with DEFAULT 0', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(/ALTER TABLE users ADD COLUMN product_tour_completed\s+INTEGER\s+DEFAULT\s+0/i);
  });
});
