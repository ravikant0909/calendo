import { describe, it, expect } from 'vitest';
import {
  generateICS,
  bookingConfirmationEmail,
  hostNotificationEmail,
  cancellationEmail,
  reminderEmail,
  sendEmail,
} from '../../../src/email.js';

// Test fixtures
const mockBooking = {
  id: 1,
  uid: 'abc-123-def',
  invitee_name: 'Alice Johnson',
  invitee_email: 'alice@example.com',
  invitee_timezone: 'America/New_York',
  start_time: '2026-03-15 14:00:00',
  end_time: '2026-03-15 14:30:00',
  status: 'confirmed',
  cancel_token: 'cancel-token-xyz',
};

const mockEventType = {
  id: 1,
  name: '30-Minute Meeting',
  slug: '30-minute-meeting',
  description: 'A quick introductory call',
  duration_minutes: 30,
};

const mockHost = {
  id: 1,
  name: 'Ravi Kumar',
  email: 'ravi@example.com',
  timezone: 'America/Los_Angeles',
};

// ============================================================
// ICS Generation Tests
// ============================================================

describe('generateICS', () => {
  it('should generate valid iCalendar format', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:-//Calendo//Calendo//EN');
  });

  it('should include DTSTART and DTEND in correct format', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    // Should be in format YYYYMMDDTHHMMSSZ
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).toMatch(/DTEND:\d{8}T\d{6}Z/);
  });

  it('should treat legacy stored timestamps as UTC in ICS output', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('DTSTART:20260315T140000Z');
    expect(ics).toContain('DTEND:20260315T143000Z');
  });

  it('should include SUMMARY with event name and host', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('SUMMARY:30-Minute Meeting with Ravi Kumar');
  });

  it('should include DESCRIPTION with event details', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('DESCRIPTION:30-Minute Meeting - A quick introductory call');
  });

  it('should include ORGANIZER with host info', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('ORGANIZER;CN=Ravi Kumar:mailto:ravi@example.com');
  });

  it('should include ATTENDEE with invitee info', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('ATTENDEE;CN=Alice Johnson;RSVP=TRUE:mailto:alice@example.com');
  });

  it('should include UID based on booking uid', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('UID:abc-123-def@calendo.dev');
  });

  it('should use CRLF line endings', () => {
    const ics = generateICS(mockBooking, mockEventType, mockHost.name, mockHost.email);

    expect(ics).toContain('\r\n');
  });

  it('should escape special characters in text fields', () => {
    const specialBooking = {
      ...mockBooking,
      invitee_name: 'Alice; Johnson, Jr.',
    };
    const specialEvent = {
      ...mockEventType,
      name: 'Meeting; with, commas',
      description: 'Has special; chars, here',
    };

    const ics = generateICS(specialBooking, specialEvent, mockHost.name, mockHost.email);

    expect(ics).toContain('\\;');
    expect(ics).toContain('\\,');
  });

  it('should handle event type without description', () => {
    const noDescEvent = { ...mockEventType, description: null };
    const ics = generateICS(mockBooking, noDescEvent, mockHost.name, mockHost.email);

    expect(ics).toContain('DESCRIPTION:30-Minute Meeting');
    expect(ics).toContain('BEGIN:VEVENT');
  });
});

// ============================================================
// Email Template Tests
// ============================================================

describe('bookingConfirmationEmail', () => {
  it('should generate correct subject line', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.subject).toBe('Confirmed: 30-Minute Meeting with Ravi Kumar');
  });

  it('should include HTML with meeting details', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.html).toContain('30-Minute Meeting');
    expect(result.html).toContain('Ravi Kumar');
    expect(result.html).toContain('30 minutes');
    expect(result.html).toContain('Your meeting is confirmed');
  });

  it('should include cancel and reschedule links', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.html).toContain('https://calendo.dev/cancel/abc-123-def?token=cancel-token-xyz');
    expect(result.html).toContain('https://calendo.dev/reschedule/abc-123-def?token=cancel-token-xyz');
  });

  it('should include plain text fallback', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.text).toContain('30-Minute Meeting');
    expect(result.text).toContain('Ravi Kumar');
    expect(result.text).toContain('Cancel:');
    expect(result.text).toContain('Reschedule:');
  });

  it('should render legacy stored timestamps in the invitee timezone', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.text).toContain('10:00 AM');
  });

  it('should use Calendo branding colors', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.html).toContain('#2563eb');
  });

  it('should have valid HTML structure', () => {
    const result = bookingConfirmationEmail(mockBooking, mockEventType, mockHost, 'https://calendo.dev');

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('</html>');
  });
});

