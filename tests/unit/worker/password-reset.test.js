import { describe, it, expect, beforeEach } from 'vitest';

// Helper to create a mock D1 database that handles password reset tokens
function createMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    password_reset_tokens: [],
    event_types: [],
    notification_log: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    password_reset_tokens: 1,
    event_types: 1,
    notification_log: 1,
  };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // User lookups
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              if (sql.includes('SELECT id, email FROM users WHERE email')) {
                const u = tables.users.find(u => u.email === args[0]);
                return u ? { id: u.id, email: u.email } : null;
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
              // Register user
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = {
                  id, email: args[0], password_hash: args[1], name: args[2],
                  timezone: args[3], avatar_url: null, created_at: new Date().toISOString()
                };
                tables.users.push(user);
                return { id: user.id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
              }
              // Session auth lookup
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              // Password reset token lookup
              if (sql.includes('SELECT id, user_id, token, expires_at, used FROM password_reset_tokens WHERE token')) {
                return tables.password_reset_tokens.find(t => t.token === args[0]) || null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              // Booking pages
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              // Availability schedules
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: args[4] });
              }
              // Sessions
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
              }
              if (sql.includes('DELETE FROM sessions WHERE token')) {
                tables.sessions = tables.sessions.filter(s => s.token !== args[0]);
              }
              if (sql.includes('DELETE FROM sessions WHERE user_id')) {
                tables.sessions = tables.sessions.filter(s => s.user_id !== args[0]);
              }
              // Password reset tokens
              if (sql.includes('UPDATE password_reset_tokens SET used = 1 WHERE user_id') && sql.includes('used = 0')) {
                tables.password_reset_tokens.forEach(t => {
                  if (t.user_id === args[0] && !t.used) t.used = 1;
                });
              }
              if (sql.includes('INSERT INTO password_reset_tokens')) {
                tables.password_reset_tokens.push({
                  id: autoIncrement.password_reset_tokens++,
                  user_id: args[0], token: args[1], expires_at: args[2],
                  used: 0, created_at: new Date().toISOString()
                });
              }
              if (sql.includes('UPDATE password_reset_tokens SET used = 1 WHERE id')) {
                const tok = tables.password_reset_tokens.find(t => t.id === args[0]);
                if (tok) tok.used = 1;
              }
              // Update user password
              if (sql.includes('UPDATE users SET password_hash')) {
                const user = tables.users.find(u => u.id === args[2]);
                if (user) {
                  user.password_hash = args[0];
                  user.updated_at = args[1];
                }
              }
              // Notification log
              if (sql.includes('INSERT INTO notification_log')) {
                tables.notification_log.push({ id: autoIncrement.notification_log++ });
              }
              // CREATE TABLE (auto-migration) - no-op in mock
              if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
                // no-op
              }
              return { success: true };
            }
          };
        },
        // For unbound queries (like CREATE TABLE without bind)
        async run() {
          return { success: true };
        }
      };
    },
    _tables: tables
  };
}

function createEnv(db) {
  return {
    DB: db || createMockDB(),
    ASSETS: { fetch: () => new Response('') },
    RESEND_API_KEY: 'test-resend-key',
    DISABLE_OUTBOUND_NOTIFICATIONS: '1', // Don't actually send emails in tests
  };
}

// Register a user and return the env/db for further use
async function registerUser(worker, env, email = 'user@example.com') {
  const request = new Request('https://calendo.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name: 'Test User' })
  });
  const response = await worker.default.fetch(request, env, {});
  return response;
}

