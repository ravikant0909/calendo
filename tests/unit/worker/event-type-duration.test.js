import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

// Reuse the slug test's harness pattern (same handlers/mock). Kept in its own
// file for clarity. Verifies a meeting type can be ANY duration 5-720 (e.g. 20),
// via REST and via the AI tool — not just the old fixed 15/30/45/60/90/120 set.

function createMockDB(opts = {}) {
  const tables = {
    users: opts.users || [], sessions: opts.sessions || [],
    booking_pages: opts.bookingPages || [], availability_schedules: opts.availabilitySchedules || [],
    event_types: opts.eventTypes || [], bookings: opts.bookings || [],
    calendar_connections: opts.calendarConnections || [], ai_conversations: opts.aiConversations || [],
  };
  let auto = { event_types: ((opts.eventTypes || []).reduce((m, e) => Math.max(m, e.id || 0), 0)) + 1 };
  const queries = [];
  const eq = (a, b) => Number(a) === Number(b);          // path ids arrive as strings
  // Apply an INSERT by mapping bound args to the statement's column list (handles
  // both the REST and AI executors, which use different column orders).
  function applyInsert(sql, args) {
    const cols = sql.match(/INSERT INTO event_types\s*\(([^)]+)\)/i)[1].split(',').map(c => c.trim());
    const row = { id: auto.event_types++ };
    cols.forEach((c, i) => { row[c] = args[i]; });
    if (row.is_active === undefined) row.is_active = 1;
    tables.event_types.push(row);
    return row;
  }
  function applyUpdate(sql, args) {
    const id = args[args.length - 1];                    // ...WHERE id = ? (AND user_id = ?)
    const uid = args[args.length - 2];
    const row = tables.event_types.find(e => eq(e.id, id) || (eq(e.id, uid)));
    if (!row) return null;
    const cols = sql.match(/SET\s+(.+?)\s+WHERE/is)[1].split(',').map(c => c.trim().split('=')[0].trim());
    cols.forEach((c, i) => { if (c !== 'updated_at') row[c] = args[i]; });
    return row;
  }
  const api = {
    _tables: tables, _queries: queries,
    prepare(sql) {
      return { bind(...args) {
        queries.push({ sql, args });
        return {
          async first() {
            if (sql.includes('s.user_id, u.*') && sql.includes('sessions')) {
              const s = tables.sessions.find(x => x.token === args[0]); if (!s) return null;
              const u = tables.users.find(x => x.id === s.user_id); return u ? { ...u, user_id: u.id } : null;
            }
            if (sql.includes('FROM event_types WHERE id = ?') && sql.includes('user_id')) {
              return tables.event_types.find(e => eq(e.id, args[0]) && eq(e.user_id, args[1])) || null;
            }
            if (sql.includes('FROM event_types WHERE id = ?')) {
              return tables.event_types.find(e => eq(e.id, args[0])) || null;
            }
            if (sql.includes('SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND is_active')) {
              return tables.event_types.find(e => eq(e.user_id, args[0]) && e.slug === args[1] && e.is_active) || null;
            }
            if (sql.includes('SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND id !=')) {
              return tables.event_types.find(e => eq(e.user_id, args[0]) && e.slug === args[1] && !eq(e.id, args[2])) || null;
            }
            if (sql.includes('FROM booking_pages WHERE user_id = ?')) return tables.booking_pages.find(b => eq(b.user_id, args[0])) || null;
            if (sql.includes('availability_schedules WHERE user_id = ? AND is_default')) return tables.availability_schedules.find(s => eq(s.user_id, args[0]) && s.is_default) || null;
            if (sql.includes('FROM zoom_connections')) return null;
            if (sql.startsWith('INSERT INTO event_types')) return applyInsert(sql, args);
            if (sql.startsWith('UPDATE event_types SET')) return applyUpdate(sql, args);
            return null;
          },
          async all() {
            if (sql.includes('FROM event_types')) return { results: tables.event_types };
            return { results: [] };
          },
          async run() {
            if (sql.startsWith('INSERT INTO event_types')) applyInsert(sql, args);
            else if (sql.startsWith('UPDATE event_types SET')) applyUpdate(sql, args);
            return { success: true };
          },
        };
      } };
    },
  };
  return api;
}

