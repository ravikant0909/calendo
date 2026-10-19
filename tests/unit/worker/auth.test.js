import { describe, it, expect, beforeEach } from 'vitest';

// Helper to create a mock D1 database
function createMockDB() {
  const tables = { users: [], sessions: [], booking_pages: [], availability_schedules: [] };
  let autoIncrement = { users: 1, booking_pages: 1, availability_schedules: 1 };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              if (sql.includes('SELECT id, email, password_hash')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find(p => p.slug === args[0]) || null;
              }
              if (sql.includes('SELECT id FROM availability_schedules')) {
                return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
              }
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = { id, email: args[0], password_hash: args[1], name: args[2], timezone: args[3], avatar_url: null, created_at: new Date().toISOString() };
                tables.users.push(user);
                return { id: user.id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
              }
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: args[4] });
              }
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
              }
              if (sql.includes('DELETE FROM sessions')) {
                tables.sessions = tables.sessions.filter(s => s.token !== args[0]);
              }
              return { success: true };
            }
          };
        }
      };
    },
    _tables: tables
  };
}

function createEnv(db) {
  return {
    DB: db || createMockDB(),
    ASSETS: { fetch: () => new Response('') }
  };
}

describe('Auth System', () => {
  let worker;

  beforeEach(async () => {
    // Fresh import each time
    worker = await import('../../../src/worker.js');
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user with valid data', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.user.email).toBe('test@example.com');
      expect(body.user.name).toBe('Test User');
      expect(body.user.password_hash).toBeUndefined();
      expect(body.bookingSlug).toBeTruthy();

      // Should set session cookie
      const setCookie = response.headers.get('Set-Cookie');
      expect(setCookie).toContain('session=');
      expect(setCookie).toContain('HttpOnly');
    });

    it('should reject registration with missing fields', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });

    it('should reject invalid email format', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'notanemail', password: 'password123', name: 'Test' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('email');
    });

    it('should reject short passwords', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'short', name: 'Test' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('8 characters');
    });

    it('should reject duplicate emails', async () => {
      const env = createEnv();

      // Register first user
      const req1 = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
      });
      await worker.default.fetch(req1, env, {});

      // Try duplicate
      const req2 = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password456', name: 'Another User' })
      });
      const response = await worker.default.fetch(req2, env, {});
      expect(response.status).toBe(409);
    });

    it('should reject invalid JSON', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json'
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should reject login with missing fields', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });

    it('should reject login for non-existent user', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'password123' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should clear the session cookie', async () => {
      const env = createEnv();

      // Register to get a session
      const regRequest = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
      });
      const regResponse = await worker.default.fetch(regRequest, env, {});
      const cookie = regResponse.headers.get('Set-Cookie');
      const sessionToken = cookie.match(/session=([^;]+)/)[1];

      // Logout
      const logoutRequest = new Request('https://calendo.dev/api/auth/logout', {
        method: 'POST',
        headers: { 'Cookie': `session=${sessionToken}` }
      });
      const logoutResponse = await worker.default.fetch(logoutRequest, env, {});
      expect(logoutResponse.status).toBe(200);

      const setCookie = logoutResponse.headers.get('Set-Cookie');
      expect(setCookie).toContain('Max-Age=0');
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return 401 without auth', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/me', { method: 'GET' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });

    it('should return user data with valid session', async () => {
      const env = createEnv();

      // Register
      const regRequest = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
      });
      const regResponse = await worker.default.fetch(regRequest, env, {});
      const cookie = regResponse.headers.get('Set-Cookie');
      const sessionToken = cookie.match(/session=([^;]+)/)[1];

      // Get me
      const meRequest = new Request('https://calendo.dev/api/auth/me', {
        method: 'GET',
        headers: { 'Cookie': `session=${sessionToken}` }
      });
      const meResponse = await worker.default.fetch(meRequest, env, {});
      expect(meResponse.status).toBe(200);

      const body = await meResponse.json();
      expect(body.email).toBe('test@example.com');
    });
  });
});