describe('hostNotificationEmail', () => {
  it('should generate correct subject line', () => {
    const result = hostNotificationEmail(mockBooking, mockEventType, mockHost);

    expect(result.subject).toBe('New booking: Alice Johnson - 30-Minute Meeting');
  });

  it('should include invitee details in HTML', () => {
    const result = hostNotificationEmail(mockBooking, mockEventType, mockHost);

    expect(result.html).toContain('Alice Johnson');
    expect(result.html).toContain('alice@example.com');
    expect(result.html).toContain('New booking received');
  });

  it('should include plain text with invitee details', () => {
    const result = hostNotificationEmail(mockBooking, mockEventType, mockHost);

    expect(result.text).toContain('Alice Johnson');
    expect(result.text).toContain('alice@example.com');
    expect(result.text).toContain('30-Minute Meeting');
  });

  it('should include event duration', () => {
    const result = hostNotificationEmail(mockBooking, mockEventType, mockHost);

    expect(result.html).toContain('30 minutes');
    expect(result.text).toContain('30 minutes');
  });
});

describe('cancellationEmail', () => {
  it('should generate correct subject with date', () => {
    const result = cancellationEmail(mockBooking, mockEventType, 'host', 'Alice Johnson');

    expect(result.subject).toContain('Cancelled: 30-Minute Meeting on');
  });

  it('should indicate who cancelled (host)', () => {
    const result = cancellationEmail(mockBooking, mockEventType, 'host', 'Alice Johnson');

    expect(result.html).toContain('the host');
    expect(result.text).toContain('the host');
  });

  it('should indicate who cancelled (invitee)', () => {
    const result = cancellationEmail(mockBooking, mockEventType, 'invitee', 'Ravi Kumar');

    expect(result.html).toContain('the invitee');
    expect(result.text).toContain('the invitee');
  });

  it('should include recipient name', () => {
    const result = cancellationEmail(mockBooking, mockEventType, 'host', 'Alice Johnson');

    expect(result.html).toContain('Alice Johnson');
    expect(result.text).toContain('Alice Johnson');
  });

  it('should include plain text fallback', () => {
    const result = cancellationEmail(mockBooking, mockEventType, 'host', 'Alice Johnson');

    expect(result.text).toContain('Meeting cancelled');
    expect(result.text).toContain('30-Minute Meeting');
  });

  it('should show event name with line-through in HTML', () => {
    const result = cancellationEmail(mockBooking, mockEventType, 'host', 'Alice Johnson');

    expect(result.html).toContain('line-through');
  });
});

describe('reminderEmail', () => {
  it('should generate correct subject with hours', () => {
    const result = reminderEmail(mockBooking, mockEventType, 24, 'Alice Johnson');

    expect(result.subject).toBe('Reminder: 30-Minute Meeting in 24 hours');
  });

  it('should include recipient name and hours until meeting', () => {
    const result = reminderEmail(mockBooking, mockEventType, 1, 'Alice Johnson');

    expect(result.html).toContain('Alice Johnson');
    expect(result.html).toContain('1 hours');
    expect(result.subject).toBe('Reminder: 30-Minute Meeting in 1 hours');
  });

  it('should include event details in HTML', () => {
    const result = reminderEmail(mockBooking, mockEventType, 24, 'Alice Johnson');

    expect(result.html).toContain('30-Minute Meeting');
    expect(result.html).toContain('Meeting reminder');
  });

  it('should include plain text fallback', () => {
    const result = reminderEmail(mockBooking, mockEventType, 24, 'Alice Johnson');

    expect(result.text).toContain('Meeting reminder');
    expect(result.text).toContain('24 hours');
    expect(result.text).toContain('30-Minute Meeting');
  });
});

// ============================================================
// sendEmail Tests
// ============================================================

