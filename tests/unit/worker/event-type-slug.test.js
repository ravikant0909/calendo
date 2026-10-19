import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

// ============================================================
// Mock DB helper — tailored for event-type slug behavior.
//
// Tracks every prepared+bound statement in db._queries = [{sql, args}]
// and exposes db._tables for direct inspection. Handlers under test:
//   - handleUpdateEventType  (PUT /api/event-types/:id)
//   - handleCreateEventType  (POST /api/event-types)
// plus the dashboard AI loop (executeDashboardTool).
//
// Notable queries this mock must answer:
//   auth:        SELECT s.user_id, u.* ... sessions
//   update load: SELECT * FROM event_types WHERE id = ? AND user_id = ?
//   slug clash:  SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND id != ?
//   create clash:SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1
//   default sched:SELECT id FROM availability_schedules WHERE user_id = ? AND is_default = 1
//   UPDATE ... RETURNING * (via .first())
//   INSERT ... RETURNING * (via .first())
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
    event_types: ((opts.eventTypes || []).reduce((m, e) => Math.max(m, e.id || 0), 0)) + 1,
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
              // Auth: session -> user
              if (sql.includes('SELECT s.user_id, u.*') && sql.includes('sessions')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }

              // Slug-clash lookup (UPDATE handler + update_event_type tool):
              // SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND id != ?
              if (sql.includes('SELECT id FROM event_types') && sql.includes('AND slug = ?') && sql.includes('id != ?')) {
                const [userId, slug, excludeId] = args;
                return tables.event_types.find(
                  et => et.user_id === userId && et.slug === slug && String(et.id) !== String(excludeId)
                ) || null;
              }

              // Create-handler slug-clash lookup:
              // SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1
              if (sql.includes('SELECT id FROM event_types') && sql.includes('AND slug = ?') && sql.includes('is_active = 1')) {
                const [userId, slug] = args;
                return tables.event_types.find(
                  et => et.user_id === userId && et.slug === slug && et.is_active !== 0
                ) || null;
              }

              // Event type by id + user_id (SELECT *) — used by update handler
              // existing-row lookup AND the update_event_type tool initial load.
              if (sql.includes('FROM event_types WHERE id = ?') && sql.includes('user_id')) {
                return tables.event_types.find(et => String(et.id) === String(args[0]) && et.user_id === args[1]) || null;
              }

              // Default availability schedule
              if (sql.includes('FROM availability_schedules WHERE user_id = ?') && sql.includes('is_default = 1')) {
                return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
              }

              // Booking page by user_id (dashboard context / get_settings)
              if (sql.includes('FROM booking_pages WHERE user_id = ?') && !sql.includes('UPDATE')) {
                return tables.booking_pages.find(bp => bp.user_id === args[0]) || null;
              }

              // AI conversation by session_id
              if (sql.includes('FROM ai_conversations WHERE session_id')) {
                return tables.ai_conversations.find(c => c.session_id === args[0]) || null;
              }

              // Custom domain lookup — none configured
              if (sql.includes('custom_domain')) return null;

              // UPDATE event_types ... RETURNING * (.first())
              if (sql.includes('UPDATE event_types SET') && sql.includes('RETURNING')) {
                // The id is the last bound arg.
                const id = args[args.length - 1];
                const et = tables.event_types.find(e => String(e.id) === String(id));
                if (!et) return null;
                applyEventTypeUpdate(sql, args, et);
                return { ...et };
              }

              // INSERT event_types ... RETURNING * (.first())
              if (sql.includes('INSERT INTO event_types') && sql.includes('RETURNING')) {
                const newET = {
                  id: autoIncrement.event_types++,
                  user_id: args[0],
                  name: args[1],
                  slug: args[2],
                  description: args[3],
                  duration_minutes: args[4],
                  color: args[5],
                  location_type: args[6],
                  is_active: 1,
                };
                tables.event_types.push(newET);
                return { ...newET };
              }

              return null;
            },
            async all() {
              if (sql.includes('FROM event_types WHERE user_id')) {
                return { results: tables.event_types.filter(et => et.user_id === args[0]) };
              }
              if (sql.includes('FROM availability_schedules WHERE user_id')) {
                return { results: tables.availability_schedules.filter(s => s.user_id === args[0]) };
              }
              if (sql.includes('FROM calendar_connections WHERE user_id')) {
                return { results: tables.calendar_connections.filter(c => c.user_id === args[0]) };
              }
              return { results: [] };
            },
            async run() {
              // UPDATE event_types (no RETURNING) — used by update_event_type tool
              if (sql.includes('UPDATE event_types SET') && !sql.includes('RETURNING')) {
                // WHERE id = ? AND user_id = ?  -> id is second-to-last arg
                const id = args[args.length - 2];
                const et = tables.event_types.find(e => String(e.id) === String(id));
                if (et) applyEventTypeUpdate(sql, args, et);
              }
              // INSERT event_types (no RETURNING) — used by create_event_type tool
              if (sql.includes('INSERT INTO event_types') && !sql.includes('RETURNING')) {
                tables.event_types.push({
                  id: autoIncrement.event_types++,
                  user_id: args[0],
                  name: args[1],
                  slug: args[2],
                  is_active: 1,
                });
              }
              // INSERT / UPDATE ai_conversations, audit_log, etc. — no-op
              return { success: true };
            },
          };
        },
      };
    },
  };
}

