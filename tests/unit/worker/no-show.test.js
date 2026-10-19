import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('No-Show API', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
  });

  // Helper to build a mock DB that handles auth + booking queries
  function createEnv({ sessionUser, booking, runCalls } = {}) {
    const runs = runCalls || [];
    return {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              return {
                first() {
                  // Auth session lookup
                  if (sql.includes('SELECT s.user_id, u.*')) {
                    return sessionUser || null;
                  }
                  // API key lookup
                  if (sql.includes('SELECT u.* FROM api_keys')) {
                    return null;
                  }
                  // Booking lookup for no-show handler
                  if (sql.includes('SELECT b.* FROM bookings b JOIN event_types et')) {
                    return typeof booking === 'function' ? booking(args) : (booking || null);
                  }
                  return null;
                },
                all() {
                  return { results: [] };
                },
                run() {
                  runs.push({ sql, args });
                  return { success: true };
                },
              };
            },
          };
        },
      },
      ASSETS: { fetch: () => new Response('') },
    };
  }

  function callWorker(url, method, env, body) {
    const options = { method, headers: { Cookie: 'session=test-token' } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return worker.default.fetch(new Request(url, options), env, {});
  }

  const pastDate = '2026-01-15 10:00:00';
  const futureDate = new Date(Date.now() + 86400000).toISOString().replace('T', ' ').slice(0, 19);

  const testUser = {
    id: 1,
    user_id: 1,
    email: 'host@example.com',
    name: 'Host User',
    timezone: 'UTC',
  };

  describe('POST /api/bookings/:id/no-show', () => {
    it('should mark a past confirmed booking as no-show', async () => {
      const runs = [];
      const env = createEnv({
        sessionUser: testUser,
        booking: {
          id: 42,
          status: 'confirmed',
          start_time: pastDate,
          event_type_id: 1,
          invitee_name: 'Alice',
          invitee_email: 'alice@example.com',
        },
        runCalls: runs,
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/42/no-show',
        'POST',
        env
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Verify the UPDATE was called with no_show status
      const updateCall = runs.find(r => r.sql.includes("status = 'no_show'"));
      expect(updateCall).toBeDefined();
    });

    it('should return 404 for a non-existent booking', async () => {
      const env = createEnv({
        sessionUser: testUser,
        booking: null,
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/999/no-show',
        'POST',
        env
      );

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Not found');
    });

    it('should return 400 for a cancelled booking', async () => {
      const env = createEnv({
        sessionUser: testUser,
        booking: {
          id: 42,
          status: 'cancelled',
          start_time: pastDate,
          event_type_id: 1,
        },
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/42/no-show',
        'POST',
        env
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('cancelled');
    });

    it('should return 400 for an already no-show booking', async () => {
      const env = createEnv({
        sessionUser: testUser,
        booking: {
          id: 42,
          status: 'no_show',
          start_time: pastDate,
          event_type_id: 1,
        },
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/42/no-show',
        'POST',
        env
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('no-show');
    });

    it('should return 400 for a future booking', async () => {
      const env = createEnv({
        sessionUser: testUser,
        booking: {
          id: 42,
          status: 'confirmed',
          start_time: futureDate,
          event_type_id: 1,
        },
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/42/no-show',
        'POST',
        env
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('future');
    });

    it('should return 401 without authentication', async () => {
      const env = createEnv({ sessionUser: null });

      const res = await worker.default.fetch(
        new Request('https://calendo.dev/api/bookings/42/no-show', { method: 'POST' }),
        env,
        {}
      );

      expect(res.status).toBe(401);
    });

    it('should not allow marking a booking owned by another user', async () => {
      // booking lookup returns null because the JOIN on et.user_id won't match
      const env = createEnv({
        sessionUser: testUser,
        booking: null,
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/42/no-show',
        'POST',
        env
      );

      expect(res.status).toBe(404);
    });
  });
});

describe('No-Show in Analytics', () => {
  it('should include no_show_count and no_show_rate in analytics response', async () => {
    vi.resetModules();
    const worker = await import('../../../src/worker.js');

    const env = {
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                first() {
                  // Auth
                  if (sql.includes('SELECT s.user_id, u.*')) {
                    return { id: 1, user_id: 1, email: 'test@example.com', name: 'Test', timezone: 'UTC' };
                  }
                  if (sql.includes('SELECT u.* FROM api_keys')) {
                    return null;
                  }
                  // Analytics total query
                  if (sql.includes('COUNT(*) as total')) {
                    return { total: 10, cancelled: 2, active: 6, no_show: 2 };
                  }
                  // This month / last month counts
                  if (sql.includes('COUNT(*) as count')) {
                    return { count: 3 };
                  }
                  return null;
                },
                all() {
                  if (sql.includes('GROUP BY et.id')) {
                    return { results: [{ name: 'Test Event', color: '#2563eb', bookings: 10, cancelled: 2, no_shows: 2 }] };
                  }
                  return { results: [] };
                },
                run() { return {}; },
              };
            },
          };
        },
      },
      ASSETS: { fetch: () => new Response('') },
    };

    const res = await worker.default.fetch(
      new Request('https://calendo.dev/api/analytics', {
        method: 'GET',
        headers: { Cookie: 'session=test-token' },
      }),
      env,
      {}
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('no_show_count');
    expect(data).toHaveProperty('no_show_rate');
    expect(data.no_show_count).toBe(2);
    expect(data.no_show_rate).toBe(20);
  });
});

describe('No-Show AI Tool', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
  });

  it('mark_no_show tool should exist in DASHBOARD_TOOLS', async () => {
    // We access the tools via testing the actual tool execution
    // The tool is tested through the executeDashboardTool function
    const runs = [];
    const env = {
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                first() {
                  if (sql.includes('SELECT s.user_id, u.*')) {
                    return { id: 1, user_id: 1, email: 'test@example.com', name: 'Test', timezone: 'UTC' };
                  }
                  if (sql.includes('SELECT u.* FROM api_keys')) return null;
                  // mark_no_show booking lookup
                  if (sql.includes('b.id') && sql.includes('b.invitee_name')) {
                    return { id: 5, invitee_name: 'Bob', start_time: '2026-01-10 09:00:00', status: 'confirmed' };
                  }
                  return null;
                },
                all() { return { results: [] }; },
                run() {
                  runs.push(sql);
                  return {};
                },
              };
            },
          };
        },
      },
      ASSETS: { fetch: () => new Response('') },
      ANTHROPIC_API_KEY: 'test-key',
    };

    // Simulate a Claude response that calls mark_no_show
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_123',
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'mark_no_show', input: { booking_id: 5 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_456',
      content: [
        { type: 'text', text: 'Done! I marked the booking with Bob as a no-show.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }), { status: 200 }));

    const res = await worker.default.fetch(
      new Request('https://calendo.dev/api/ai/dashboard', {
        method: 'POST',
        headers: { Cookie: 'session=test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Mark booking 5 as no-show' }),
      }),
      env,
      {}
    );

    globalThis.fetch = originalFetch;

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain('no-show');

    // Verify the update SQL was called
    const updateSql = runs.find(s => s.includes("'no_show'"));
    expect(updateSql).toBeDefined();
  });
});
