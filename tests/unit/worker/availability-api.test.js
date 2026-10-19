import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mock D1 database helper
// ============================================================

function createMockDB() {
  const storage = {
    availability_schedules: [],
    event_types: [],
  };
  let idCounter = 1;

  return {
    storage,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: () => {
          if (sql.includes('SELECT * FROM availability_schedules WHERE id = ?')) {
            return storage.availability_schedules.find(
              s => s.id === parseInt(args[0]) && s.user_id === parseInt(args[1])
            ) || null;
          }
          if (sql.includes('INSERT INTO availability_schedules')) {
            const id = idCounter++;
            const record = {
              id,
              user_id: args[0],
              name: args[1],
              timezone: args[2],
              rules: args[3],
              overrides: args[4],
              is_default: args[5],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            storage.availability_schedules.push(record);
            return record;
          }
          if (sql.includes('UPDATE availability_schedules SET')) {
            // Find and update
            const scheduleId = args[args.length - 2];
            const userId = args[args.length - 1];
            const schedule = storage.availability_schedules.find(
              s => s.id === parseInt(scheduleId) && s.user_id === parseInt(userId)
            );
            if (schedule) {
              // Simple mock: just return the schedule with updated_at
              return { ...schedule, updated_at: new Date().toISOString() };
            }
            return null;
          }
          return null;
        },
        all: () => {
          if (sql.includes('SELECT * FROM availability_schedules WHERE user_id')) {
            return {
              results: storage.availability_schedules.filter(s => s.user_id === parseInt(args[0]))
            };
          }
          return { results: [] };
        },
        run: () => ({ success: true }),
      }),
    }),
  };
}

function createAuthenticatedEnv(db, userId = 1) {
  return {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: () => {
            // Auth check
            if (sql.includes('SELECT s.user_id, u.* FROM sessions')) {
              return { id: userId, email: 'test@example.com', name: 'Test User' };
            }
            return db.prepare(sql).bind(...args).first();
          },
          all: () => db.prepare(sql).bind(...args).all(),
          run: () => db.prepare(sql).bind(...args).run(),
        }),
      }),
    },
    ASSETS: { fetch: () => new Response('') },
  };
}

// ============================================================
// Tests
// ============================================================

describe('Availability Schedule API', () => {
  describe('PUT /api/availability-schedules/:id - validation', () => {
    it('should validate rules format - day must be 0-6', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          rules: [{ day: 7, start: '09:00', end: '17:00' }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('day between 0-6');
    });

    it('should validate rules format - start must be HH:MM', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          rules: [{ day: 1, start: '9am', end: '17:00' }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('HH:MM');
    });

    it('should validate rules format - start must be before end', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          rules: [{ day: 1, start: '17:00', end: '09:00' }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('start must be before end');
    });

    it('should validate override format - date must be YYYY-MM-DD', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          overrides: [{ date: 'March 15', available: false }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('YYYY-MM-DD');
    });

    it('should validate override must have available:false or start+end', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          overrides: [{ date: '2026-03-15' }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('available:false or start+end');
    });

    it('should reject empty name', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({ name: '' }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Name is required');
    });

    it('should reject non-array rules', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({ rules: 'not-an-array' }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Rules must be an array');
    });

    it('should return 400 for no fields to update', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({}),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('No fields to update');
    });

    it('should return 404 for non-existent schedule', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/999', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({ name: 'New Name' }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(404);
    });

    it('should accept valid blocked-day override', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          overrides: [{ date: '2026-03-15', available: false }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
    });

    it('should accept valid custom-hours override', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'session=test-token',
        },
        body: JSON.stringify({
          overrides: [{ date: '2026-03-15', start: '10:00', end: '14:00' }]
        }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
    });
  });

  describe('DELETE /api/availability-schedules/:id', () => {
    it('should not allow deleting the default schedule', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 1, user_id: 1, name: 'Work Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 1,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'DELETE',
        headers: { 'Cookie': 'session=test-token' },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Cannot delete the default schedule');
    });

    it('should return 404 for non-existent schedule', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/999', {
        method: 'DELETE',
        headers: { 'Cookie': 'session=test-token' },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(404);
    });

    it('should allow deleting a non-default schedule', async () => {
      const worker = await import('../../../src/worker.js');

      const db = createMockDB();
      db.storage.availability_schedules.push({
        id: 2, user_id: 1, name: 'Evening Hours', timezone: 'America/Los_Angeles',
        rules: '[]', overrides: '[]', is_default: 0,
      });

      const env = createAuthenticatedEnv(db);
      const request = new Request('https://calendo.dev/api/availability-schedules/2', {
        method: 'DELETE',
        headers: { 'Cookie': 'session=test-token' },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });
  });

  describe('PUT /api/availability-schedules/:id - authentication', () => {
    it('should return 401 without auth', async () => {
      const worker = await import('../../../src/worker.js');

      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: { fetch: () => new Response('') },
      };

      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/availability-schedules/:id - authentication', () => {
    it('should return 401 without auth', async () => {
      const worker = await import('../../../src/worker.js');

      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: { fetch: () => new Response('') },
      };

      const request = new Request('https://calendo.dev/api/availability-schedules/1', {
        method: 'DELETE',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });
  });
});
