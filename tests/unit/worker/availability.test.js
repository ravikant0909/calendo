import { describe, it, expect } from 'vitest';
import { computeAvailableSlots, generateSlug } from '../../../src/availability.js';

// ============================================================
// Test Helpers
// ============================================================

/** Standard Mon-Fri 9am-5pm schedule in LA timezone */
function standardSchedule() {
  return {
    rules: [
      { day: 1, start: '09:00', end: '17:00' },
      { day: 2, start: '09:00', end: '17:00' },
      { day: 3, start: '09:00', end: '17:00' },
      { day: 4, start: '09:00', end: '17:00' },
      { day: 5, start: '09:00', end: '17:00' },
    ],
    overrides: [],
    timezone: 'America/Los_Angeles',
  };
}

/** Standard 30-min event type */
function standardEventType(overrides = {}) {
  return {
    duration_minutes: 30,
    buffer_before: 0,
    buffer_after: 0,
    min_notice_hours: 4,
    max_future_days: 60,
    max_bookings_per_day: null,
    slot_interval: 30,
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('computeAvailableSlots', () => {
  // ----------------------------------------------------------
  // Basic Availability
  // ----------------------------------------------------------
  describe('basic availability (Mon-Fri 9-5, 30-min slots)', () => {
    it('should return correct number of slots for a single weekday', () => {
      // 2026-03-09 is a Monday in LA
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'), // well before the day
      });

      // 9am to 5pm = 8 hours = 16 half-hour slots
      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).toHaveLength(16);
      expect(result[mondayDate][0]).toBe('09:00');
      expect(result[mondayDate][15]).toBe('16:30');
    });

    it('should return slots for multiple weekdays', () => {
      // Mon March 9 through Fri March 13
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-13' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // 5 weekdays, each with 16 slots
      const allSlots = Object.values(result).flat();
      expect(allSlots).toHaveLength(80);
    });
  });

  // ----------------------------------------------------------
  // Buffer Time
  // ----------------------------------------------------------
  describe('buffer time', () => {
    it('should reduce available slots when buffer is applied around an existing booking', () => {
      // 2pm PDT = 21:00 UTC (March 9 2026 is PDT, UTC-7)
      const withoutBuffer = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ buffer_before: 0, buffer_after: 0 }),
        existingBookings: [
          { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z' }, // 2pm PDT
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const withBuffer = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ buffer_before: 15, buffer_after: 15 }),
        existingBookings: [
          { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z' }, // 2pm PDT
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slotsWithout = Object.values(withoutBuffer).flat();
      const slotsWith = Object.values(withBuffer).flat();

      // Buffer should remove more slots than without buffer
      expect(slotsWith.length).toBeLessThan(slotsWithout.length);
    });

    it('should not generate slots that overlap with buffer zones', () => {
      // Booking at 2:00-2:30 PM LA time (PDT = UTC-7), with 30-min buffer before and after
      // 2pm PDT = 21:00 UTC
      // Buffer zone: 1:30 PM - 3:00 PM
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ buffer_before: 30, buffer_after: 30 }),
        existingBookings: [
          { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z' }, // 2pm PDT
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      // 13:00 slot: ends 13:30 + 30 buffer = 14:00, booking starts 14:00 => exactly touching, no overlap
      expect(slots).toContain('13:00');
      // 13:30 slot: ends 14:00 + 30 buffer = 14:30, booking starts 14:00 => overlap (14:30 > 14:00)
      expect(slots).not.toContain('13:30');
      expect(slots).not.toContain('14:00');
      expect(slots).not.toContain('14:30');
      // 15:00 slot: starts 15:00 - 30 buffer = 14:30, booking ends 14:30 => exactly touching, no overlap
      expect(slots).toContain('15:00');
    });
  });

  // ----------------------------------------------------------
  // Conflict Detection
  // ----------------------------------------------------------
  describe('conflict detection', () => {
    it('should remove slots that conflict with existing bookings', () => {
      // 2pm PDT = 21:00 UTC
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [
          { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z' }, // 2pm PDT
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).not.toContain('14:00');
      expect(slots).toContain('13:30');
      expect(slots).toContain('14:30');
    });

    it('should treat legacy SQLite timestamps as UTC when checking conflicts', () => {
      const result = computeAvailableSlots({
        schedule: {
          rules: [{ day: 3, start: '09:00', end: '10:00' }],
          overrides: [],
          timezone: 'UTC',
        },
        eventType: standardEventType({ min_notice_hours: 0 }),
        existingBookings: [
          { start_time: '2026-04-01 09:00:00', end_time: '2026-04-01 09:30:00' },
        ],
        dateRange: { start: '2026-04-01', end: '2026-04-01' },
        inviteeTimezone: 'UTC',
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).not.toContain('09:00');
      expect(slots).toContain('09:30');
    });

    it('should handle multiple existing bookings on the same day', () => {
      // 9am PDT = 16:00 UTC, 2pm PDT = 21:00 UTC
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [
          { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z' }, // 9am PDT
          { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z' }, // 2pm PDT
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).not.toContain('09:00');
      expect(slots).not.toContain('14:00');
      expect(slots).toContain('09:30');
      expect(slots).toContain('14:30');
    });
  });

  // ----------------------------------------------------------
  // Min Notice
  // ----------------------------------------------------------
  describe('min notice', () => {
    it('should filter out slots less than min_notice_hours from now', () => {
      // "now" is 2026-03-09 18:00 UTC = 11:00 AM PDT
      // min_notice = 4 hours, so earliest slot is 3:00 PM PDT = 15:00
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ min_notice_hours: 4 }),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-09T18:00:00Z'), // 11am PDT
      });

      const slots = Object.values(result).flat();
      // Earliest available should be 15:00
      expect(slots[0]).toBe('15:00');
      expect(slots).not.toContain('09:00');
      expect(slots).not.toContain('14:30');
    });

    it('should allow all slots when now is far in the past', () => {
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ min_notice_hours: 4 }),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots[0]).toBe('09:00');
      expect(slots).toHaveLength(16);
    });
  });

  // ----------------------------------------------------------
  // Max Bookings Per Day
  // ----------------------------------------------------------
  describe('max bookings per day', () => {
    it('should return no slots if max bookings reached', () => {
      // 9am PDT = 16:00 UTC, 10am = 17:00, 11am = 18:00
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ max_bookings_per_day: 3 }),
        existingBookings: [
          { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' },
          { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
          { start_time: '2026-03-09T18:00:00Z', end_time: '2026-03-09T18:30:00Z', status: 'confirmed' },
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).toHaveLength(0);
    });

    it('should allow slots if bookings are below the max', () => {
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ max_bookings_per_day: 3 }),
        existingBookings: [
          { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' },
          { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      // Day is not blocked (2 < 3), all slots shown minus 2 conflicts = 14
      expect(slots).toHaveLength(14);
    });

    it('should not count cancelled bookings toward the max', () => {
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ max_bookings_per_day: 2 }),
        existingBookings: [
          { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' },
          { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'cancelled' },
        ],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      // 1 confirmed booking (cancelled not counted), max=2, day not blocked (1 < 2)
      // All slots shown minus 2 conflicts (conflict check uses all bookings) = 14
      expect(slots).toHaveLength(14);
    });
  });

  // ----------------------------------------------------------
  // Date Override - Day Blocked
  // ----------------------------------------------------------
  describe('date override - day blocked', () => {
    it('should return no slots when override marks day as unavailable', () => {
      const schedule = standardSchedule();
      schedule.overrides = [{ date: '2026-03-09', available: false }];

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).toHaveLength(0);
    });

    it('should only block the overridden day, not others', () => {
      const schedule = standardSchedule();
      schedule.overrides = [{ date: '2026-03-09', available: false }]; // Block Monday

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-10' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // Monday should have no slots, Tuesday should have 16
      expect(result['2026-03-09'] || []).toHaveLength(0);
      expect(result['2026-03-10']).toHaveLength(16);
    });
  });

  // ----------------------------------------------------------
  // Date Override - Custom Hours
  // ----------------------------------------------------------
  describe('date override - custom hours', () => {
    it('should use override hours instead of regular rules', () => {
      const schedule = standardSchedule();
      schedule.overrides = [{ date: '2026-03-09', start: '10:00', end: '14:00' }];

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      // 10:00 to 14:00 = 4 hours = 8 half-hour slots
      expect(slots).toHaveLength(8);
      expect(slots[0]).toBe('10:00');
      expect(slots[7]).toBe('13:30');
    });

    it('should allow opening a normally closed day via override', () => {
      // Saturday (2026-03-14) has no rules, but override opens 10-12
      const schedule = standardSchedule();
      schedule.overrides = [{ date: '2026-03-14', start: '10:00', end: '12:00' }];

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-14', end: '2026-03-14' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      // 10:00 to 12:00 = 4 half-hour slots
      expect(slots).toHaveLength(4);
      expect(slots[0]).toBe('10:00');
    });
  });

  // ----------------------------------------------------------
  // Timezone Conversion
  // ----------------------------------------------------------
  describe('timezone conversion', () => {
    it('should shift times from host timezone to invitee timezone', () => {
      // Host: LA (Pacific), Invitee: New York (Eastern)
      // March 9 2026 - both are in standard time (DST starts March 8 2026)
      // Actually, DST starts second Sunday of March — March 8, 2026.
      // So March 9 is DST: PDT (UTC-7) and EDT (UTC-4), difference = 3 hours
      const result = computeAvailableSlots({
        schedule: standardSchedule(), // 9-5 LA time
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // 9am LA = 12pm NY, 5pm LA = 8pm NY
      // First slot in NY time should be 12:00
      const allSlots = Object.values(result).flat();
      expect(allSlots[0]).toBe('12:00');
      expect(allSlots[allSlots.length - 1]).toBe('19:30');
    });

    it('should handle invitee timezone behind the host', () => {
      // Host: New York (Eastern), Invitee: LA (Pacific)
      const schedule = {
        rules: [
          { day: 1, start: '09:00', end: '17:00' },
        ],
        overrides: [],
        timezone: 'America/New_York',
      };

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // 9am NY = 6am LA, 5pm NY = 2pm LA
      const allSlots = Object.values(result).flat();
      expect(allSlots[0]).toBe('06:00');
      expect(allSlots[allSlots.length - 1]).toBe('13:30');
    });

    it('should group slots by invitee date when timezone crosses midnight', () => {
      // Host in LA, invitee in Asia/Tokyo (UTC+9)
      // LA 9am PDT = UTC 16:00 = Tokyo 1am next day (JST)
      // LA 5pm PDT = UTC 0:00 next day = Tokyo 9am next day
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'Asia/Tokyo',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // All slots should appear under the next day in Tokyo time
      const dates = Object.keys(result);
      // The slots will be on March 10 in Tokyo time
      expect(dates).toContain('2026-03-10');
    });
  });

  // ----------------------------------------------------------
  // Weekend Unavailability
  // ----------------------------------------------------------
  describe('weekend unavailability', () => {
    it('should return no slots for Saturday and Sunday with Mon-Fri schedule', () => {
      // 2026-03-14 is Saturday, 2026-03-15 is Sunday
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-14', end: '2026-03-15' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).toHaveLength(0);
    });

    it('should return slots only for weekdays in a full week', () => {
      // Mon March 9 through Sun March 15
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-15' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // 5 weekdays * 16 slots = 80
      const allSlots = Object.values(result).flat();
      expect(allSlots).toHaveLength(80);
    });
  });

  // ----------------------------------------------------------
  // Edge Case: Event doesn't fit in remaining window
  // ----------------------------------------------------------
  describe('edge case: event does not fit in remaining window', () => {
    it('should not generate slot when only 45 min left for 60-min event', () => {
      const schedule = {
        rules: [
          { day: 1, start: '09:00', end: '09:45' }, // only 45 min window
        ],
        overrides: [],
        timezone: 'America/Los_Angeles',
      };

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType({ duration_minutes: 60 }),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).toHaveLength(0);
    });

    it('should generate exactly one slot when window matches event duration', () => {
      const schedule = {
        rules: [
          { day: 1, start: '09:00', end: '10:00' }, // exactly 60 min
        ],
        overrides: [],
        timezone: 'America/Los_Angeles',
      };

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType({ duration_minutes: 60 }),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).toHaveLength(1);
      expect(slots[0]).toBe('09:00');
    });
  });

  // ----------------------------------------------------------
  // Edge Case: Empty schedule (no rules)
  // ----------------------------------------------------------
  describe('edge case: empty schedule', () => {
    it('should return no slots when schedule has no rules', () => {
      const schedule = {
        rules: [],
        overrides: [],
        timezone: 'America/Los_Angeles',
      };

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-13' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      expect(slots).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Max Future Days
  // ----------------------------------------------------------
  describe('max future days', () => {
    it('should exclude dates beyond max_future_days', () => {
      // now = March 8 00:00 UTC, max_future_days = 3
      // max date = March 11 00:00 UTC
      // March 9 dayStart in LA (PDT) = 07:00 UTC March 9 => within range
      // March 10 dayStart in LA (PDT) = 07:00 UTC March 10 => within range
      // March 11 dayStart in LA (PDT) = 07:00 UTC March 11 => just past maxDate (March 11 00:00 UTC)
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ max_future_days: 3 }),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-13' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const dates = Object.keys(result);
      expect(dates).toContain('2026-03-09');
      expect(dates).toContain('2026-03-10');
      expect(dates).not.toContain('2026-03-11');
      expect(dates).not.toContain('2026-03-12');
      expect(dates).not.toContain('2026-03-13');
    });
  });

  // ----------------------------------------------------------
  // Multiple Time Windows
  // ----------------------------------------------------------
  describe('multiple time windows per day', () => {
    it('should generate slots across split availability windows', () => {
      const schedule = {
        rules: [
          { day: 1, start: '09:00', end: '12:00' }, // morning
          { day: 1, start: '14:00', end: '17:00' }, // afternoon (lunch break)
        ],
        overrides: [],
        timezone: 'America/Los_Angeles',
      };

      const result = computeAvailableSlots({
        schedule,
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const slots = Object.values(result).flat();
      // Morning: 9-12 = 6 slots, Afternoon: 14-17 = 6 slots
      expect(slots).toHaveLength(12);
      expect(slots).toContain('09:00');
      expect(slots).toContain('11:30');
      expect(slots).toContain('14:00');
      expect(slots).toContain('16:30');
      // Lunch slot should NOT be present
      expect(slots).not.toContain('12:00');
      expect(slots).not.toContain('13:00');
    });
  });
});

// ============================================================
// Slug Generation Tests
// ============================================================

describe('generateSlug', () => {
  it('should convert name to lowercase slug', () => {
    expect(generateSlug('30 Minute Meeting')).toBe('30-minute-meeting');
  });

  it('should handle multiple spaces', () => {
    expect(generateSlug('Quick   Chat')).toBe('quick-chat');
  });

  it('should remove special characters', () => {
    expect(generateSlug('Meeting (Optional)')).toBe('meeting-optional');
  });

  it('should handle leading and trailing spaces', () => {
    expect(generateSlug('  Intro Call  ')).toBe('intro-call');
  });

  it('should handle hyphens in input', () => {
    expect(generateSlug('One-on-One')).toBe('one-on-one');
  });

  it('should collapse multiple hyphens', () => {
    expect(generateSlug('A  -  B')).toBe('a-b');
  });

  it('should handle all-uppercase input', () => {
    expect(generateSlug('DEMO SESSION')).toBe('demo-session');
  });

  it('should handle numeric input', () => {
    expect(generateSlug('15 Min')).toBe('15-min');
  });

  it('should handle single word', () => {
    expect(generateSlug('consultation')).toBe('consultation');
  });

  it('should strip leading/trailing hyphens after cleanup', () => {
    expect(generateSlug('---hello---')).toBe('hello');
  });
});
