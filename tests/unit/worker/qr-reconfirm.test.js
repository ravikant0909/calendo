import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// QR Code & Reconfirmation Tests
// ============================================================

describe('QR Code & Reconfirmation', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
  });

  // Helper to build a mock DB environment
  function createEnv({ sessionUser, booking, eventType, host, runCalls, notificationLog } = {}) {
    const runs = runCalls || [];
    return {
      DB: {
        prepare(sql) {
          const makeResult = (args) => ({
            first() {
              if (sql.includes('SELECT s.user_id, u.*')) return sessionUser || null;
              if (sql.includes('SELECT u.* FROM api_keys')) return null;
              if (sql.includes('SELECT * FROM bookings WHERE id = ? AND cancel_token = ?'))
                return typeof booking === 'function' ? booking(args) : (booking || null);
              if (sql.includes('FROM bookings') && !sql.includes('JOIN'))
                return typeof booking === 'function' ? booking(args) : (booking || null);
              if (sql.includes('FROM event_types'))
                return typeof eventType === 'function' ? eventType(args) : (eventType || null);
              if (sql.includes('FROM users WHERE id = ?'))
                return typeof host === 'function' ? host(args) : (host || null);
              if (sql.includes('FROM notification_log')) return notificationLog || null;
              return null;
            },
            all() { return { results: [] }; },
            run() { runs.push({ sql, args }); return { success: true }; },
          });
          return {
            bind(...args) { return makeResult(args); },
            // Direct calls without bind (some queries like processEmailSequences call .all() directly)
            first() { return makeResult([]).first(); },
            all() { return makeResult([]).all(); },
            run() { return makeResult([]).run(); },
          };
        },
      },
      ASSETS: { fetch: () => new Response('') },
      RESEND_API_KEY: 'test-key',
      DISABLE_OUTBOUND_NOTIFICATIONS: '1',
    };
  }

  function callWorker(url, method, env, body) {
    const options = { method, headers: {} };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return worker.default.fetch(new Request(url, options), env, {});
  }

  function authedRequest(url, method, env, body) {
    const options = { method, headers: { Cookie: 'session=test-token' } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return worker.default.fetch(new Request(url, options), env, {});
  }

  // ============================================================
  // Reconfirm endpoint tests
  // ============================================================

  describe('GET /api/bookings/:id/reconfirm', () => {
    it('should return 400 when token is missing', async () => {
      const env = createEnv();
      const response = await callWorker(
        'https://calendo.dev/api/bookings/1/reconfirm',
        'GET', env
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('token');
    });

    it('should return 404 for invalid booking or token', async () => {
      const env = createEnv({ booking: null });
      const response = await callWorker(
        'https://calendo.dev/api/bookings/999/reconfirm?token=bad-token',
        'GET', env
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain('not found');
    });

    it('should return 400 for cancelled booking', async () => {
      const env = createEnv({
        booking: {
          id: 1, status: 'cancelled', cancel_token: 'tok-123',
          reconfirmed: null,
        },
      });
      const response = await callWorker(
        'https://calendo.dev/api/bookings/1/reconfirm?token=tok-123',
        'GET', env
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('cancelled');
    });

    it('should mark booking as confirmed', async () => {
      const runs = [];
      const env = createEnv({
        booking: {
          id: 1, status: 'confirmed', cancel_token: 'tok-123',
          reconfirmed: null,
        },
        runCalls: runs,
      });
      const response = await callWorker(
        'https://calendo.dev/api/bookings/1/reconfirm?token=tok-123',
        'GET', env
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain('confirmed');

      // Verify the DB update was called
      const updateRun = runs.find(r => r.sql.includes('UPDATE bookings SET reconfirmed = 1'));
      expect(updateRun).toBeDefined();
    });

    it('should return success if already confirmed', async () => {
      const env = createEnv({
        booking: {
          id: 1, status: 'confirmed', cancel_token: 'tok-123',
          reconfirmed: 1,
        },
      });
      const response = await callWorker(
        'https://calendo.dev/api/bookings/1/reconfirm?token=tok-123',
        'GET', env
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toContain('already confirmed');
    });
  });

  // ============================================================
  // Event type reconfirmation_hours support
  // ============================================================

  describe('Event type reconfirmation_hours', () => {
    it('should accept reconfirmation_hours when creating event type', async () => {
      const runs = [];
      const sessionUser = {
        id: 1, email: 'test@example.com', name: 'Test User',
        timezone: 'UTC', password_hash: 'hash',
      };

      const env = createEnv({ sessionUser, runCalls: runs });

      // Override the first() to return the created event type
      const origPrepare = env.DB.prepare;
      env.DB.prepare = function(sql) {
        const stmt = origPrepare.call(this, sql);
        const origBind = stmt.bind;
        stmt.bind = function(...args) {
          const bound = origBind.call(this, ...args);
          if (sql.includes('INSERT INTO event_types') && sql.includes('reconfirmation_hours')) {
            bound.first = () => ({
              id: 1, name: 'Test Event', slug: 'test-event',
              reconfirmation_hours: 24, duration_minutes: 30,
            });
          }
          if (sql.includes('SELECT id FROM event_types WHERE user_id = ? AND slug')) {
            bound.first = () => null; // no duplicate slug
          }
          if (sql.includes('SELECT id FROM availability_schedules')) {
            bound.first = () => ({ id: 1 });
          }
          return bound;
        };
        return stmt;
      };

      const response = await authedRequest(
        'https://calendo.dev/api/event-types',
        'POST', env,
        { name: 'Test Event', duration_minutes: 30, reconfirmation_hours: 24 }
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.reconfirmation_hours).toBe(24);
    });

    it('should accept reconfirmation_hours when updating event type', async () => {
      const runs = [];
      const sessionUser = {
        id: 1, email: 'test@example.com', name: 'Test User',
        timezone: 'UTC', password_hash: 'hash',
      };

      const env = createEnv({ sessionUser, runCalls: runs });

      const origPrepare = env.DB.prepare;
      env.DB.prepare = function(sql) {
        const stmt = origPrepare.call(this, sql);
        const origBind = stmt.bind;
        stmt.bind = function(...args) {
          const bound = origBind.call(this, ...args);
          if (sql.includes('SELECT * FROM event_types WHERE id = ? AND user_id = ?')) {
            bound.first = () => ({
              id: 1, user_id: 1, name: 'Test Event', slug: 'test-event',
              reconfirmation_hours: null, duration_minutes: 30,
            });
          }
          if (sql.includes('UPDATE event_types SET') && sql.includes('RETURNING')) {
            bound.first = () => ({
              id: 1, name: 'Test Event', slug: 'test-event',
              reconfirmation_hours: 48, duration_minutes: 30,
            });
          }
          return bound;
        };
        return stmt;
      };

      const response = await authedRequest(
        'https://calendo.dev/api/event-types/1',
        'PUT', env,
        { reconfirmation_hours: 48 }
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reconfirmation_hours).toBe(48);
    });
  });

  // ============================================================
  // Reconfirmation email template
  // ============================================================

  describe('Reconfirmation email template', () => {
    it('should generate valid reconfirmation email', async () => {
      const { reconfirmationEmail } = await import('../../../src/email.js');

      const booking = {
        id: 1, invitee_name: 'Alice', invitee_email: 'alice@test.com',
        invitee_timezone: 'America/New_York',
        start_time: '2026-04-15 14:00:00', end_time: '2026-04-15 14:30:00',
      };
      const eventType = { name: '30-Minute Call', duration_minutes: 30 };
      const host = { name: 'Bob', email: 'bob@test.com' };
      const confirmUrl = 'https://calendo.dev/api/bookings/1/reconfirm?token=abc';
      const cancelUrl = 'https://calendo.dev/cancel/uid-123?token=abc';

      const email = reconfirmationEmail(booking, eventType, host, confirmUrl, cancelUrl);

      expect(email.subject).toContain('Please confirm');
      expect(email.subject).toContain('30-Minute Call');
      expect(email.subject).toContain('Bob');
      expect(email.html).toContain('confirm your attendance');
      expect(email.html).toContain('Confirm Attendance');
      expect(email.html).toContain(confirmUrl);
      expect(email.html).toContain(cancelUrl);
      expect(email.html).toContain('Alice');
      expect(email.html).toContain('30-Minute Call');
      expect(email.text).toContain('confirm');
      expect(email.text).toContain(confirmUrl);
      expect(email.text).toContain(cancelUrl);
    });
  });

  // ============================================================
  // Reconfirmation cron logic
  // ============================================================

  describe('Reconfirmation cron', () => {
    it('should not send reconfirmation when reconfirmation_hours is NULL', async () => {
      // When reconfirmation_hours is NULL, the cron query returns no bookings.
      // So sendPendingReconfirmations is essentially a no-op.
      // We verify this by ensuring no "reconfirmation" notification log entries are created.
      const runs = [];
      const env = createEnv({ runCalls: runs });

      // The cron handler calls sendPendingReminders which calls sendPendingReconfirmations
      // Both query the DB. For reconfirmation, if reconfirmation_hours IS NULL,
      // the WHERE clause filters them out, resulting in no bookings to process.

      // Simulate calling the scheduled handler
      await worker.default.scheduled({ cron: '*/5 * * * *' }, env, {});

      // No reconfirmation updates should have been written
      const reconfirmRuns = runs.filter(r =>
        r.sql.includes('reconfirmation_sent_at') || r.sql.includes('reconfirmation')
      );
      expect(reconfirmRuns.length).toBe(0);
    });

    it('should not send reconfirmation for cancelled bookings', async () => {
      const runs = [];
      const env = createEnv({ runCalls: runs });

      // The cron query only looks for status = 'confirmed', so cancelled bookings
      // are filtered out at the SQL level.
      await worker.default.scheduled({ cron: '*/5 * * * *' }, env, {});

      const reconfirmRuns = runs.filter(r =>
        r.sql.includes('reconfirmation_sent_at')
      );
      expect(reconfirmRuns.length).toBe(0);
    });

    it('should send reconfirmation email at the correct time', async () => {
      const runs = [];
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const startTime = in24h.toISOString().replace('T', ' ').slice(0, 19);

      const mockBooking = {
        id: 42,
        uid: 'uid-reconfirm',
        status: 'confirmed',
        invitee_name: 'Charlie',
        invitee_email: 'charlie@test.com',
        invitee_timezone: 'UTC',
        start_time: startTime,
        end_time: startTime,
        cancel_token: 'cancel-tok-42',
        event_type_name: 'Demo Call',
        duration_minutes: 30,
        host_user_id: 1,
        reconfirmation_hours: 24,
        reconfirmation_sent_at: null,
      };

      const mockHost = {
        id: 1, name: 'Host User', email: 'host@test.com', timezone: 'UTC',
      };

      // Build a more sophisticated mock for the cron path
      const env = {
        DB: {
          prepare(sql) {
            const result = {
              first() {
                if (sql.includes('FROM users WHERE id = ?')) return mockHost;
                if (sql.includes('FROM notification_log')) return null;
                return null;
              },
              all() {
                if (sql.includes('reconfirmation_hours IS NOT NULL') && sql.includes('reconfirmation_sent_at IS NULL')) {
                  return { results: [mockBooking] };
                }
                return { results: [] };
              },
              run() {
                runs.push({ sql, args: [] });
                return { success: true };
              },
            };
            return {
              bind(...args) {
                return {
                  first: result.first,
                  all: result.all,
                  run() { runs.push({ sql, args }); return { success: true }; },
                };
              },
              first: result.first,
              all: result.all,
              run: result.run,
            };
          },
        },
        ASSETS: { fetch: () => new Response('') },
        RESEND_API_KEY: 'test-key',
        DISABLE_OUTBOUND_NOTIFICATIONS: '1',
      };

      await worker.default.scheduled({ cron: '*/5 * * * *' }, env, {});

      // Verify reconfirmation_sent_at was updated
      const updateRun = runs.find(r => r.sql.includes('reconfirmation_sent_at'));
      expect(updateRun).toBeDefined();

      // Verify notification was logged
      const notifRun = runs.find(r =>
        r.sql.includes('INSERT INTO notification_log') && r.args?.includes?.('reconfirmation')
      );
      expect(notifRun).toBeDefined();
    });
  });

  // ============================================================
  // QR Code generation (client-side — just verify the module exists)
  // ============================================================

  describe('QR Code', () => {
    it('should have QR code buttons and canvas in dashboard HTML', async () => {
      // This tests that the dashboard HTML contains the QR code elements
      const fs = await import('fs');
      const html = fs.readFileSync(
        new URL('../../../public/dashboard/index.html', import.meta.url),
        'utf-8'
      );

      // QR modal with canvas (not external img)
      expect(html).toContain('id="qrCanvas"');
      expect(html).toContain('id="qrModal"');
      expect(html).toContain('downloadQR()');

      // Should NOT contain the external QR API
      expect(html).not.toContain('api.qrserver.com');

      // QR buttons present
      expect(html).toContain('showQRCode(');
      expect(html).toContain('showEventQR(');

      // Client-side QR generator present
      expect(html).toContain('QR.renderCanvas');
      expect(html).toContain('const QR');
    });

    it('should include QR code button in booking link bar', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync(
        new URL('../../../public/dashboard/index.html', import.meta.url),
        'utf-8'
      );
      expect(html).toContain('id="qrLinkBtn"');
    });

    it('should include QR code button on event type cards', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync(
        new URL('../../../public/dashboard/index.html', import.meta.url),
        'utf-8'
      );
      // The renderEventTypes function includes QR buttons
      expect(html).toContain('showEventQR(');
    });
  });

  // ============================================================
  // Dashboard reconfirmation UI
  // ============================================================

  describe('Dashboard reconfirmation UI', () => {
    it('should include reconfirmation dropdown in edit panel', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync(
        new URL('../../../public/dashboard/index.html', import.meta.url),
        'utf-8'
      );
      expect(html).toContain('id="editEtReconfirmation"');
      expect(html).toContain('24h before');
      expect(html).toContain('48h before');
    });

    it('should show reconfirmation status in booking timeline', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync(
        new URL('../../../public/dashboard/index.html', import.meta.url),
        'utf-8'
      );
      expect(html).toContain('Reconfirmation:');
      expect(html).toContain('reconfirmation_sent_at');
    });
  });
});
