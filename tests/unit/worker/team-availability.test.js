import { describe, it, expect } from 'vitest';
import { computeTeamAvailableSlots, computeAvailableSlots, pickRoundRobinMember } from '../../../src/availability.js';

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

/** Morning-only schedule (9am-12pm) */
function morningSchedule() {
  return {
    rules: [
      { day: 1, start: '09:00', end: '12:00' },
      { day: 2, start: '09:00', end: '12:00' },
      { day: 3, start: '09:00', end: '12:00' },
      { day: 4, start: '09:00', end: '12:00' },
      { day: 5, start: '09:00', end: '12:00' },
    ],
    overrides: [],
    timezone: 'America/Los_Angeles',
  };
}

/** Afternoon-only schedule (13pm-17pm) */
function afternoonSchedule() {
  return {
    rules: [
      { day: 1, start: '13:00', end: '17:00' },
      { day: 2, start: '13:00', end: '17:00' },
      { day: 3, start: '13:00', end: '17:00' },
      { day: 4, start: '13:00', end: '17:00' },
      { day: 5, start: '13:00', end: '17:00' },
    ],
    overrides: [],
    timezone: 'America/Los_Angeles',
  };
}

/** Standard 30-min event type for team scheduling */
function teamEventType(mode, overrides = {}) {
  return {
    duration_minutes: 30,
    buffer_before: 0,
    buffer_after: 0,
    min_notice_hours: 4,
    max_future_days: 60,
    max_bookings_per_day: null,
    round_robin_mode: mode,
    slot_interval: 30,
    ...overrides,
  };
}

// ============================================================
// Tests: computeTeamAvailableSlots - Round Robin (Union)
// ============================================================

