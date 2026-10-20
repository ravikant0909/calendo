import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AI_MODEL, AI_LIMITS, consumeAIQuota } from '../../../src/worker.js';

// Minimal D1-shaped wrapper over a real SQLite engine, so the upsert SQL itself
// is exercised (not a regex mock).
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ai_usage (user_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
           count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, kind))`);
  return {
    raw: db,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => db.prepare(sql).run(...args),
        all: async () => ({ results: db.prepare(sql).all(...args) }),
      }),
    }),
  };
}

const src = readFileSync(new URL('../../../src/worker.js', import.meta.url), 'utf8');

describe('AI model', () => {
  it('every Claude call uses AI_MODEL = claude-haiku-5-5', () => {
    expect(AI_MODEL).toBe('claude-haiku-5-5');
    expect(src).not.toMatch(/model: 'claude-(sonnet|opus|haiku)-[0-9-]+'/);
    expect(src.match(/model: AI_MODEL/g)).toHaveLength(2);
  });

  it('never reads the reply as content[0] (Haiku 5.5 may start with a thinking block)', () => {
    expect(src).not.toMatch(/content\?\.\[0\]\?\.text/);
  });
});

describe('consumeAIQuota', () => {
  let DB;
  beforeEach(() => {
    DB = d1();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it(`allows ${AI_LIMITS.dashboard} dashboard messages a day, then refuses`, async () => {
    for (let i = 1; i <= AI_LIMITS.dashboard; i++) {
      const q = await consumeAIQuota({ DB }, 1, 'dashboard');
      expect(q).toMatchObject({ allowed: true, used: i });
    }
    const over = await consumeAIQuota({ DB }, 1, 'dashboard');
    expect(over).toMatchObject({ allowed: false, used: AI_LIMITS.dashboard + 1, limit: AI_LIMITS.dashboard });
  });

  it('resets on the next UTC day', async () => {
    for (let i = 0; i < AI_LIMITS.dashboard + 1; i++) await consumeAIQuota({ DB }, 1, 'dashboard');
    vi.setSystemTime(new Date('2026-10-21T00:00:01Z'));
    expect((await consumeAIQuota({ DB }, 1, 'dashboard')).allowed).toBe(true);
  });

  it('keeps users and kinds separate', async () => {
    for (let i = 0; i < AI_LIMITS.dashboard + 1; i++) await consumeAIQuota({ DB }, 1, 'dashboard');
    expect((await consumeAIQuota({ DB }, 2, 'dashboard')).allowed).toBe(true);
    expect((await consumeAIQuota({ DB }, 1, 'public')).allowed).toBe(true);
  });

  it('honours AI_FREE_DAILY_LIMIT / AI_PUBLIC_DAILY_LIMIT overrides', async () => {
    const env = { DB, AI_FREE_DAILY_LIMIT: '2', AI_PUBLIC_DAILY_LIMIT: '0' };
    expect((await consumeAIQuota(env, 1, 'dashboard')).allowed).toBe(true);
    expect((await consumeAIQuota(env, 1, 'dashboard')).allowed).toBe(true);
    expect((await consumeAIQuota(env, 1, 'dashboard')).allowed).toBe(false);
    expect((await consumeAIQuota(env, 1, 'public')).allowed).toBe(false);
  });
});

describe('quota is wired into both AI endpoints, skipped for own-key / Pro users', () => {
  function body(name) {
    const i = src.indexOf(`async function ${name}(`);
    return src.slice(i, src.indexOf('\nasync function ', i + 10));
  }
  for (const [fn, kind] of [['handleDashboardAI', 'dashboard'], ['handleAIChat', 'public']]) {
    it(`${fn} checks the '${kind}' quota before calling Claude`, () => {
      const b = body(fn);
      const quotaAt = b.indexOf(`consumeAIQuota(env, `);
      expect(quotaAt).toBeGreaterThan(-1);
      expect(b.slice(quotaAt, quotaAt + 60)).toContain(`'${kind}'`);
      expect(quotaAt).toBeLessThan(b.indexOf('https://api.anthropic.com/v1/messages'));
      expect(b).toMatch(/if \(!\w+\.ownKey && !\w+\.pro\)/);
    });
  }
});