describe('Password Reset Flow', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  describe('POST /api/auth/forgot-password', () => {
    it('should return 200 with valid email that exists', async () => {
      const env = createEnv();
      // Register a user first
      await registerUser(worker, env, 'user@example.com');

      const request = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.message).toContain('reset link');

      // A token should have been created
      const tokens = env.DB._tables.password_reset_tokens;
      expect(tokens.length).toBe(1);
      expect(tokens[0].user_id).toBe(1);
      expect(tokens[0].used).toBe(0);
    });

    it('should return 200 with non-existent email (prevents enumeration)', async () => {
      const env = createEnv();

      const request = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' })
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.message).toContain('reset link');

      // No token should have been created
      const tokens = env.DB._tables.password_reset_tokens;
      expect(tokens.length).toBe(0);
    });

    it('should return 400 if email is missing', async () => {
      const env = createEnv();

      const request = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Email');
    });

    it('should return 400 for invalid JSON', async () => {
      const env = createEnv();

      const request = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json'
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });

    it('should invalidate previous tokens when requesting a new one', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Request first reset
      const req1 = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(req1, env, {});

      // Request second reset
      const req2 = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(req2, env, {});

      // First token should be marked as used, second should be active
      const tokens = env.DB._tables.password_reset_tokens;
      expect(tokens.length).toBe(2);
      expect(tokens[0].used).toBe(1); // invalidated
      expect(tokens[1].used).toBe(0); // new active token
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('should reset password with valid token', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Request password reset
      const forgotReq = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(forgotReq, env, {});

      // Get the token
      const token = env.DB._tables.password_reset_tokens[0].token;

      // Reset password
      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'newpassword123' })
      });
      const response = await worker.default.fetch(resetReq, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.message).toContain('reset successfully');

      // Token should be marked as used
      expect(env.DB._tables.password_reset_tokens[0].used).toBe(1);

      // User password should be updated
      const user = env.DB._tables.users[0];
      expect(user.password_hash).not.toBe('password123');
      expect(user.password_hash).toContain('pbkdf2');

      // All sessions should be invalidated
      expect(env.DB._tables.sessions.length).toBe(0);
    });

    it('should reject reset with expired token', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Manually create an expired token
      env.DB._tables.password_reset_tokens.push({
        id: 99,
        user_id: 1,
        token: 'expired-token-123',
        expires_at: '2020-01-01T00:00:00Z', // far in the past
        used: 0,
        created_at: new Date().toISOString()
      });

      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'expired-token-123', password: 'newpassword123' })
      });
      const response = await worker.default.fetch(resetReq, env, {});
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('expired');
    });

    it('should reject reset with already used token', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Manually create a used token
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      env.DB._tables.password_reset_tokens.push({
        id: 99,
        user_id: 1,
        token: 'used-token-123',
        expires_at: futureDate,
        used: 1, // already used
        created_at: new Date().toISOString()
      });

      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'used-token-123', password: 'newpassword123' })
      });
      const response = await worker.default.fetch(resetReq, env, {});
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('already been used');
    });

    it('should reject reset with invalid/non-existent token', async () => {
      const env = createEnv();

      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'non-existent-token', password: 'newpassword123' })
      });
      const response = await worker.default.fetch(resetReq, env, {});
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Invalid');
    });

    it('should reject reset with short password', async () => {
      const env = createEnv();

      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'some-token', password: 'short' })
      });
      const response = await worker.default.fetch(resetReq, env, {});
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('8 characters');
    });

    it('should reject reset with missing fields', async () => {
      const env = createEnv();

      // Missing password
      const req1 = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'some-token' })
      });
      const res1 = await worker.default.fetch(req1, env, {});
      expect(res1.status).toBe(400);

      // Missing token
      const req2 = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'newpassword123' })
      });
      const res2 = await worker.default.fetch(req2, env, {});
      expect(res2.status).toBe(400);
    });

    it('should return 400 for invalid JSON', async () => {
      const env = createEnv();

      const request = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json'
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });

    it('should invalidate all sessions after password reset', async () => {
      const env = createEnv();
      // Register creates a session
      await registerUser(worker, env, 'user@example.com');
      expect(env.DB._tables.sessions.length).toBe(1);

      // Request and use password reset
      const forgotReq = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(forgotReq, env, {});

      const token = env.DB._tables.password_reset_tokens[0].token;
      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'newpassword123' })
      });
      await worker.default.fetch(resetReq, env, {});

      // All sessions for this user should be gone
      const userSessions = env.DB._tables.sessions.filter(s => s.user_id === 1);
      expect(userSessions.length).toBe(0);
    });

    it('should allow login with new password after reset', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Request reset
      const forgotReq = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(forgotReq, env, {});

      // Reset password
      const token = env.DB._tables.password_reset_tokens[0].token;
      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'brandnewpass99' })
      });
      await worker.default.fetch(resetReq, env, {});

      // Login with new password should work
      const loginReq = new Request('https://calendo.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', password: 'brandnewpass99' })
      });
      const loginRes = await worker.default.fetch(loginReq, env, {});
      expect(loginRes.status).toBe(200);

      const loginBody = await loginRes.json();
      expect(loginBody.user.email).toBe('user@example.com');
    });

    it('should not allow login with old password after reset', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Request + perform reset
      const forgotReq = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(forgotReq, env, {});

      const token = env.DB._tables.password_reset_tokens[0].token;
      const resetReq = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'brandnewpass99' })
      });
      await worker.default.fetch(resetReq, env, {});

      // Login with old password should fail
      const loginReq = new Request('https://calendo.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com', password: 'password123' })
      });
      const loginRes = await worker.default.fetch(loginReq, env, {});
      expect(loginRes.status).toBe(401);
    });
  });

  describe('Token cleanup', () => {
    it('should not allow reuse of a token after successful reset', async () => {
      const env = createEnv();
      await registerUser(worker, env, 'user@example.com');

      // Request reset
      const forgotReq = new Request('https://calendo.dev/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });
      await worker.default.fetch(forgotReq, env, {});

      const token = env.DB._tables.password_reset_tokens[0].token;

      // First reset should succeed
      const resetReq1 = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'newpassword11' })
      });
      const res1 = await worker.default.fetch(resetReq1, env, {});
      expect(res1.status).toBe(200);

      // Second reset with same token should fail
      const resetReq2 = new Request('https://calendo.dev/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'anotherpass22' })
      });
      const res2 = await worker.default.fetch(resetReq2, env, {});
      expect(res2.status).toBe(400);

      const body = await res2.json();
      expect(body.error).toContain('already been used');
    });
  });
});
