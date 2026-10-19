import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Routing Forms API', () => {
  let worker;
  let mockUser;
  let mockDb;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
    mockUser = { id: 1, name: 'Test User', email: 'test@example.com', timezone: 'UTC' };
    mockDb = createMockDb();
  });

  function createMockDb() {
    const data = {};
    return {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: () => {
            if (sql.includes('sessions') || sql.includes('users')) return mockUser;
            if (sql.includes('FROM routing_forms WHERE id')) return data.routingForm || null;
            if (sql.includes('SELECT id FROM routing_forms WHERE user_id') && sql.includes('slug')) return null;
            if (sql.includes('booking_pages WHERE slug')) return { user_id: 1 };
            if (sql.includes('SELECT * FROM routing_forms WHERE user_id') && sql.includes('is_active')) {
              return data.routingForm || null;
            }
            if (sql.includes('INSERT INTO routing_forms')) {
              return { id: 1, user_id: 1, name: args[1] || 'Test', slug: args[2] || 'test', fields: args[3], rules: args[4], is_active: 1 };
            }
            if (sql.includes('UPDATE routing_forms')) {
              return { id: 1, ...data.routingForm };
            }
            if (sql.includes('event_types WHERE id') && sql.includes('is_active')) {
              return data.matchedEventType || null;
            }
            return null;
          },
          all: () => {
            if (sql.includes('SELECT * FROM routing_forms WHERE user_id')) {
              return { results: data.routingForms || [] };
            }
            if (sql.includes('event_types WHERE user_id')) {
              return { results: data.eventTypes || [] };
            }
            return { results: [] };
          },
          run: () => ({ success: true }),
        }),
      }),
      _data: data,
    };
  }

  function createRequest(path, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Cookie': 'session=valid-token',
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    return new Request(`https://calendo.dev${path}`, options);
  }

  function createPublicRequest(path, method = 'GET', body = null) {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) {
      options.body = JSON.stringify(body);
    }
    return new Request(`https://calendo.dev${path}`, options);
  }

  function createEnv(db = null) {
    return {
      DB: db || mockDb,
      ASSETS: { fetch: () => new Response('') },
    };
  }

  describe('Authenticated routes', () => {
    it('should create a routing form', async () => {
      const request = createRequest('/api/routing-forms', 'POST', {
        name: 'Consultation Router',
        fields: [
          { id: 'purpose', label: 'Purpose', type: 'select', options: ['Sales', 'Support'], required: true },
        ],
        rules: [
          {
            conditions: [{ field_id: 'purpose', operator: 'eq', value: 'Sales' }],
            target_event_type_id: 1,
          },
        ],
      });

      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.name).toBe('Consultation Router');
    });

    it('should list routing forms', async () => {
      mockDb._data.routingForms = [
        { id: 1, name: 'Form 1', slug: 'form-1', fields: '[]', rules: '[]', is_active: 1 },
      ];

      const request = createRequest('/api/routing-forms');
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should get a routing form by id', async () => {
      mockDb._data.routingForm = { id: 1, name: 'Form 1', slug: 'form-1', fields: '[]', rules: '[]', is_active: 1, user_id: 1 };

      const request = createRequest('/api/routing-forms/1');
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(200);
    });

    it('should return 404 for non-existent form', async () => {
      mockDb._data.routingForm = null;

      const request = createRequest('/api/routing-forms/999');
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(404);
    });

    it('should delete a routing form', async () => {
      mockDb._data.routingForm = { id: 1 };

      const request = createRequest('/api/routing-forms/1', 'DELETE');
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it('should reject routing form creation with empty name', async () => {
      const request = createRequest('/api/routing-forms', 'POST', {
        name: '',
        fields: [],
        rules: [],
      });

      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(400);
    });

    it('should reject fields with invalid type', async () => {
      const request = createRequest('/api/routing-forms', 'POST', {
        name: 'Test',
        fields: [{ id: 'f1', label: 'Test', type: 'invalid' }],
        rules: [],
      });

      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Field type must be');
    });

    it('should reject select fields without options', async () => {
      const request = createRequest('/api/routing-forms', 'POST', {
        name: 'Test',
        fields: [{ id: 'f1', label: 'Test', type: 'select', options: [] }],
        rules: [],
      });

      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(400);
    });

    it('should reject rules without conditions', async () => {
      const request = createRequest('/api/routing-forms', 'POST', {
        name: 'Test',
        fields: [],
        rules: [{ conditions: [], target_event_type_id: 1 }],
      });

      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(400);
    });

    it('should reject rules without target_event_type_id', async () => {
      const request = createRequest('/api/routing-forms', 'POST', {
        name: 'Test',
        fields: [],
        rules: [{ conditions: [{ field_id: 'f1', operator: 'eq', value: 'test' }] }],
      });

      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(400);
    });
  });

  describe('Public routing form routes', () => {
    it('should get public routing form', async () => {
      mockDb._data.routingForm = {
        id: 1,
        name: 'Router',
        slug: 'router',
        fields: JSON.stringify([{ id: 'q1', label: 'Question', type: 'text', required: true }]),
        is_active: 1,
      };
      mockDb._data.eventTypes = [
        { id: 1, name: 'Meeting', slug: 'meeting', description: 'A meeting', duration_minutes: 30 },
      ];

      const request = createPublicRequest('/api/public/routing/test-user/router');
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.form.name).toBe('Router');
      expect(data.event_types).toBeDefined();
    });

    it('should return 404 for non-existent form', async () => {
      mockDb._data.routingForm = null;

      const request = createPublicRequest('/api/public/routing/test-user/nonexistent');
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(404);
    });

    it('should submit routing form and get redirect', async () => {
      mockDb._data.routingForm = {
        id: 1,
        name: 'Router',
        slug: 'router',
        fields: JSON.stringify([{ id: 'purpose', label: 'Purpose', type: 'select', options: ['Sales', 'Support'] }]),
        rules: JSON.stringify([
          {
            conditions: [{ field_id: 'purpose', operator: 'eq', value: 'Sales' }],
            target_event_type_id: 1,
          },
        ]),
        is_active: 1,
      };
      mockDb._data.matchedEventType = { id: 1, name: 'Sales Call', slug: 'sales-call' };

      const request = createPublicRequest('/api/public/routing/test-user/router', 'POST', {
        answers: { purpose: 'Sales' },
      });
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(200);
      const data = await response.json();
      // Pretty top-level link: /<user-slug>/<event-slug>
      expect(data.redirect_url).toContain('/sales-call');
      expect(data.redirect_url).not.toContain('/booking/?user=');
      expect(data.matched_event_type.name).toBe('Sales Call');
    });

    it('should return 404 when no rules match', async () => {
      mockDb._data.routingForm = {
        id: 1,
        name: 'Router',
        slug: 'router',
        fields: '[]',
        rules: JSON.stringify([
          {
            conditions: [{ field_id: 'purpose', operator: 'eq', value: 'Sales' }],
            target_event_type_id: 1,
          },
        ]),
        is_active: 1,
      };

      const request = createPublicRequest('/api/public/routing/test-user/router', 'POST', {
        answers: { purpose: 'Something Else' },
      });
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(404);
    });

    it('should handle contains operator', async () => {
      mockDb._data.routingForm = {
        id: 1,
        name: 'Router',
        slug: 'router',
        fields: '[]',
        rules: JSON.stringify([
          {
            conditions: [{ field_id: 'topic', operator: 'contains', value: 'bug' }],
            target_event_type_id: 2,
          },
        ]),
        is_active: 1,
      };
      mockDb._data.matchedEventType = { id: 2, name: 'Bug Report', slug: 'bug-report' };

      const request = createPublicRequest('/api/public/routing/test-user/router', 'POST', {
        answers: { topic: 'I found a bug in the system' },
      });
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.matched_event_type.slug).toBe('bug-report');
    });

    it('should reject submission without answers', async () => {
      const request = createPublicRequest('/api/public/routing/test-user/router', 'POST', {});
      const response = await worker.default.fetch(request, createEnv(), {});
      expect(response.status).toBe(400);
    });
  });
});

