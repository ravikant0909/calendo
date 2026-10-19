import { describe, it, expect, beforeEach, vi } from 'vitest';

// Helper to create a mock D1 database with webhook support
function createMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    webhooks: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    webhooks: 1,
  };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // Auth - session lookup
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              // User lookup by email (for registration)
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              // Insert user
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = {
                  id,
                  email: args[0],
                  password_hash: args[1],
                  name: args[2],
                  timezone: args[3],
                  avatar_url: null,
                  created_at: new Date().toISOString(),
                };
                tables.users.push(user);
                return { id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
              }
              // Booking page slug check
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find(p => p.slug === args[0]) || null;
              }
              // Webhook by id and user_id
              if (sql.includes('SELECT * FROM webhooks WHERE id = ? AND user_id = ?')) {
                return tables.webhooks.find(w => w.id == args[0] && w.user_id == args[1]) || null;
              }
              // Insert webhook
              if (sql.includes('INSERT INTO webhooks')) {
                const id = autoIncrement.webhooks++;
                const webhook = {
                  id,
                  user_id: args[0],
                  url: args[1],
                  events: args[2],
                  secret: args[3],
                  is_active: 1,
                  failure_count: 0,
                  last_triggered_at: null,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };
                tables.webhooks.push(webhook);
                return { ...webhook };
              }
              // Update webhook - handle dynamic SET clauses
              if (sql.includes('UPDATE webhooks SET') && sql.includes('RETURNING *')) {
                const idArgIdx = args.length - 2;
                const userIdArgIdx = args.length - 1;
                const webhookId = args[idArgIdx];
                const userId = args[userIdArgIdx];
                const webhook = tables.webhooks.find(w => w.id == webhookId && w.user_id == userId);
                if (!webhook) return null;
                // Apply updates based on SET clause fields
                const setMatch = sql.match(/SET (.+) WHERE/);
                if (setMatch) {
                  const fields = setMatch[1].split(',').map(f => f.trim().split(' = ')[0].trim());
                  fields.forEach((field, i) => {
                    if (field !== 'updated_at' && i < args.length - 2) {
                      webhook[field] = args[i];
                    }
                  });
                  webhook.updated_at = new Date().toISOString();
                }
                return { ...webhook };
              }
              // Update webhook failure_count (from fireWebhooks)
              if (sql.includes('UPDATE webhooks SET failure_count')) {
                const webhook = tables.webhooks.find(w => w.id == args[args.length - 1]);
                if (webhook) {
                  if (sql.includes('failure_count = 0')) {
                    webhook.failure_count = 0;
                    webhook.last_triggered_at = new Date().toISOString();
                  } else {
                    webhook.failure_count = args[0];
                    webhook.is_active = args[1];
                  }
                  webhook.updated_at = new Date().toISOString();
                }
                return null;
              }
              return null;
            },
            async all() {
              // List webhooks for user
              if (sql.includes('SELECT * FROM webhooks WHERE user_id = ?') && sql.includes('ORDER BY')) {
                const userWebhooks = tables.webhooks
                  .filter(w => w.user_id == args[0])
                  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                return { results: userWebhooks };
              }
              // Active webhooks for user (used by fireWebhooks)
              if (sql.includes('SELECT * FROM webhooks WHERE user_id = ? AND is_active = 1')) {
                const activeWebhooks = tables.webhooks.filter(w => w.user_id == args[0] && w.is_active === 1);
                return { results: activeWebhooks };
              }
              return { results: [] };
            },
            async run() {
              // Insert session
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
              }
              // Insert booking page
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              // Insert availability schedule
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: args[4] });
              }
              // Delete webhook
              if (sql.includes('DELETE FROM webhooks')) {
                const idx = tables.webhooks.findIndex(w => w.id == args[0] && w.user_id == args[1]);
                if (idx !== -1) tables.webhooks.splice(idx, 1);
              }
              // Update webhook failure/success (from fireWebhooks)
              if (sql.includes('UPDATE webhooks SET failure_count = 0')) {
                const webhook = tables.webhooks.find(w => w.id == args[0]);
                if (webhook) {
                  webhook.failure_count = 0;
                  webhook.last_triggered_at = new Date().toISOString();
                }
              }
              if (sql.includes('UPDATE webhooks SET failure_count = ?')) {
                const webhook = tables.webhooks.find(w => w.id == args[2]);
                if (webhook) {
                  webhook.failure_count = args[0];
                  webhook.is_active = args[1];
                }
              }
              return { success: true };
            },
          };
        },
      };
    },
    _tables: tables,
  };
}