describe('sendEmail', () => {
  it('should call Resend API with correct payload', async () => {
    let capturedRequest = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedRequest = { url, opts };
      return new Response('{"id":"re_123"}', { status: 200 });
    };

    const mockEnv = {
      RESEND_API_KEY: 'test-resend-key',
      DB: {
        prepare: () => ({
          bind: () => ({
            run: () => ({ success: true }),
          }),
        }),
      },
    };

    const result = await sendEmail(mockEnv, {
      to: 'test@example.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
      text: 'Hello',
      bookingId: 1,
      type: 'confirmation',
    });

    expect(result.success).toBe(true);
    expect(capturedRequest.url).toBe('https://api.resend.com/emails');
    expect(capturedRequest.opts.headers['Authorization']).toBe('Bearer test-resend-key');
    expect(capturedRequest.opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(capturedRequest.opts.body);
    expect(body.from).toBe('Calendo <notifications@calendo.dev>');
    expect(body.to).toEqual(['test@example.com']);
    expect(body.subject).toBe('Test Subject');
    expect(body.html).toBe('<p>Hello</p>');
    expect(body.text).toBe('Hello');

    globalThis.fetch = originalFetch;
  });

  it('should handle Resend API errors gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('Rate limited', { status: 429 });

    const mockEnv = {
      RESEND_API_KEY: 'test-resend-key',
      DB: {
        prepare: () => ({
          bind: () => ({
            run: () => ({ success: true }),
          }),
        }),
      },
    };

    const result = await sendEmail(mockEnv, {
      to: 'test@example.com',
      subject: 'Test',
      html: '<p>Test</p>',
      text: 'Test',
      bookingId: 1,
      type: 'confirmation',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Resend');
    expect(result.error).toContain('429');

    globalThis.fetch = originalFetch;
  });

  it('should handle network errors gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Network error'); };

    const mockEnv = {
      RESEND_API_KEY: 'test-resend-key',
      DB: {
        prepare: () => ({
          bind: () => ({
            run: () => ({ success: true }),
          }),
        }),
      },
    };

    const result = await sendEmail(mockEnv, {
      to: 'test@example.com',
      subject: 'Test',
      html: '<p>Test</p>',
      text: 'Test',
      bookingId: 1,
      type: 'confirmation',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');

    globalThis.fetch = originalFetch;
  });

  it('should skip outbound delivery when notifications are disabled for local smoke and E2E runs', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{"id":"re_123"}', { status: 200 }));

    const mockEnv = {
      DISABLE_OUTBOUND_NOTIFICATIONS: '1',
      RESEND_API_KEY: 'test-resend-key',
      DB: {
        prepare: () => ({
          bind: () => ({
            run: () => ({ success: true }),
          }),
        }),
      },
    };

    const result = await sendEmail(mockEnv, {
      to: 'test@example.com',
      subject: 'Test',
      html: '<p>Test</p>',
      text: 'Test',
      bookingId: 1,
      type: 'confirmation',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('skipped');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it('should log notification in the database', async () => {
    let loggedData = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"id":"re_123"}', { status: 200 });

    const mockEnv = {
      RESEND_API_KEY: 'test-resend-key',
      DB: {
        prepare: (sql) => ({
          bind: (...args) => {
            if (sql.includes('notification_log')) {
              loggedData = args;
            }
            return {
              run: () => ({ success: true }),
            };
          },
        }),
      },
    };

    await sendEmail(mockEnv, {
      to: 'test@example.com',
      subject: 'Test Subject',
      html: '<p>Test</p>',
      text: 'Test',
      bookingId: 42,
      type: 'reminder_24h',
    });

    expect(loggedData).not.toBeNull();
    expect(loggedData[0]).toBe(42); // bookingId
    expect(loggedData[1]).toBe('reminder_24h'); // type
    expect(loggedData[2]).toBe('test@example.com'); // recipient
    expect(loggedData[3]).toBe('Test Subject'); // subject
    expect(loggedData[4]).toBe('sent'); // status

    globalThis.fetch = originalFetch;
  });
});

// ============================================================
// Reminder Query Logic Tests
// ============================================================

describe('Reminder query logic', () => {
  it('should compute correct 24h window boundaries', () => {
    const now = new Date('2026-03-15T10:00:00Z');
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const windowStart = new Date(in24h.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(in24h.getTime() + 5 * 60 * 1000);

    // 24h from 10:00 = 10:00 next day
    // Window: 09:55 to 10:05 next day
    expect(windowStart.toISOString()).toBe('2026-03-16T09:55:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-03-16T10:05:00.000Z');
  });

  it('should compute correct 1h window boundaries', () => {
    const now = new Date('2026-03-15T10:00:00Z');
    const in1h = new Date(now.getTime() + 60 * 60 * 1000);
    const windowStart = new Date(in1h.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(in1h.getTime() + 5 * 60 * 1000);

    expect(windowStart.toISOString()).toBe('2026-03-15T10:55:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-03-15T11:05:00.000Z');
  });

  it('should format window times correctly for D1 queries', () => {
    const now = new Date('2026-03-15T10:00:00Z');
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const windowStart = new Date(in24h.getTime() - 5 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const windowEnd = new Date(in24h.getTime() + 5 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

    // D1 format: "YYYY-MM-DD HH:MM:SS"
    expect(windowStart).toBe('2026-03-16 09:55:00');
    expect(windowEnd).toBe('2026-03-16 10:05:00');
  });

  it('should use reminder_24h and reminder_1h type strings for dedup', () => {
    const type24 = `reminder_${24}h`;
    const type1 = `reminder_${1}h`;

    expect(type24).toBe('reminder_24h');
    expect(type1).toBe('reminder_1h');
  });
});