describe('Custom Domain Support', () => {
  it('should rewrite custom domain requests to booking page', async () => {
    const worker = await import('../../../src/worker.js');

    const request = new Request('https://cal.example.com/some-page', { method: 'GET' });

    let assetsFetchCalled = false;
    let rewrittenUrl = null;
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => ({ slug: 'ravi' }),
          }),
        }),
      },
      ASSETS: {
        fetch: (req) => {
          assetsFetchCalled = true;
          rewrittenUrl = new URL(req.url);
          return new Response('booking page');
        },
      },
    };

    const response = await worker.default.fetch(request, env, {});
    expect(assetsFetchCalled).toBe(true);
    expect(rewrittenUrl.pathname).toBe('/booking/');
    expect(rewrittenUrl.searchParams.get('user')).toBe('ravi');
  });

  it('should not rewrite for workers.dev domain', async () => {
    const worker = await import('../../../src/worker.js');

    const request = new Request('https://calendo.workers.dev/booking/', { method: 'GET' });

    let assetsFetchPath = null;
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
          }),
        }),
      },
      ASSETS: {
        fetch: (req) => {
          assetsFetchPath = new URL(req.url).pathname;
          return new Response('');
        },
      },
    };

    await worker.default.fetch(request, env, {});
    expect(assetsFetchPath).toBe('/booking/');
  });

  it('should not rewrite API routes even on custom domain', async () => {
    const worker = await import('../../../src/worker.js');

    const request = new Request('https://cal.example.com/api/auth/me', { method: 'GET' });

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

    const response = await worker.default.fetch(request, env, {});
    // Should go through normal API routing (401 since no auth)
    expect(response.status).toBe(401);
  });
});

