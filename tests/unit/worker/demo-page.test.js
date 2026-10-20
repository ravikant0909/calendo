import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AI_LIMITS } from '../../../src/ai-limits.js';

// Real SQLite with the real schema, wrapped in the D1 shape, so the demo path
// is checked against actual table contents (nothing written) rather than mocks.
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true, meta: {} }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    raw: db,
    prepare: (sql) => ({ bind: (...args) => stmt(sql, args), ...stmt(sql, []) }),
    batch: async (list) => Promise.all(list.map(s => s.run())),
  };
}

function seed(db, slug) {
  const u = db.prepare("INSERT INTO users (email, password_hash, name, timezone) VALUES (?, '!', 'Demo Host', 'UTC') RETURNING id")
    .get(`${slug}@example.com`);
  db.prepare("INSERT INTO booking_pages (user_id, slug, display_name) VALUES (?, ?, 'Demo Host')").run(u.id, slug);
  const rules = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start: '00:00', end: '23:59' })));
  db.prepare("INSERT INTO availability_schedules (user_id, name, timezone, rules, is_default) VALUES (?, 'All day', 'UTC', ?, 1)").run(u.id, rules);
  db.prepare("INSERT INTO event_types (user_id, name, slug, duration_minutes, min_notice_hours, location_type) VALUES (?, 'Intro call', 'intro', 30, 0, 'custom')").run(u.id);
  return u.id;
}

// Tomorrow 12:00 UTC: inside the all-day schedule, on the 15-minute grid.
function slot() {
  const d = new Date(Date.now() + 86400000);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

describe('demo booking page', () => {
  let worker, env, DB, fetchSpy;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
    DB = d1();
    seed(DB.raw, 'demo');
    seed(DB.raw, 'realhost');
    env = { DB, ASSETS: { fetch: () => new Response('') }, DEMO_SLUGS: 'demo', ANTHROPIC_API_KEY: 'test', APP_ORIGIN: 'https://calendo.test' };
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => vi.restoreAllMocks());

  const call = (path, body, ip = '1.2.3.4') => worker.default.fetch(new Request(`https://calendo.test${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });

  it('isDemoSlug reads the comma-separated DEMO_SLUGS list, case-insensitively', () => {
    expect(worker.isDemoSlug({ DEMO_SLUGS: 'demo, Try' }, 'try')).toBe(true);
    expect(worker.isDemoSlug({ DEMO_SLUGS: 'demo' }, 'DEMO')).toBe(true);
    expect(worker.isDemoSlug({ DEMO_SLUGS: 'demo' }, 'demo2')).toBe(false);
    expect(worker.isDemoSlug({}, 'demo')).toBe(false);
  });

  it('booking-page API flags demo pages and only demo pages', async () => {
    expect((await (await call('/api/booking-page/demo')).json()).demo).toBe(true);
    expect((await (await call('/api/booking-page/realhost')).json()).demo).toBe(false);
  });

  it('a demo booking succeeds but saves nothing and sends nothing', async () => {
    const res = await call('/api/book/demo/intro', { name: 'Ann', email: 'ann@example.com', timezone: 'UTC', start_time: slot() });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.demo).toBe(true);
    expect(data.booking).toMatchObject({ uid: null, cancel_token: null, event_name: 'Intro call', status: 'confirmed' });
    expect(DB.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled(); // no email / webhook / calendar calls
  });

  it('a demo booking is still validated (bad slot is rejected)', async () => {
    const bad = new Date(Date.now() + 86400000);
    bad.setUTCHours(12, 7, 0, 0); // off the 15-minute grid
    const res = await call('/api/book/demo/intro', { name: 'Ann', email: 'ann@example.com', timezone: 'UTC', start_time: bad.toISOString() });
    expect(res.status).toBe(409);
  });

  it('a normal page still saves the booking', async () => {
    env.DISABLE_OUTBOUND_NOTIFICATIONS = '1';
    fetchSpy.mockResolvedValue(new Response('{}'));
    const res = await call('/api/book/realhost/intro', { name: 'Bo', email: 'bo@example.com', timezone: 'UTC', start_time: slot() });
    expect(res.status).toBe(201);
    expect((await res.json()).demo).toBeUndefined();
    expect(DB.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n).toBe(1);
  });

  describe('AI chat on a demo page', () => {
    beforeEach(() => {
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Tomorrow at noon works.' }] })));
    });
    const usage = (kind) => DB.raw.prepare('SELECT COALESCE(SUM(count),0) AS n FROM ai_usage WHERE kind = ?').get(kind).n;

    it('counts against the shared demo cap, not the host public cap', async () => {
      const res = await call('/api/ai/chat', { booking_page_slug: 'demo', message: 'any time tomorrow?' });
      expect((await res.json()).message).toContain('noon');
      expect(usage('demo')).toBe(1);
      expect(usage('public')).toBe(0);
      expect(AI_LIMITS.demo).toBeGreaterThan(AI_LIMITS.public);
    });

    it('stops when the shared daily demo cap is used up', async () => {
      env.AI_DEMO_DAILY_LIMIT = '1';
      await call('/api/ai/chat', { booking_page_slug: 'demo', message: 'hi' });
      const second = await (await call('/api/ai/chat', { booking_page_slug: 'demo', message: 'hi again' }, '5.6.7.8')).json();
      expect(second.limit_reached).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('limits each visitor IP per hour so one person cannot drain the cap', async () => {
      const { DEMO_CHAT_PER_IP_HOURLY } = await import('../../../src/ai-limits.js');
      for (let i = 0; i < DEMO_CHAT_PER_IP_HOURLY; i++) {
        const r = await (await call('/api/ai/chat', { booking_page_slug: 'demo', message: `m${i}` }, '9.9.9.9')).json();
        expect(r.limit_reached).toBeUndefined();
      }
      const over = await (await call('/api/ai/chat', { booking_page_slug: 'demo', message: 'one more' }, '9.9.9.9')).json();
      expect(over.limit_reached).toBe(true);
      const other = await (await call('/api/ai/chat', { booking_page_slug: 'demo', message: 'hi' }, '8.8.8.8')).json();
      expect(other.limit_reached).toBeUndefined();
    }, 30000); // ~30 real chat round trips; slow on CI runners
  });
});
