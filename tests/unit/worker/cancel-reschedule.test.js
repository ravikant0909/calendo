import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock crypto.randomUUID for deterministic tests
const originalRandomUUID = crypto.randomUUID;

describe('Cancel & Reschedule by Token API', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
  });

  // Helper to create a mock env with a configurable DB
  function createEnv(dbConfig = {}) {
    const defaultPrepare = () => ({
      bind: () => ({
        first: () => null,
        all: () => ({ results: [] }),
        run: () => ({ success: true }),
      }),
    });

    return {
      DB: {
        prepare: dbConfig.prepare || defaultPrepare,
      },
      ASSETS: { fetch: () => new Response('') },
    };
  }

  // Helper to call the worker
  async function callWorker(url, method, env, body) {
    const options = { method };
    if (body) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const request = new Request(url, options);
    return worker.default.fetch(request, env, {});
  }

  // ============================================
  // GET /api/bookings/by-token/:token
  // ============================================
  describe('GET /api/bookings/by-token/:token', () => {
    it('should return booking details for valid token', async () => {
      const mockBooking = {
        uid: 'booking-uid-123',
        invitee_name: 'Alice Smith',
        invitee_email: 'alice@example.com',
        invitee_timezone: 'America/New_York',
        start_time: '2026-04-15 14:00:00',
        end_time: '2026-04-15 14:30:00',
        status: 'confirmed',
        event_type_name: '30 Minute Meeting',
        event_type_slug: '30-minute-meeting',
        duration_minutes: 30,
        host_name: 'Ravi',
        booking_page_slug: 'ravi',
        created_at: '2026-03-07 10:00:00',
      };

      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => mockBooking,
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/by-token/valid-cancel-token',
        'GET', env
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.uid).toBe('booking-uid-123');
      expect(data.invitee_name).toBe('Alice Smith');
      expect(data.event_type_name).toBe('30 Minute Meeting');
      expect(data.host_name).toBe('Ravi');
      expect(data.booking_page_slug).toBe('ravi');
    });

    it('should return 404 for invalid token', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => null,
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/by-token/invalid-token',
        'GET', env
      );

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain('Invalid or expired token');
    });
  });

  // ============================================
  // POST /api/bookings/cancel-by-token/:token
  // ============================================
  describe('POST /api/bookings/cancel-by-token/:token', () => {
    it('should cancel a valid future booking', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const futureDateStr = futureDate.toISOString().replace('T', ' ').slice(0, 19);

      let updateCalled = false;
      let updateArgs = {};

      const env = createEnv({
        prepare: (sql) => ({
          bind: (...args) => {
            if (sql.includes('SELECT b.id')) {
              return {
                first: () => ({
                  id: 42,
                  uid: 'booking-uid-123',
                  status: 'confirmed',
                  start_time: futureDateStr,
                }),
              };
            }
            if (sql.includes('UPDATE bookings SET status')) {
              updateCalled = true;
              updateArgs = { reason: args[0], id: args[1] };
              return { run: () => ({ success: true }) };
            }
            return { first: () => null, run: () => ({ success: true }) };
          },
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/valid-token',
        'POST', env,
        { reason: 'Schedule conflict' }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.message).toContain('cancelled');
      expect(updateCalled).toBe(true);
      expect(updateArgs.reason).toBe('Schedule conflict');
      expect(updateArgs.id).toBe(42);
    });

    it('should return 404 for invalid token', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => null,
            run: () => ({ success: true }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/invalid-token',
        'POST', env,
        {}
      );

      expect(res.status).toBe(404);
    });

    it('should return 400 for already cancelled booking', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 42,
              uid: 'uid-123',
              status: 'cancelled',
              start_time: '2026-12-15 14:00:00',
            }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/token',
        'POST', env,
        {}
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('already been cancelled');
    });

    it('should return 400 for already rescheduled booking', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 42,
              uid: 'uid-123',
              status: 'rescheduled',
              start_time: '2026-12-15 14:00:00',
            }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/token',
        'POST', env,
        {}
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('rescheduled');
    });

    it('should return 400 for past booking', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const pastDateStr = pastDate.toISOString().replace('T', ' ').slice(0, 19);

      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 42,
              uid: 'uid-123',
              status: 'confirmed',
              start_time: pastDateStr,
            }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/token',
        'POST', env,
        {}
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('already started or passed');
    });

    it('should accept cancellation without reason', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const futureDateStr = futureDate.toISOString().replace('T', ' ').slice(0, 19);

      let capturedReason = 'NOT_SET';

      const env = createEnv({
        prepare: (sql) => ({
          bind: (...args) => {
            if (sql.includes('SELECT b.id')) {
              return {
                first: () => ({
                  id: 42,
                  uid: 'uid-123',
                  status: 'confirmed',
                  start_time: futureDateStr,
                }),
              };
            }
            if (sql.includes('UPDATE bookings SET status')) {
              capturedReason = args[0];
              return { run: () => ({ success: true }) };
            }
            return { first: () => null, run: () => ({ success: true }) };
          },
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/token',
        'POST', env,
        {}
      );

      expect(res.status).toBe(200);
      expect(capturedReason).toBeNull();
    });
  });

  // ============================================
  // POST /api/bookings/reschedule-by-token/:token
  // ============================================
  describe('POST /api/bookings/reschedule-by-token/:token', () => {
    it('should return 404 for invalid token', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({ success: true }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/invalid-token',
        'POST', env,
        { new_start_time: '2026-04-15T14:00:00Z', timezone: 'UTC' }
      );

      expect(res.status).toBe(404);
    });

    it('should return 400 for cancelled booking', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 1, status: 'cancelled',
              duration_minutes: 30, user_id: 1,
              et_id: 1, event_type_name: 'Meeting',
            }),
            all: () => ({ results: [] }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/token',
        'POST', env,
        { new_start_time: '2026-04-15T14:00:00Z', timezone: 'UTC' }
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('cancelled');
    });

    it('should return 400 for already rescheduled booking', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 1, status: 'rescheduled',
              duration_minutes: 30, user_id: 1,
              et_id: 1, event_type_name: 'Meeting',
            }),
            all: () => ({ results: [] }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/token',
        'POST', env,
        { new_start_time: '2026-04-15T14:00:00Z', timezone: 'UTC' }
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('rescheduled');
    });

    it('should return 400 when new_start_time is missing', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 1, status: 'confirmed',
              duration_minutes: 30, user_id: 1,
              et_id: 1, event_type_name: 'Meeting',
            }),
            all: () => ({ results: [] }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/token',
        'POST', env,
        { timezone: 'UTC' }
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('new_start_time is required');
    });

    it('should return 400 for past new_start_time', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 1, status: 'confirmed',
              duration_minutes: 30, user_id: 1,
              et_id: 1, event_type_name: 'Meeting',
              start_time: '2026-12-15 14:00:00',
              invitee_timezone: 'UTC',
            }),
            all: () => ({ results: [] }),
          }),
        }),
      });

      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/token',
        'POST', env,
        { new_start_time: pastDate, timezone: 'UTC' }
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('past');
    });

    it('should return 400 for invalid date format', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 1, status: 'confirmed',
              duration_minutes: 30, user_id: 1,
              et_id: 1, event_type_name: 'Meeting',
            }),
            all: () => ({ results: [] }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/token',
        'POST', env,
        { new_start_time: 'not-a-date', timezone: 'UTC' }
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Invalid');
    });

    it('should return 400 for missing JSON body', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => ({
              id: 1, status: 'confirmed',
              duration_minutes: 30, user_id: 1,
              et_id: 1, event_type_name: 'Meeting',
            }),
            all: () => ({ results: [] }),
          }),
        }),
      });

      // Send request with invalid JSON
      const request = new Request(
        'https://calendo.dev/api/bookings/reschedule-by-token/token',
        { method: 'POST', body: 'not json' }
      );
      const res = await worker.default.fetch(request, env, {});

      expect(res.status).toBe(400);
    });

    it('should reschedule a booking to an available slot', async () => {
      // This test sets up a complete flow: booking lookup, schedule lookup,
      // availability check, new booking insert, old booking update
      const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      // Make it a Monday 10am UTC
      futureDate.setUTCHours(10, 0, 0, 0);
      const dayOfWeek = futureDate.getUTCDay();
      // Adjust to next Monday if not already Monday
      const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
      futureDate.setUTCDate(futureDate.getUTCDate() + daysUntilMonday);

      const newStartTime = futureDate.toISOString();
      const dateStr = newStartTime.slice(0, 10);

      let insertedBooking = null;
      let oldBookingUpdated = false;

      const env = createEnv({
        prepare: (sql) => ({
          bind: (...args) => {
            // Booking lookup by cancel_token
            if (sql.includes('SELECT b.*') && sql.includes('cancel_token')) {
              return {
                first: () => ({
                  id: 1,
                  uid: 'old-uid',
                  status: 'confirmed',
                  invitee_email: 'alice@example.com',
                  invitee_name: 'Alice',
                  invitee_timezone: 'UTC',
                  start_time: '2026-04-01 10:00:00',
                  end_time: '2026-04-01 10:30:00',
                  answers: '{}',
                  event_type_name: '30 Minute Meeting',
                  event_type_slug: '30-minute-meeting',
                  duration_minutes: 30,
                  user_id: 1,
                  availability_schedule_id: 1,
                  buffer_before: 0,
                  buffer_after: 0,
                  min_notice_hours: 4,
                  max_future_days: 60,
                  max_bookings_per_day: null,
                  requires_confirmation: 0,
                  et_id: 1,
                  host_name: 'Ravi',
                  booking_page_slug: 'ravi',
                }),
              };
            }

            // Availability schedule lookup
            if (sql.includes('availability_schedules') && sql.includes('id = ?')) {
              return {
                first: () => ({
                  id: 1,
                  user_id: 1,
                  timezone: 'UTC',
                  rules: JSON.stringify([
                    { day: 1, start: '09:00', end: '17:00' },
                    { day: 2, start: '09:00', end: '17:00' },
                    { day: 3, start: '09:00', end: '17:00' },
                    { day: 4, start: '09:00', end: '17:00' },
                    { day: 5, start: '09:00', end: '17:00' },
                  ]),
                  overrides: '[]',
                }),
              };
            }

            // Existing bookings query (none conflicting)
            if (sql.includes('SELECT start_time, end_time, status FROM bookings')) {
              return {
                all: () => ({ results: [] }),
              };
            }

            // INSERT new booking
            if (sql.includes('INSERT INTO bookings')) {
              insertedBooking = {
                id: 2,
                uid: args[1], // newUid
                invitee_email: args[2],
                invitee_name: args[3],
                invitee_timezone: args[4],
                start_time: args[5],
                end_time: args[6],
                status: args[7],
                cancel_token: args[9],
                created_at: '2026-03-07 12:00:00',
              };
              return {
                first: () => insertedBooking,
              };
            }

            // UPDATE old booking as rescheduled
            if (sql.includes('UPDATE bookings SET status = \'rescheduled\'')) {
              oldBookingUpdated = true;
              return { run: () => ({ success: true }) };
            }

            return {
              first: () => null,
              all: () => ({ results: [] }),
              run: () => ({ success: true }),
            };
          },
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/valid-token',
        'POST', env,
        { new_start_time: newStartTime, timezone: 'UTC' }
      );

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.message).toContain('rescheduled');
      expect(data.booking).toBeDefined();
      expect(data.booking.invitee_name).toBe('Alice');
      expect(data.booking.invitee_email).toBe('alice@example.com');
      expect(data.booking.cancel_token).toBeDefined();
      expect(oldBookingUpdated).toBe(true);
      expect(insertedBooking).not.toBeNull();
    });
  });

  // ============================================
  // Route registration tests
  // ============================================
  describe('Route registration', () => {
    it('should route GET /api/bookings/by-token/:token to handler', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => null,
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/by-token/some-token',
        'GET', env
      );

      // Should hit our handler and return 404 (token not found), not 401 (auth required)
      expect(res.status).toBe(404);
    });

    it('should route POST /api/bookings/cancel-by-token/:token to handler', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => null,
            run: () => ({ success: true }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/cancel-by-token/some-token',
        'POST', env,
        {}
      );

      // Should hit our handler and return 404, not 401
      expect(res.status).toBe(404);
    });

    it('should route POST /api/bookings/reschedule-by-token/:token to handler', async () => {
      const env = createEnv({
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({ success: true }),
          }),
        }),
      });

      const res = await callWorker(
        'https://calendo.dev/api/bookings/reschedule-by-token/some-token',
        'POST', env,
        { new_start_time: '2026-04-15T14:00:00Z', timezone: 'UTC' }
      );

      // Should hit our handler and return 404, not 401
      expect(res.status).toBe(404);
    });
  });
});