// Apply a SET clause to an in-memory row by parsing "col = ?" pairs in order.
// Bound values come first; the trailing WHERE binds (id / user_id) are ignored.
function applyEventTypeUpdate(sql, args, et) {
  const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
  if (!setMatch) return;
  const cols = setMatch[1].split(',').map(c => c.trim());
  let argIdx = 0;
  for (const col of cols) {
    const m = col.match(/^(\w+)\s*=\s*\?/);
    if (m) {
      et[m[1]] = args[argIdx++];
    }
    // columns like "updated_at = datetime('now')" have no placeholder — skip,
    // do not advance argIdx.
  }
}

// ============================================================
// Auth helper
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

function authedRequest(path, body, method = 'POST', sessionToken = 'test-session-token') {
  return new Request(`https://calendo.dev${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session=${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
}

// Mock Claude API: single tool call.
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

// Mock Claude API: final text response.
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

// Pull the SET-clause column names actually bound in an UPDATE statement.
function setColumns(updateQuery) {
  const m = updateQuery.sql.match(/SET\s+(.+?)\s+WHERE/is);
  if (!m) return [];
  return m[1].split(',').map(c => c.trim().split('=')[0].trim());
}

// ============================================================
// REST: PUT /api/event-types/:id — slug behavior
// ============================================================

describe('Event type slug — REST PUT /api/event-types/:id', () => {
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

  it('renaming (name-only PUT) does NOT change the slug', async () => {
    const { env, db } = createAuthEnv({
      eventTypes: [
        { id: 7, user_id: 1, name: 'Old Name', slug: 'old-name', description: 'x', duration_minutes: 30, color: '#2563eb', location_type: 'google_meet', is_active: 1 },
      ],
    });

    const request = authedRequest('/api/event-types/7', { name: 'Totally New Name' }, 'PUT');
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET'));
    expect(updateQuery).toBeTruthy();

    const cols = setColumns(updateQuery);
    // The bug (fields.slug = generateSlug(body.name) on every rename) would put
    // 'slug' in the SET clause. Renaming must not touch the slug.
    expect(cols).toContain('name');
    expect(cols).not.toContain('slug');
    // And the buggy value must never appear in the bound args.
    expect(updateQuery.args).not.toContain('totally-new-name');
    expect(updateQuery.args).toContain('Totally New Name');

    // No slug-clash check should run for a name-only update.
    const clashQuery = db._queries.find(q => q.sql.includes('SELECT id FROM event_types') && q.sql.includes('id != ?'));
    expect(clashQuery).toBeUndefined();

    // The stored row keeps its original slug.
    expect(db._tables.event_types[0].slug).toBe('old-name');
  });

  it('explicit slug update is normalized by generateSlug (lowercase + hyphens)', async () => {
    const { env, db } = createAuthEnv({
      eventTypes: [
        { id: 7, user_id: 1, name: 'Intro Call', slug: 'intro-call', duration_minutes: 30, color: '#2563eb', location_type: 'google_meet', is_active: 1 },
      ],
    });

    const request = authedRequest('/api/event-types/7', { slug: 'My New Slug' }, 'PUT');
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET'));
    expect(updateQuery).toBeTruthy();
    expect(setColumns(updateQuery)).toContain('slug');
    // Normalized: 'My New Slug' -> 'my-new-slug'. Raw value must NOT be bound.
    expect(updateQuery.args).toContain('my-new-slug');
    expect(updateQuery.args).not.toContain('My New Slug');

    expect(db._tables.event_types[0].slug).toBe('my-new-slug');
  });

  it('explicit slug that collides with another event type returns 409', async () => {
    const { env, db } = createAuthEnv({
      eventTypes: [
        { id: 7, user_id: 1, name: 'Intro Call', slug: 'intro-call', duration_minutes: 30, color: '#2563eb', location_type: 'google_meet', is_active: 1 },
        { id: 8, user_id: 1, name: 'Demo', slug: 'demo', duration_minutes: 30, color: '#2563eb', location_type: 'google_meet', is_active: 1 },
      ],
    });

    // Try to set event 7's slug to 'demo' — already taken by event 8.
    const request = authedRequest('/api/event-types/7', { slug: 'demo' }, 'PUT');
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/slug/i);

    // The clash check must run AND it must short-circuit before the UPDATE —
    // a 409 should never have written anything to the row.
    const clashQuery = db._queries.find(q =>
      q.sql.includes('SELECT id FROM event_types') && q.sql.includes('id != ?')
    );
    expect(clashQuery).toBeTruthy();
    expect(clashQuery.args).toEqual([1, 'demo', '7']);
    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE event_types SET'));
    expect(updateQuery).toBeUndefined();
    expect(db._tables.event_types.find(et => et.id === 7).slug).toBe('intro-call');
  });
});

// ============================================================
// REST: POST /api/event-types — explicit slug
// ============================================================

describe('Event type slug — REST POST /api/event-types', () => {
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

  it('uses the explicit slug (normalized) when provided', async () => {
    const { env, db } = createAuthEnv();

    const request = authedRequest('/api/event-types', { name: 'Strategy Session', duration_minutes: 30, slug: 'Custom URL Slug' }, 'POST');
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(201);

    const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO event_types'));
    expect(insertQuery).toBeTruthy();
    // slug is the 3rd bound column (user_id, name, slug, ...)
    expect(insertQuery.args[2]).toBe('custom-url-slug');
    // Not derived from the name.
    expect(insertQuery.args[2]).not.toBe('strategy-session');
  });

  it('returns 409 when the explicit slug collides with an existing active event type', async () => {
    const { env } = createAuthEnv({
      eventTypes: [
        { id: 3, user_id: 1, name: 'Existing', slug: 'taken-slug', duration_minutes: 30, color: '#2563eb', location_type: 'google_meet', is_active: 1 },
      ],
    });

    const request = authedRequest('/api/event-types', { name: 'New One', duration_minutes: 30, slug: 'Taken Slug' }, 'POST');
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/use|already/i);
  });
});

// ============================================================
// AI anti-hallucination — source assertions on the worker
// ============================================================

const workerSource = readFileSync(
  new URL('../../../src/worker.js', import.meta.url),
  'utf-8'
);

describe('AI anti-hallucination — dashboard system prompt', () => {
  it('has a rule telling the model to NEVER claim a change unless a tool confirmed it', () => {
    // The new rule (~rule 6) in the dashboard system prompt.
    expect(workerSource).toContain('NEVER claim you changed something unless a tool actually returned a successful result');
  });

  it('explicitly states that renaming does NOT change the slug/URL', () => {
    expect(workerSource).toContain('renaming an event type does NOT change its slug');
    // It must be conditioned on the tool-returned row, not assumed.
    expect(workerSource).toMatch(/only claim the slug changed if you explicitly updated it/i);
  });
});

describe('AI update_event_type tool — schema and executor', () => {
  it('input_schema exposes a slug property', () => {
    // Anchor the assertion to the update_event_type tool block specifically.
    const toolIdx = workerSource.indexOf("name: 'update_event_type'");
    expect(toolIdx).toBeGreaterThan(-1);
    // The slug property and its URL-changing warning live in this tool's schema.
    const block = workerSource.slice(toolIdx, toolIdx + 2000);
    expect(block).toMatch(/slug:\s*\{\s*type:\s*'string'/);
    expect(block).toMatch(/changes the public booking URL/i);
    // The tool's own description must warn the model that a rename does NOT move
    // the slug — a distinct anti-hallucination affordance from the system prompt.
    expect(block).toMatch(/slug does NOT change automatically when you rename/i);
  });

  it('executor re-SELECTs the row and returns { ok: true, event_type } (not an echo of input keys)', () => {
    const caseIdx = workerSource.indexOf("case 'update_event_type':");
    expect(caseIdx).toBeGreaterThan(-1);
    const block = workerSource.slice(caseIdx, caseIdx + 6000);

    // Re-SELECTs the actual row after the UPDATE.
    expect(block).toMatch(/SELECT[\s\S]*FROM event_types WHERE id = \? AND user_id = \?/);
    // Returns the real row, not an assumed diff.
    expect(block).toContain('event_type: updatedEt');
    expect(block).toContain('ok: true');

    // The OLD buggy shape echoed the input keys back as "updated". Make sure
    // that pattern is NOT what update_event_type returns now. (update_settings
    // still uses { updated: Object.keys(input) } — so scope this to the
    // update_event_type block, which ends before the delete_event_type case.)
    const nextCaseIdx = block.indexOf("case 'delete_event_type':");
    const updateBlock = nextCaseIdx > -1 ? block.slice(0, nextCaseIdx) : block;
    expect(updateBlock).not.toContain('updated: Object.keys(input)');
  });
});

describe('AI update_event_type — functional (does not falsely claim slug changed)', () => {
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

  it('renaming via the tool returns the real row with the UNCHANGED slug as the tool result', async () => {
    const { env } = createAuthEnv({
      eventTypes: [
        { id: 1, user_id: 1, name: 'Old Name', slug: 'old-name', duration_minutes: 30, color: '#2563eb', location_type: 'google_meet', is_active: 1 },
      ],
    });

    let fetchCallCount = 0;
    let toolResultData = null;
    globalThis.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('anthropic')) {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return claudeToolResponse('update_event_type', { event_type_id: 1, name: 'Renamed' });
        }
        // Capture the tool_result fed back to the model on the second round.
        if (options?.body) {
          const bodyData = JSON.parse(options.body);
          const toolResultMsg = bodyData.messages.find(m => m.role === 'user' && Array.isArray(m.content));
          if (toolResultMsg) {
            const tr = toolResultMsg.content.find(c => c.type === 'tool_result');
            if (tr) toolResultData = JSON.parse(tr.content);
          }
        }
        return claudeTextResponse('Renamed the event type to "Renamed".');
      }
      return originalFetch(url);
    };

    const request = authedRequest('/api/ai/dashboard', { message: 'Rename event type 1 to Renamed' }, 'POST');
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    // The tool result given back to the model must report the REAL row: ok true,
    // a nested event_type object, and the slug UNCHANGED (no hallucinated
    // 'renamed' slug). This is the data the model is instructed to report from.
    expect(toolResultData).toBeTruthy();
    expect(toolResultData.ok).toBe(true);
    expect(toolResultData.event_type).toBeTruthy();
    expect(toolResultData.event_type.name).toBe('Renamed');
    expect(toolResultData.event_type.slug).toBe('old-name');
    // The old echo shape would have had `updated: [...]` and no event_type.
    expect(toolResultData.updated).toBeUndefined();
  });
});