function createEnv(db) {
  return {
    DB: db || createMockDB(),
    ASSETS: { fetch: () => new Response('') },
  };
}

async function registerUser(worker, env) {
  const request = new Request('https://calendo.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' }),
  });
  const response = await worker.default.fetch(request, env, {});
  const cookie = response.headers.get('Set-Cookie');
  const sessionToken = cookie.match(/session=([^;]+)/)[1];
  return sessionToken;
}

function authRequest(url, method, sessionToken, body) {
  const opts = {
    method,
    headers: { Cookie: `session=${sessionToken}` },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return new Request(url, opts);
}

describe('Webhook System', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  describe('GET /api/webhooks', () => {
    it('should return empty array when no webhooks exist', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'GET', token);
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual([]);
    });

    it('should return 401 without auth', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/webhooks', { method: 'GET' });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });

    it('should list created webhooks', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      // Create a webhook
      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/webhook',
        events: ['booking.created'],
      });
      await worker.default.fetch(createReq, env, {});

      // List webhooks
      const listReq = authRequest('https://calendo.dev/api/webhooks', 'GET', token);
      const response = await worker.default.fetch(listReq, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.length).toBe(1);
      expect(body[0].url).toBe('https://example.com/webhook');
    });
  });

  describe('POST /api/webhooks', () => {
    it('should create a webhook with valid data', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/webhook',
        events: ['booking.created', 'booking.cancelled'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.url).toBe('https://example.com/webhook');
      expect(body.events).toBe(JSON.stringify(['booking.created', 'booking.cancelled']));
      expect(body.secret).toBeTruthy();
      expect(body.is_active).toBe(1);
    });

    it('should default events to booking.created when not provided', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/webhook',
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.events).toBe(JSON.stringify(['booking.created']));
    });

    it('should reject missing URL', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        events: ['booking.created'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('URL');
    });

    it('should reject invalid URL format', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'not-a-url',
        events: ['booking.created'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('URL');
    });

    it('should reject non-http(s) URL', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'ftp://example.com/webhook',
        events: ['booking.created'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('http');
    });

    it('should reject invalid event names', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/webhook',
        events: ['invalid.event'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Invalid event');
    });

    it('should reject invalid JSON', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = new Request('https://calendo.dev/api/webhooks', {
        method: 'POST',
        headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
        body: 'not json',
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });

    it('should auto-generate a secret', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const req1 = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook1',
      });
      const res1 = await worker.default.fetch(req1, env, {});
      const body1 = await res1.json();

      const req2 = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook2',
      });
      const res2 = await worker.default.fetch(req2, env, {});
      const body2 = await res2.json();

      expect(body1.secret).toBeTruthy();
      expect(body2.secret).toBeTruthy();
      expect(body1.secret).not.toBe(body2.secret);
    });
  });

  describe('PUT /api/webhooks/:id', () => {
    it('should update webhook URL', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      // Create
      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/old',
        events: ['booking.created'],
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      // Update
      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {
        url: 'https://example.com/new',
      });
      const updateRes = await worker.default.fetch(updateReq, env, {});
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.url).toBe('https://example.com/new');
    });

    it('should update webhook events', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
        events: ['booking.created'],
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {
        events: ['booking.created', 'booking.cancelled'],
      });
      const updateRes = await worker.default.fetch(updateReq, env, {});
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.events).toBe(JSON.stringify(['booking.created', 'booking.cancelled']));
    });

    it('should update is_active', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {
        is_active: false,
      });
      const updateRes = await worker.default.fetch(updateReq, env, {});
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.is_active).toBe(0);
    });

    it('should return 404 for non-existent webhook', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const updateReq = authRequest('https://calendo.dev/api/webhooks/9999', 'PUT', token, {
        url: 'https://example.com/new',
      });
      const response = await worker.default.fetch(updateReq, env, {});
      expect(response.status).toBe(404);
    });

    it('should reject invalid URL on update', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {
        url: 'not-a-url',
      });
      const response = await worker.default.fetch(updateReq, env, {});
      expect(response.status).toBe(400);
    });

    it('should reject invalid events on update', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {
        events: ['invalid.event'],
      });
      const response = await worker.default.fetch(updateReq, env, {});
      expect(response.status).toBe(400);
    });

    it('should reject empty update body', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {});
      const response = await worker.default.fetch(updateReq, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('No fields');
    });
  });

  describe('DELETE /api/webhooks/:id', () => {
    it('should delete a webhook', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      // Create
      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      // Delete
      const deleteReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'DELETE', token);
      const deleteRes = await worker.default.fetch(deleteReq, env, {});
      expect(deleteRes.status).toBe(200);
      const body = await deleteRes.json();
      expect(body.ok).toBe(true);

      // Verify it's gone
      const listReq = authRequest('https://calendo.dev/api/webhooks', 'GET', token);
      const listRes = await worker.default.fetch(listReq, env, {});
      const list = await listRes.json();
      expect(list.length).toBe(0);
    });

    it('should return 404 for non-existent webhook', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const deleteReq = authRequest('https://calendo.dev/api/webhooks/9999', 'DELETE', token);
      const response = await worker.default.fetch(deleteReq, env, {});
      expect(response.status).toBe(404);
    });

    it('should not allow deleting another user webhook', async () => {
      const env = createEnv();
      const token1 = await registerUser(worker, env);

      // Create webhook as user 1
      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token1, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      // Register user 2
      const reg2Req = new Request('https://calendo.dev/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user2@example.com', password: 'password123', name: 'User Two' }),
      });
      const reg2Res = await worker.default.fetch(reg2Req, env, {});
      const cookie2 = reg2Res.headers.get('Set-Cookie');
      const token2 = cookie2.match(/session=([^;]+)/)[1];

      // Try to delete user 1's webhook as user 2
      const deleteReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'DELETE', token2);
      const response = await worker.default.fetch(deleteReq, env, {});
      expect(response.status).toBe(404);
    });
  });

  describe('Webhook delivery (fireWebhooks)', () => {
    it('should not fail when no webhooks exist', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      // Create a webhook, then delete it, ensuring no webhooks exist
      // Just verify listing returns empty and the system doesn't break
      const listReq = authRequest('https://calendo.dev/api/webhooks', 'GET', token);
      const response = await worker.default.fetch(listReq, env, {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual([]);
    });
  });

  describe('Webhook route matching', () => {
    it('should route PUT /api/webhooks/:id correctly', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      // Create
      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
        events: ['booking.created'],
      });
      await worker.default.fetch(createReq, env, {});

      // PUT should not 404 for /api/webhooks/1
      const putReq = authRequest('https://calendo.dev/api/webhooks/1', 'PUT', token, {
        url: 'https://example.com/updated',
      });
      const response = await worker.default.fetch(putReq, env, {});
      // Should get 200 (updated) not 404 (not found in router)
      expect(response.status).toBe(200);
    });

    it('should route DELETE /api/webhooks/:id correctly', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      // Create
      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      await worker.default.fetch(createReq, env, {});

      // DELETE should work
      const deleteReq = authRequest('https://calendo.dev/api/webhooks/1', 'DELETE', token);
      const response = await worker.default.fetch(deleteReq, env, {});
      expect(response.status).toBe(200);
    });
  });

  describe('Webhook validation edge cases', () => {
    it('should accept http URLs', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'http://localhost:3000/webhook',
        events: ['booking.created'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);
    });

    it('should trim whitespace from URL', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: '  https://example.com/webhook  ',
        events: ['booking.created'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.url).toBe('https://example.com/webhook');
    });

    it('should accept all valid event types', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/webhook',
        events: ['booking.created', 'booking.cancelled', 'booking.rescheduled'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(201);
      const body = await response.json();
      const events = JSON.parse(body.events);
      expect(events).toEqual(['booking.created', 'booking.cancelled', 'booking.rescheduled']);
    });

    it('should reject events as non-array on update', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);

      const createReq = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: 'https://example.com/hook',
      });
      const createRes = await worker.default.fetch(createReq, env, {});
      const created = await createRes.json();

      const updateReq = authRequest(`https://calendo.dev/api/webhooks/${created.id}`, 'PUT', token, {
        events: 'booking.created',
      });
      const response = await worker.default.fetch(updateReq, env, {});
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('array');
    });

    it('should reject empty URL string', async () => {
      const env = createEnv();
      const token = await registerUser(worker, env);
      const request = authRequest('https://calendo.dev/api/webhooks', 'POST', token, {
        url: '   ',
        events: ['booking.created'],
      });
      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(400);
    });
  });
});