function createAuthEnv(dbOpts = {}, envOverrides = {}) {
  const user = { id: 1, email: 't@e.com', name: 'T', timezone: 'America/Los_Angeles', password_hash: 'h', avatar_url: null, created_at: '2026-01-01T00:00:00Z' };
  const session = { id: 's1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' };
  const db = createMockDB({
    users: [user], sessions: [session],
    bookingPages: [{ id: 1, user_id: 1, slug: 'test-user', display_name: 'T' }],
    availabilitySchedules: [{ id: 1, user_id: 1, name: 'WH', timezone: 'UTC', rules: '[]', overrides: '[]', is_default: true }],
    ...dbOpts,
  });
  return { env: { DB: db, ASSETS: { fetch: () => new Response('') }, ANTHROPIC_API_KEY: 'k', ...envOverrides }, db };
}
function req(path, body, method = 'POST') {
  return new Request(`https://calendo.dev${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: 'session=test-session-token' }, body: JSON.stringify(body) });
}
function setColumns(q) { const m = q.sql.match(/SET\s+(.+?)\s+WHERE/is); return m ? m[1].split(',').map(c => c.trim().split('=')[0].trim()) : []; }

describe('Event type duration — any value 5-720', () => {
  let worker, realFetch;
  beforeEach(async () => { worker = await import('../../../src/worker.js'); realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('REST create accepts a 20-minute duration (binds 20 in the INSERT)', async () => {
    const { env, db } = createAuthEnv();
    const res = await worker.default.fetch(req('/api/event-types', { name: 'Quick Sync', duration_minutes: 20, location_type: 'google_meet' }, 'POST'), env, {});
    expect(res.status).toBeLessThan(300);
    const ins = db._queries.find(q => q.sql.startsWith('INSERT INTO event_types'));
    expect(ins).toBeTruthy();
    expect(ins.args).toContain(20);
    expect(db._tables.event_types.some(e => e.duration_minutes === 20)).toBe(true);
  });

  it('REST update accepts a 20-minute duration', async () => {
    const { env, db } = createAuthEnv({ eventTypes: [{ id: 7, user_id: 1, name: 'X', slug: 'x', duration_minutes: 30, is_active: 1 }] });
    const res = await worker.default.fetch(req('/api/event-types/7', { duration_minutes: 20 }, 'PUT'), env, {});
    expect(res.status).toBe(200);
    const upd = db._queries.find(q => q.sql.startsWith('UPDATE event_types SET'));
    expect(setColumns(upd)).toContain('duration_minutes');
    expect(upd.args).toContain(20);
    expect(db._tables.event_types[0].duration_minutes).toBe(20);
  });

  it('REST update rejects durations out of the 5-720 range (no write)', async () => {
    for (const bad of [3, 0, 1000, -10]) {
      const { env, db } = createAuthEnv({ eventTypes: [{ id: 7, user_id: 1, name: 'X', slug: 'x', duration_minutes: 30, is_active: 1 }] });
      const res = await worker.default.fetch(req('/api/event-types/7', { duration_minutes: bad }, 'PUT'), env, {});
      expect(res.status).toBe(400);
      expect(db._queries.find(q => q.sql.startsWith('UPDATE event_types SET'))).toBeUndefined();
      expect(db._tables.event_types[0].duration_minutes).toBe(30);
    }
  });

  it('AI create_event_type creates a 20-minute meeting', async () => {
    const { env, db } = createAuthEnv();
    let n = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('anthropic')) {
        n++;
        return n === 1
          ? { ok: true, status: 200, async json() { return { content: [{ type: 'tool_use', id: 't1', name: 'create_event_type', input: { name: 'Coffee', duration_minutes: 20 } }], stop_reason: 'tool_use' }; }, async text() { return ''; } }
          : { ok: true, status: 200, async json() { return { content: [{ type: 'text', text: 'Created your 20-minute Coffee.' }], stop_reason: 'end_turn' }; }, async text() { return ''; } };
      }
      return realFetch(url);
    };
    const res = await worker.default.fetch(req('/api/ai/dashboard', { message: 'make a 20 minute coffee chat' }, 'POST'), env, {});
    expect(res.status).toBe(200);
    expect(db._tables.event_types.some(e => e.duration_minutes === 20)).toBe(true);
  });

  it('the create_event_type AI tool no longer advertises only the fixed durations', () => {
    const src = readFileSync('src/worker.js', 'utf8');
    // The duration description must not lock the model to the old fixed set...
    expect(src).not.toMatch(/Duration in minutes \(15, 30, 45, 60, 90, or 120\)/);
    // ...and should signal the real 5-720 range.
    expect(src).toMatch(/Duration in minutes[^']*5 to 720/);
  });
});