describe('computeTeamAvailableSlots - round-robin (union)', () => {
  it('should return union of all members availabilities', () => {
    // Alice: morning only (9-12), Bob: afternoon only (13-17)
    // Union should cover 9-12 + 13-17
    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: morningSchedule(), existingBookings: [] },
        { userId: 2, schedule: afternoonSchedule(), existingBookings: [] },
      ],
      eventType: teamEventType('round-robin'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    // Morning: 9-12 = 6 slots, Afternoon: 13-17 = 8 slots
    expect(slots).toHaveLength(14);
    expect(slots).toContain('09:00');
    expect(slots).toContain('11:30');
    expect(slots).toContain('13:00');
    expect(slots).toContain('16:30');
    // Gap hour should NOT be present
    expect(slots).not.toContain('12:00');
    expect(slots).not.toContain('12:30');
  });

  it('should include a slot if ANY member is free (even if others are busy)', () => {
    // Alice: 9-17 with booking at 10:00-10:30
    // Bob: 9-17 with no bookings
    // The 10:00 slot should still be available (Bob is free)
    const result = computeTeamAvailableSlots({
      members: [
        {
          userId: 1,
          schedule: standardSchedule(),
          existingBookings: [
            { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z' }, // 10:00 PDT
          ],
        },
        {
          userId: 2,
          schedule: standardSchedule(),
          existingBookings: [],
        },
      ],
      eventType: teamEventType('round-robin'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    // All 16 slots should be available because Bob has no bookings
    expect(slots).toHaveLength(16);
    expect(slots).toContain('10:00');
  });

  it('should return no slots only when ALL members are unavailable at a time', () => {
    // Both Alice and Bob have morning-only schedules
    // No afternoon slots should appear
    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: morningSchedule(), existingBookings: [] },
        { userId: 2, schedule: morningSchedule(), existingBookings: [] },
      ],
      eventType: teamEventType('round-robin'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    // 9-12 = 6 slots (union of identical schedules = same 6 slots, no duplicates)
    expect(slots).toHaveLength(6);
    expect(slots).not.toContain('13:00');
    expect(slots).not.toContain('16:00');
  });

  it('should handle overlapping availability windows correctly (no duplicate slots)', () => {
    // Both have standard 9-5 schedules, no bookings
    // Union should still yield 16 unique slots
    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: standardSchedule(), existingBookings: [] },
        { userId: 2, schedule: standardSchedule(), existingBookings: [] },
      ],
      eventType: teamEventType('round-robin'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(16);
  });

  it('should return empty when no members provided', () => {
    const result = computeTeamAvailableSlots({
      members: [],
      eventType: teamEventType('round-robin'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(0);
  });
});

// ============================================================
// Tests: computeTeamAvailableSlots - Collective (Intersection)
// ============================================================

describe('computeTeamAvailableSlots - collective (intersection)', () => {
  it('should return only slots where ALL members are available', () => {
    // Alice: 9-12, Bob: 10-15
    // Intersection: 10:00, 10:30, 11:00, 11:30 (10-12 range, 4 slots)
    const aliceSchedule = {
      rules: [{ day: 1, start: '09:00', end: '12:00' }],
      overrides: [],
      timezone: 'America/Los_Angeles',
    };
    const bobSchedule = {
      rules: [{ day: 1, start: '10:00', end: '15:00' }],
      overrides: [],
      timezone: 'America/Los_Angeles',
    };

    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: aliceSchedule, existingBookings: [] },
        { userId: 2, schedule: bobSchedule, existingBookings: [] },
      ],
      eventType: teamEventType('collective'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(4);
    expect(slots).toContain('10:00');
    expect(slots).toContain('10:30');
    expect(slots).toContain('11:00');
    expect(slots).toContain('11:30');
    // Alice-only slots
    expect(slots).not.toContain('09:00');
    expect(slots).not.toContain('09:30');
    // Bob-only slots
    expect(slots).not.toContain('12:00');
    expect(slots).not.toContain('14:00');
  });

  it('should return no slots when members have non-overlapping schedules', () => {
    // Alice: morning only, Bob: afternoon only
    // No overlap
    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: morningSchedule(), existingBookings: [] },
        { userId: 2, schedule: afternoonSchedule(), existingBookings: [] },
      ],
      eventType: teamEventType('collective'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(0);
  });

  it('should exclude slots where any member has a booking conflict', () => {
    // Both have 9-17, but Alice has a booking at 10:00-10:30
    // 10:00 slot should be excluded from collective availability
    const result = computeTeamAvailableSlots({
      members: [
        {
          userId: 1,
          schedule: standardSchedule(),
          existingBookings: [
            { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z' }, // 10:00 PDT
          ],
        },
        {
          userId: 2,
          schedule: standardSchedule(),
          existingBookings: [],
        },
      ],
      eventType: teamEventType('collective'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    // 16 normal - 1 conflict = 15
    expect(slots).toHaveLength(15);
    expect(slots).not.toContain('10:00');
    expect(slots).toContain('09:00');
    expect(slots).toContain('10:30');
  });

  it('should handle identical schedules correctly', () => {
    // Both have the same standard schedule, no bookings
    // Intersection = full schedule
    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: standardSchedule(), existingBookings: [] },
        { userId: 2, schedule: standardSchedule(), existingBookings: [] },
      ],
      eventType: teamEventType('collective'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(16);
  });

  it('should handle three members correctly', () => {
    // Alice: 9-14, Bob: 10-15, Charlie: 11-17
    // Intersection: 11-14 = 11:00, 11:30, 12:00, 12:30, 13:00, 13:30 = 6 slots
    const aliceSchedule = {
      rules: [{ day: 1, start: '09:00', end: '14:00' }],
      overrides: [],
      timezone: 'America/Los_Angeles',
    };
    const bobSchedule = {
      rules: [{ day: 1, start: '10:00', end: '15:00' }],
      overrides: [],
      timezone: 'America/Los_Angeles',
    };
    const charlieSchedule = {
      rules: [{ day: 1, start: '11:00', end: '17:00' }],
      overrides: [],
      timezone: 'America/Los_Angeles',
    };

    const result = computeTeamAvailableSlots({
      members: [
        { userId: 1, schedule: aliceSchedule, existingBookings: [] },
        { userId: 2, schedule: bobSchedule, existingBookings: [] },
        { userId: 3, schedule: charlieSchedule, existingBookings: [] },
      ],
      eventType: teamEventType('collective'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(6);
    expect(slots[0]).toBe('11:00');
    expect(slots[5]).toBe('13:30');
  });

  it('should return empty when no members provided', () => {
    const result = computeTeamAvailableSlots({
      members: [],
      eventType: teamEventType('collective'),
      dateRange: { start: '2026-03-09', end: '2026-03-09' },
      inviteeTimezone: 'America/Los_Angeles',
      now: new Date('2026-03-08T00:00:00Z'),
    });

    const slots = Object.values(result).flat();
    expect(slots).toHaveLength(0);
  });
});

// ============================================================
// Tests: pickRoundRobinMember (least-booked assignment)
// ============================================================

describe('pickRoundRobinMember', () => {
  const eventType = {
    duration_minutes: 30,
    buffer_before: 0,
    buffer_after: 0,
  };

  it('should assign to the member with fewest recent bookings', () => {
    const result = pickRoundRobinMember({
      members: [
        { userId: 1, existingBookings: [], recentBookingCount: 5 },
        { userId: 2, existingBookings: [], recentBookingCount: 2 },
        { userId: 3, existingBookings: [], recentBookingCount: 8 },
      ],
      slotStartTime: '2026-03-09T17:00:00Z', // 10:00 PDT
      eventType,
    });

    expect(result).toBe(2); // fewest bookings
  });

  it('should break ties by lowest userId', () => {
    const result = pickRoundRobinMember({
      members: [
        { userId: 3, existingBookings: [], recentBookingCount: 5 },
        { userId: 1, existingBookings: [], recentBookingCount: 5 },
        { userId: 2, existingBookings: [], recentBookingCount: 5 },
      ],
      slotStartTime: '2026-03-09T17:00:00Z',
      eventType,
    });

    expect(result).toBe(1); // lowest userId among ties
  });

  it('should skip members who have a conflict at the booked time', () => {
    const result = pickRoundRobinMember({
      members: [
        {
          userId: 1,
          existingBookings: [
            { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z' }, // conflict
          ],
          recentBookingCount: 0,
        },
        {
          userId: 2,
          existingBookings: [],
          recentBookingCount: 3,
        },
      ],
      slotStartTime: '2026-03-09T17:00:00Z',
      eventType,
    });

    // User 1 has fewer bookings but is busy, so User 2 gets assigned
    expect(result).toBe(2);
  });

  it('should return null when no members are available', () => {
    const result = pickRoundRobinMember({
      members: [
        {
          userId: 1,
          existingBookings: [
            { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z' },
          ],
          recentBookingCount: 0,
        },
        {
          userId: 2,
          existingBookings: [
            { start_time: '2026-03-09T16:45:00Z', end_time: '2026-03-09T17:15:00Z' },
          ],
          recentBookingCount: 0,
        },
      ],
      slotStartTime: '2026-03-09T17:00:00Z',
      eventType,
    });

    expect(result).toBeNull();
  });

  it('should respect buffer times when checking conflicts', () => {
    const eventTypeWithBuffer = {
      duration_minutes: 30,
      buffer_before: 15,
      buffer_after: 15,
    };

    // Member 1 has a booking ending at 16:50. With 15-min buffer_before on the new slot
    // at 17:00, the buffered start = 16:45. 16:45 < 16:50 (booking end), so conflict.
    const result = pickRoundRobinMember({
      members: [
        {
          userId: 1,
          existingBookings: [
            { start_time: '2026-03-09T16:20:00Z', end_time: '2026-03-09T16:50:00Z' },
          ],
          recentBookingCount: 0,
        },
        {
          userId: 2,
          existingBookings: [],
          recentBookingCount: 5,
        },
      ],
      slotStartTime: '2026-03-09T17:00:00Z',
      eventType: eventTypeWithBuffer,
    });

    expect(result).toBe(2); // member 1 has buffer conflict
  });

  it('should handle empty members array', () => {
    const result = pickRoundRobinMember({
      members: [],
      slotStartTime: '2026-03-09T17:00:00Z',
      eventType,
    });

    expect(result).toBeNull();
  });

  it('should assign to single available member even if they have many bookings', () => {
    const result = pickRoundRobinMember({
      members: [
        { userId: 1, existingBookings: [], recentBookingCount: 100 },
      ],
      slotStartTime: '2026-03-09T17:00:00Z',
      eventType,
    });

    expect(result).toBe(1);
  });
});
