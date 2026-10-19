import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================
// Mock D1 database for calendar connections
// ============================================================

function createMockDB() {
  const storage = {
    calendar_connections: [],
  };

  return {
    storage,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: () => {
          if (sql.includes('FROM calendar_connections WHERE id = ?')) {
            return storage.calendar_connections.find(
              c => c.id === parseInt(args[0]) && c.user_id === parseInt(args[1])
            ) || null;
          }
          if (sql.includes('SELECT s.user_id, u.* FROM sessions')) {
            return { id: 1, email: 'test@example.com', name: 'Test User' };
          }
          return null;
        },
        all: () => ({ results: [] }),
        run: () => ({ success: true }),
      }),
    }),
  };
}

// ============================================================
// Tests
// ============================================================

describe('Calendar Settings API', () => {
  describe('PUT /api/calendars/:id/settings - validation', () => {
    it('should require at least one field', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.calendar_connections.push({
        id: 1, user_id: 1, provider: 'google', email: 'test@gmail.com',
        check_conflicts: 1, write_events: 0, is_primary: 1,
        calendar_id: 'primary', created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const env = {
        DB: db,
        ASSETS: { fetch: () => new Response('') },
      };

      const req = new Request('https://calendo.dev/api/calendars/1/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'session=test-session' },
        body: JSON.stringify({}),
      });

      const res = await worker.default.fetch(req, env);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    it('should validate check_conflicts is boolean', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.calendar_connections.push({
        id: 1, user_id: 1, provider: 'google', email: 'test@gmail.com',
        check_conflicts: 1, write_events: 0, is_primary: 1,
        calendar_id: 'primary', created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const env = {
        DB: db,
        ASSETS: { fetch: () => new Response('') },
      };

      const req = new Request('https://calendo.dev/api/calendars/1/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'session=test-session' },
        body: JSON.stringify({ check_conflicts: 'yes' }),
      });

      const res = await worker.default.fetch(req, env);
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent calendar connection', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      // No calendar connections in storage

      const env = {
        DB: db,
        ASSETS: { fetch: () => new Response('') },
      };

      const req = new Request('https://calendo.dev/api/calendars/999/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'session=test-session' },
        body: JSON.stringify({ check_conflicts: true }),
      });

      const res = await worker.default.fetch(req, env);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/availability-schedules/:id - meeting_limits validation', () => {
    it('should accept valid meeting_limits array', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      // Need to add availability schedule mock support
      db.prepare = ((origPrepare) => (sql) => {
        if (sql.includes('availability_schedules')) {
          return {
            bind: (...args) => ({
              first: () => {
                if (sql.includes('SELECT * FROM availability_schedules WHERE id = ?')) {
                  return {
                    id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/New_York',
                    rules: '[]', overrides: '[]', holidays: '[]', meeting_limits: '[]',
                    is_default: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
                  };
                }
                if (sql.includes('UPDATE availability_schedules SET')) {
                  return {
                    id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/New_York',
                    rules: '[]', overrides: '[]', holidays: '[]',
                    meeting_limits: JSON.stringify([{ type: 'daily', max: 5 }]),
                    is_default: 1, created_at: '2026-01-01', updated_at: new Date().toISOString(),
                  };
                }
                return null;
              },
              all: () => ({ results: [] }),
              run: () => ({ success: true }),
            }),
          };
        }
        return origPrepare(sql);
      })(db.prepare);

      const env = {
        DB: db,
        ASSETS: { fetch: () => new Response('') },
      };

      const req = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'session=test-session' },
        body: JSON.stringify({
          meeting_limits: [{ type: 'daily', max: 5 }],
        }),
      });

      const res = await worker.default.fetch(req, env);
      expect(res.status).toBe(200);
    });

    it('should reject invalid meeting_limits type', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.prepare = ((origPrepare) => (sql) => {
        if (sql.includes('availability_schedules')) {
          return {
            bind: (...args) => ({
              first: () => {
                if (sql.includes('SELECT * FROM availability_schedules WHERE id = ?')) {
                  return {
                    id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/New_York',
                    rules: '[]', overrides: '[]', holidays: '[]', meeting_limits: '[]',
                    is_default: 1,
                  };
                }
                return null;
              },
              all: () => ({ results: [] }),
              run: () => ({ success: true }),
            }),
          };
        }
        return origPrepare(sql);
      })(db.prepare);

      const env = {
        DB: db,
        ASSETS: { fetch: () => new Response('') },
      };

      const req = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'session=test-session' },
        body: JSON.stringify({
          meeting_limits: [{ type: 'monthly', max: 10 }],
        }),
      });

      const res = await worker.default.fetch(req, env);
      expect(res.status).toBe(400);
    });

    it('should accept holidays with enabled field', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.prepare = ((origPrepare) => (sql) => {
        if (sql.includes('availability_schedules')) {
          return {
            bind: (...args) => ({
              first: () => {
                if (sql.includes('SELECT * FROM availability_schedules WHERE id = ?')) {
                  return {
                    id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/New_York',
                    rules: '[]', overrides: '[]', holidays: '[]', meeting_limits: '[]',
                    is_default: 1,
                  };
                }
                if (sql.includes('UPDATE availability_schedules SET')) {
                  return { id: 1, user_id: 1, updated_at: new Date().toISOString() };
                }
                return null;
              },
              all: () => ({ results: [] }),
              run: () => ({ success: true }),
            }),
          };
        }
        return origPrepare(sql);
      })(db.prepare);

      const env = {
        DB: db,
        ASSETS: { fetch: () => new Response('') },
      };

      const req = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'session=test-session' },
        body: JSON.stringify({
          holidays: [
            { date: '2026-12-25', name: 'Christmas', enabled: true },
            { date: '2026-07-04', name: 'Independence Day', enabled: false },
          ],
        }),
      });

      const res = await worker.default.fetch(req, env);
      expect(res.status).toBe(200);
    });
  });
});
