import { describe, it, expect } from 'vitest';
import { computeAvailableSlots } from '../../../src/availability.js';

// ============================================================
// Helper: create a schedule with meeting limits
// ============================================================
function makeSchedule({ rules = [], overrides = [], holidays = [], timezone = 'America/New_York', meeting_limits = [] } = {}) {
  return {
    rules,
    overrides,
    holidays,
    timezone,
    meeting_limits: JSON.stringify(meeting_limits),
  };
}

function makeEventType(overrides = {}) {
  return {
    duration_minutes: 30,
    buffer_before: 0,
    buffer_after: 0,
    min_notice_hours: 0,
    max_future_days: 60,
    max_bookings_per_day: null,
    slot_interval: 30,
    ...overrides,
  };
}

function makeBooking(startISO, endISO, status = 'confirmed') {
  return { start_time: startISO, end_time: endISO, status };
}

// ============================================================
// Meeting Limits Tests
// ============================================================

describe('Meeting Limits in Slot Computation', () => {
  const baseRules = [
    { day: 1, start: '09:00', end: '17:00' }, // Monday
    { day: 2, start: '09:00', end: '17:00' }, // Tuesday
    { day: 3, start: '09:00', end: '17:00' }, // Wednesday
    { day: 4, start: '09:00', end: '17:00' }, // Thursday
    { day: 5, start: '09:00', end: '17:00' }, // Friday
  ];

  describe('Daily meeting limit', () => {
    it('should show slots when daily limit not reached', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [{ type: 'daily', max: 3 }],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [
          makeBooking('2026-04-20T13:00:00Z', '2026-04-20T13:30:00Z'), // Monday 1 booking
        ],
        dateRange: { start: '2026-04-20', end: '2026-04-20' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      // Should still have slots since only 1 of 3 daily limit used
      const mondaySlots = result['2026-04-20'] || [];
      expect(mondaySlots.length).toBeGreaterThan(0);
    });

    it('should block slots when daily limit reached', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [{ type: 'daily', max: 2 }],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [
          makeBooking('2026-04-20T13:00:00Z', '2026-04-20T13:30:00Z'),
          makeBooking('2026-04-20T14:00:00Z', '2026-04-20T14:30:00Z'),
        ],
        dateRange: { start: '2026-04-20', end: '2026-04-20' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      // Should have no slots for Monday since daily limit of 2 reached
      const mondaySlots = result['2026-04-20'] || [];
      expect(mondaySlots.length).toBe(0);
    });

    it('should not affect other days when one day hits daily limit', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [{ type: 'daily', max: 1 }],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [
          makeBooking('2026-04-20T13:00:00Z', '2026-04-20T13:30:00Z'), // Monday full
        ],
        dateRange: { start: '2026-04-20', end: '2026-04-21' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      // Monday should be blocked, Tuesday should be open
      expect((result['2026-04-20'] || []).length).toBe(0);
      expect((result['2026-04-21'] || []).length).toBeGreaterThan(0);
    });
  });

  describe('Weekly meeting limit', () => {
    it('should block entire week when weekly limit reached', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [{ type: 'weekly', max: 2 }],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [
          makeBooking('2026-04-20T13:00:00Z', '2026-04-20T13:30:00Z'), // Monday
          makeBooking('2026-04-21T13:00:00Z', '2026-04-21T13:30:00Z'), // Tuesday
        ],
        dateRange: { start: '2026-04-20', end: '2026-04-24' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      // All weekdays should be blocked since weekly limit of 2 reached
      for (const d of ['2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24']) {
        expect((result[d] || []).length).toBe(0);
      }
    });

    it('should show slots when weekly limit not reached', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [{ type: 'weekly', max: 5 }],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [
          makeBooking('2026-04-20T13:00:00Z', '2026-04-20T13:30:00Z'), // 1 booking
        ],
        dateRange: { start: '2026-04-20', end: '2026-04-21' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      // Tuesday should still have slots (only 1 of 5 weekly used)
      expect((result['2026-04-21'] || []).length).toBeGreaterThan(0);
    });
  });

  describe('Combined daily and weekly limits', () => {
    it('should enforce both limits simultaneously', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [
          { type: 'daily', max: 3 },
          { type: 'weekly', max: 2 },
        ],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [
          makeBooking('2026-04-20T13:00:00Z', '2026-04-20T13:30:00Z'),
          makeBooking('2026-04-21T13:00:00Z', '2026-04-21T13:30:00Z'),
        ],
        dateRange: { start: '2026-04-22', end: '2026-04-22' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      // Wednesday should be blocked by weekly limit (2 used, max 2)
      // even though daily limit (3) isn't reached
      expect((result['2026-04-22'] || []).length).toBe(0);
    });
  });

  describe('No meeting limits', () => {
    it('should not restrict slots when no meeting limits set', () => {
      const schedule = makeSchedule({
        rules: baseRules,
        meeting_limits: [],
      });

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [],
        dateRange: { start: '2026-04-20', end: '2026-04-20' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      expect((result['2026-04-20'] || []).length).toBeGreaterThan(0);
    });

    it('should handle missing meeting_limits field gracefully', () => {
      const schedule = {
        rules: baseRules,
        overrides: [],
        holidays: [],
        timezone: 'America/New_York',
        // no meeting_limits field at all
      };

      const result = computeAvailableSlots({
        schedule,
        eventType: makeEventType(),
        existingBookings: [],
        dateRange: { start: '2026-04-20', end: '2026-04-20' },
        inviteeTimezone: 'America/New_York',
        now: new Date('2026-04-19T00:00:00Z'),
      });

      expect((result['2026-04-20'] || []).length).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// Holiday Enabled/Disabled Tests
// ============================================================

describe('Holiday Enabled Filtering', () => {
  const baseRules = [
    { day: 3, start: '09:00', end: '17:00' }, // Wednesday
  ];

  it('should block day for enabled holiday (enabled=true)', () => {
    const schedule = makeSchedule({
      rules: baseRules,
      holidays: [{ date: '2026-04-22', name: 'Test Holiday', enabled: true }],
    });

    const result = computeAvailableSlots({
      schedule,
      eventType: makeEventType(),
      existingBookings: [],
      dateRange: { start: '2026-04-22', end: '2026-04-22' },
      inviteeTimezone: 'America/New_York',
      now: new Date('2026-04-21T00:00:00Z'),
    });

    expect((result['2026-04-22'] || []).length).toBe(0);
  });

  it('should block day for holiday without enabled field (backward compat)', () => {
    const schedule = makeSchedule({
      rules: baseRules,
      holidays: [{ date: '2026-04-22', name: 'Test Holiday' }], // no enabled field
    });

    const result = computeAvailableSlots({
      schedule,
      eventType: makeEventType(),
      existingBookings: [],
      dateRange: { start: '2026-04-22', end: '2026-04-22' },
      inviteeTimezone: 'America/New_York',
      now: new Date('2026-04-21T00:00:00Z'),
    });

    expect((result['2026-04-22'] || []).length).toBe(0);
  });

  it('should allow day for disabled holiday (enabled=false)', () => {
    const schedule = makeSchedule({
      rules: baseRules,
      holidays: [{ date: '2026-04-22', name: 'Test Holiday', enabled: false }],
    });

    const result = computeAvailableSlots({
      schedule,
      eventType: makeEventType(),
      existingBookings: [],
      dateRange: { start: '2026-04-22', end: '2026-04-22' },
      inviteeTimezone: 'America/New_York',
      now: new Date('2026-04-21T00:00:00Z'),
    });

    // Holiday is disabled, so Wednesday should have slots
    expect((result['2026-04-22'] || []).length).toBeGreaterThan(0);
  });

  it('should handle mix of enabled and disabled holidays', () => {
    const rules = [
      { day: 3, start: '09:00', end: '17:00' }, // Wednesday
      { day: 4, start: '09:00', end: '17:00' }, // Thursday
    ];
    const schedule = makeSchedule({
      rules,
      holidays: [
        { date: '2026-04-22', name: 'Disabled Holiday', enabled: false },
        { date: '2026-04-23', name: 'Enabled Holiday', enabled: true },
      ],
    });

    const result = computeAvailableSlots({
      schedule,
      eventType: makeEventType(),
      existingBookings: [],
      dateRange: { start: '2026-04-22', end: '2026-04-23' },
      inviteeTimezone: 'America/New_York',
      now: new Date('2026-04-21T00:00:00Z'),
    });

    // Wednesday (disabled holiday) should have slots
    expect((result['2026-04-22'] || []).length).toBeGreaterThan(0);
    // Thursday (enabled holiday) should be blocked
    expect((result['2026-04-23'] || []).length).toBe(0);
  });
});
