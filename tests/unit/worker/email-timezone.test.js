import { describe, it, expect } from 'vitest';
import { hostNotificationEmail, bookingConfirmationEmail, cancellationEmail, rescheduleEmail, reminderEmail } from '../../../src/email.js';
import { resolveHostTimezone } from '../../../src/worker.js';

// Customer feedback: the "New booking received" host email showed the time in PST
// (the never-updated profile default) and didn't label the timezone. The host's
// real timezone (IST) lives on their availability schedule.

// 17:00 UTC on 2026-06-13 == 22:30 (10:30 PM) IST, == 13:00 (1:00 PM) US-Eastern.
const booking = {
  start_time: '2026-06-13 17:00:00',
  invitee_name: 'Piyush Kumar',
  invitee_email: 'piyush@example.com',
  invitee_timezone: 'America/New_York',
  guest_emails: null,
  uid: 'abc', cancel_token: 't',
};
const eventType = { name: '30 Minute Meeting', duration_minutes: 30 };

describe('Email timezone: host notification uses the host timezone + labels it', () => {
  it('formats the host email in the host timezone (IST) and labels the zone', () => {
    const { html, text } = hostNotificationEmail(booking, eventType, { name: 'Alex', email: 'r@x.com', timezone: 'Asia/Kolkata' });
    expect(text).toContain('10:30'); // 10:30 PM IST
    expect(text).toMatch(/GMT\+5:30|IST/);
    expect(html).toContain('10:30');
    expect(html).toMatch(/GMT\+5:30|IST/);
  });

  it('does NOT show the time in PST when the host is in IST', () => {
    const { text } = hostNotificationEmail(booking, eventType, { name: 'Alex', email: 'r@x.com', timezone: 'Asia/Kolkata' });
    // 17:00 UTC == 10:00 AM PDT — must NOT appear; host is IST.
    expect(text).not.toMatch(/10:00\s*AM/);
    expect(text).toContain('10:30');
  });

  it('invitee confirmation formats in the invitee timezone and labels it', () => {
    const { text } = bookingConfirmationEmail(booking, eventType, { name: 'Alex', timezone: 'Asia/Kolkata' }, 'https://calendo.dev');
    expect(text).toContain('1:00'); // 1:00 PM US-Eastern
    expect(text).toMatch(/GMT-4|EDT/);
  });
});

describe('All host-facing emails honor an explicit display timezone (host TZ)', () => {
  const IST = 'Asia/Kolkata'; // booking is 10:30 PM IST / 1:00 PM US-Eastern

  it('cancellation email in host timezone + labeled, not invitee TZ', () => {
    const { text } = cancellationEmail(booking, eventType, 'invitee', 'Alex', IST);
    expect(text).toContain('10:30');         // IST
    expect(text).toMatch(/GMT\+5:30|IST/);
    expect(text).not.toMatch(/1:00\s*PM/);   // not the invitee's Eastern time
  });

  it('reschedule email in host timezone for both old and new times', () => {
    const oldB = { start_time: '2026-06-13 17:00:00', invitee_timezone: 'America/New_York' };
    const newB = { start_time: '2026-06-20 17:00:00', invitee_timezone: 'America/New_York', invitee_name: 'Piyush', invitee_email: 'p@x.com', cancel_token: 't' };
    const { text } = rescheduleEmail(newB, oldB, eventType, 'Alex', 'https://calendo.dev', IST);
    expect(text).toContain('10:30');
    expect(text).toMatch(/GMT\+5:30|IST/);
  });

  it('reminder email in host timezone + labeled', () => {
    const { text } = reminderEmail(booking, eventType, 24, 'Alex', IST);
    expect(text).toContain('10:30');
    expect(text).toMatch(/GMT\+5:30|IST/);
  });

  it('omitting the display timezone falls back to the invitee timezone (unchanged for invitee emails)', () => {
    const { text } = cancellationEmail(booking, eventType, 'invitee', 'Piyush');
    expect(text).toContain('1:00'); // invitee Eastern
  });
});

describe('resolveHostTimezone prefers the availability-schedule timezone over the profile default', () => {
  const mkEnv = (schedTz, eventSchedTz) => ({
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => {
            if (/WHERE id = \? AND user_id/.test(sql)) return eventSchedTz ? { timezone: eventSchedTz } : null;
            if (/is_default = 1/.test(sql)) return schedTz ? { timezone: schedTz } : null;
            return null;
          },
        }),
      }),
    },
  });

  it('uses the default schedule timezone, not the (PST) profile timezone', async () => {
    const tz = await resolveHostTimezone(mkEnv('Asia/Kolkata'), 1, {}, 'America/Los_Angeles');
    expect(tz).toBe('Asia/Kolkata');
  });

  it('uses the event type\'s own schedule timezone when it has one', async () => {
    const tz = await resolveHostTimezone(mkEnv('Asia/Kolkata', 'Europe/London'), 1, { availability_schedule_id: 5 }, 'America/Los_Angeles');
    expect(tz).toBe('Europe/London');
  });

  it('falls back to the profile timezone when no schedule exists', async () => {
    const tz = await resolveHostTimezone(mkEnv(null), 1, {}, 'America/Los_Angeles');
    expect(tz).toBe('America/Los_Angeles');
  });
});