describe('SMS Module', () => {
  it('should export sendSMS function', async () => {
    const sms = await import('../../../src/sms.js');
    expect(typeof sms.sendSMS).toBe('function');
  });

  it('should return failure when Twilio is not configured', async () => {
    const sms = await import('../../../src/sms.js');

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: () => ({ success: true }),
          }),
        }),
      },
    };

    const result = await sms.sendSMS(env, { to: '+1234567890', body: 'Test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  it('should skip outbound SMS delivery when notifications are disabled for local smoke and E2E runs', async () => {
    const sms = await import('../../../src/sms.js');

    globalThis.fetch = vi.fn(async () => new Response('', { status: 201 }));

    const env = {
      DISABLE_OUTBOUND_NOTIFICATIONS: '1',
      DB: {
        prepare: () => ({
          bind: () => ({
            run: () => ({ success: true }),
          }),
        }),
      },
    };

    const result = await sms.sendSMS(env, { to: '+1234567890', body: 'Test' });
    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should log SMS attempt in notification_log', async () => {
    const sms = await import('../../../src/sms.js');

    let loggedArgs = null;
    // Must provide Twilio credentials so it doesn't return early
    const env = {
      TWILIO_ACCOUNT_SID: 'ACtest123',
      TWILIO_AUTH_TOKEN: 'testtoken',
      TWILIO_PHONE_NUMBER: '+15551234567',
      DB: {
        prepare: (sql) => ({
          bind: (...args) => ({
            run: () => {
              if (sql.includes('notification_log')) loggedArgs = args;
              return { success: true };
            },
          }),
        }),
      },
    };

    // fetch will fail since we're not mocking it, but the error is caught
    // and the notification is still logged
    await sms.sendSMS(env, { to: '+1234567890', body: 'Test message', bookingId: 1, type: 'confirmation' });
    expect(loggedArgs).not.toBeNull();
    expect(loggedArgs[0]).toBe(1); // bookingId
    expect(loggedArgs[1]).toBe('confirmation'); // type
  });
});
