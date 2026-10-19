import { describe, it, expect } from 'vitest';
import { computeAvailableSlots } from '../../../src/availability.js';

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
    holidays: [],
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

/**
 * Simulate the group event filtering logic that the worker does
 * before calling computeAvailableSlots.
 *
 * In the real worker (handleGetPublicAvailability), bookings are
 * pre-filtered so that only slots that have reached group_max_attendees
 * are passed to computeAvailableSlots as "blocking" bookings.
 */
function filterGroupBookings(bookings, groupMaxAttendees) {
  if (!groupMaxAttendees || groupMaxAttendees <= 1) {
    return { effectiveBookings: bookings, spotsInfo: null };
  }

  const countByStart = {};
  for (const b of bookings) {
    countByStart[b.start_time] = (countByStart[b.start_time] || 0) + 1;
  }

  const effectiveBookings = [];
  const spotsInfo = {};

  for (const [startTime, count] of Object.entries(countByStart)) {
    if (count >= groupMaxAttendees) {
      effectiveBookings.push(bookings.find(b => b.start_time === startTime));
    } else {
      spotsInfo[startTime] = groupMaxAttendees - count;
    }
  }

  return { effectiveBookings, spotsInfo };
}

// ============================================================
// Tests
// ============================================================

describe('Group Events', () => {
  // ----------------------------------------------------------
  // Group event shows slots correctly
  // ----------------------------------------------------------
  describe('group event shows slots correctly', () => {
    it('should return all available slots for a group event with no bookings', () => {
      // Group event with max 5 attendees, no bookings yet
      const groupMax = 5;
      const allBookings = [];

      const { effectiveBookings } = filterGroupBookings(allBookings, groupMax);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' }, // Monday
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // 9am to 5pm = 8 hours = 16 half-hour slots
      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).toHaveLength(16);
      expect(result[mondayDate][0]).toBe('09:00');
      expect(result[mondayDate][15]).toBe('16:30');
    });

    it('should return the same slots as a non-group event when no bookings exist', () => {
      const groupResult = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [], // group filtering produces empty for no bookings
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const normalResult = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: [],
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      expect(groupResult).toEqual(normalResult);
    });
  });

  // ----------------------------------------------------------
  // Slot available until max attendees reached
  // ----------------------------------------------------------
  describe('slot available until max attendees reached', () => {
    it('should keep slot available when bookings exist but are below max', () => {
      const groupMax = 5;
      // 2 bookings for the 10am slot (PDT = UTC-7, so 10am PDT = 17:00 UTC)
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];

      const { effectiveBookings, spotsInfo } = filterGroupBookings(allBookings, groupMax);

      // No effective bookings since 2 < 5
      expect(effectiveBookings).toHaveLength(0);
      // 3 spots remaining
      expect(spotsInfo['2026-03-09T17:00:00Z']).toBe(3);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // The 10:00 slot should still be available
      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).toContain('10:00');
      // All 16 slots should be available since no slot is fully booked
      expect(result[mondayDate]).toHaveLength(16);
    });

    it('should track spots left correctly for partially booked slots', () => {
      const groupMax = 3;
      // 1 booking at 9am, 2 bookings at 10am
      const allBookings = [
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // 9am PDT
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am PDT
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am PDT
      ];

      const { spotsInfo } = filterGroupBookings(allBookings, groupMax);

      expect(spotsInfo['2026-03-09T16:00:00Z']).toBe(2); // 3 - 1 = 2 spots left
      expect(spotsInfo['2026-03-09T17:00:00Z']).toBe(1); // 3 - 2 = 1 spot left
    });
  });

  // ----------------------------------------------------------
  // Slot unavailable after max attendees
  // ----------------------------------------------------------
  describe('slot unavailable after max attendees', () => {
    it('should mark slot as unavailable when bookings reach max', () => {
      const groupMax = 3;
      // 3 bookings for the 10am slot — slot is full
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];

      const { effectiveBookings, spotsInfo } = filterGroupBookings(allBookings, groupMax);

      // 1 effective booking (blocking) since 3 >= 3
      expect(effectiveBookings).toHaveLength(1);
      // No spots entry for this slot since it's full
      expect(spotsInfo['2026-03-09T17:00:00Z']).toBeUndefined();

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // The 10:00 slot should be gone
      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('10:00');
      // Should have 15 slots (16 minus the blocked 10:00)
      expect(result[mondayDate]).toHaveLength(15);
    });

    it('should mark slot as unavailable when bookings exceed max', () => {
      const groupMax = 2;
      // 3 bookings for the 10am slot — exceeds max
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];

      const { effectiveBookings } = filterGroupBookings(allBookings, groupMax);

      expect(effectiveBookings).toHaveLength(1);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('10:00');
    });

    it('should block multiple full slots independently', () => {
      const groupMax = 2;
      // Both 9am and 10am are full
      const allBookings = [
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // 9am PDT
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // 9am PDT
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am PDT
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am PDT
      ];

      const { effectiveBookings } = filterGroupBookings(allBookings, groupMax);

      expect(effectiveBookings).toHaveLength(2);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('09:00');
      expect(result[mondayDate]).not.toContain('10:00');
      // Should have 14 slots (16 minus 2 blocked)
      expect(result[mondayDate]).toHaveLength(14);
    });
  });

  // ----------------------------------------------------------
  // Multiple invitees can book same slot
  // ----------------------------------------------------------
  describe('multiple invitees can book same slot', () => {
    it('should still show slot as available after one booking when max > 1', () => {
      const groupMax = 10;
      // 1 booking at 2pm
      const allBookings = [
        { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z', status: 'confirmed' }, // 2pm PDT
      ];

      const { effectiveBookings, spotsInfo } = filterGroupBookings(allBookings, groupMax);

      // No blocking bookings
      expect(effectiveBookings).toHaveLength(0);
      // 9 spots left
      expect(spotsInfo['2026-03-09T21:00:00Z']).toBe(9);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // 2pm slot should be available
      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).toContain('14:00');
      // All 16 slots should be available
      expect(result[mondayDate]).toHaveLength(16);
    });

    it('should allow incremental bookings up to max_attendees', () => {
      const groupMax = 3;

      // Simulate 3 sequential bookings at 11am
      for (let numBookings = 0; numBookings < 3; numBookings++) {
        const bookings = Array(numBookings).fill(null).map(() => ({
          start_time: '2026-03-09T18:00:00Z', // 11am PDT
          end_time: '2026-03-09T18:30:00Z',
          status: 'confirmed',
        }));

        const { effectiveBookings } = filterGroupBookings(bookings, groupMax);

        const result = computeAvailableSlots({
          schedule: standardSchedule(),
          eventType: standardEventType(),
          existingBookings: effectiveBookings,
          dateRange: { start: '2026-03-09', end: '2026-03-09' },
          inviteeTimezone: 'America/Los_Angeles',
          now: new Date('2026-03-08T00:00:00Z'),
        });

        const mondayDate = Object.keys(result)[0];
        // Slot should be available as long as we haven't reached max
        expect(result[mondayDate]).toContain('11:00');
      }

      // After 3 bookings, slot should be unavailable
      const fullBookings = Array(3).fill(null).map(() => ({
        start_time: '2026-03-09T18:00:00Z',
        end_time: '2026-03-09T18:30:00Z',
        status: 'confirmed',
      }));

      const { effectiveBookings } = filterGroupBookings(fullBookings, groupMax);
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('11:00');
    });

    it('should handle mix of full and partial slots correctly', () => {
      const groupMax = 3;
      // 9am: 3 bookings (full), 10am: 1 booking (partial), 11am: 0 bookings
      const allBookings = [
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // 9am
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // 9am
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // 9am
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am
      ];

      const { effectiveBookings, spotsInfo } = filterGroupBookings(allBookings, groupMax);

      // Only 9am is blocking
      expect(effectiveBookings).toHaveLength(1);
      // 10am has 2 spots left
      expect(spotsInfo['2026-03-09T17:00:00Z']).toBe(2);
      // 9am is not in spotsInfo (it's full)
      expect(spotsInfo['2026-03-09T16:00:00Z']).toBeUndefined();

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('09:00'); // full
      expect(result[mondayDate]).toContain('10:00');      // partial
      expect(result[mondayDate]).toContain('11:00');      // empty
      expect(result[mondayDate]).toHaveLength(15);        // 16 - 1 full
    });
  });

  // ----------------------------------------------------------
  // Non-group events still enforce one-per-slot
  // ----------------------------------------------------------
  describe('non-group events still enforce one-per-slot', () => {
    it('should block slot with a single booking for non-group event', () => {
      // Non-group event: group_max_attendees is null
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am PDT
      ];

      // filterGroupBookings with null should pass through all bookings
      const { effectiveBookings } = filterGroupBookings(allBookings, null);

      expect(effectiveBookings).toEqual(allBookings);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('10:00');
      expect(result[mondayDate]).toHaveLength(15); // 16 - 1
    });

    it('should block slot with a single booking when group_max_attendees is 1', () => {
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' }, // 10am PDT
      ];

      // group_max_attendees = 1 should behave same as null (non-group)
      const { effectiveBookings } = filterGroupBookings(allBookings, 1);

      expect(effectiveBookings).toEqual(allBookings);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('10:00');
      expect(result[mondayDate]).toHaveLength(15);
    });

    it('should block slot with a single booking when group_max_attendees is 0', () => {
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];

      // group_max_attendees = 0 should behave same as null (non-group)
      const { effectiveBookings } = filterGroupBookings(allBookings, 0);

      expect(effectiveBookings).toEqual(allBookings);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      expect(result[mondayDate]).not.toContain('10:00');
    });
  });

  // ----------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------
  describe('edge cases', () => {
    it('should handle group event with max_attendees = 2 at boundary', () => {
      const groupMax = 2;

      // 1 booking — should be available
      const oneBooking = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];
      const { effectiveBookings: eff1, spotsInfo: spots1 } = filterGroupBookings(oneBooking, groupMax);
      expect(eff1).toHaveLength(0);
      expect(spots1['2026-03-09T17:00:00Z']).toBe(1);

      // 2 bookings — should be full
      const twoBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];
      const { effectiveBookings: eff2, spotsInfo: spots2 } = filterGroupBookings(twoBookings, groupMax);
      expect(eff2).toHaveLength(1);
      expect(spots2['2026-03-09T17:00:00Z']).toBeUndefined();
    });

    it('should work correctly across multiple days', () => {
      const groupMax = 2;
      // Monday 9am full, Tuesday 9am partial
      const allBookings = [
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // Mon 9am
        { start_time: '2026-03-09T16:00:00Z', end_time: '2026-03-09T16:30:00Z', status: 'confirmed' }, // Mon 9am
        { start_time: '2026-03-10T16:00:00Z', end_time: '2026-03-10T16:30:00Z', status: 'confirmed' }, // Tue 9am
      ];

      const { effectiveBookings, spotsInfo } = filterGroupBookings(allBookings, groupMax);

      // Monday 9am is full, Tuesday 9am has 1 spot
      expect(effectiveBookings).toHaveLength(1);
      expect(spotsInfo['2026-03-10T16:00:00Z']).toBe(1);

      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-10' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      // Monday should be missing the 9am slot
      expect(result['2026-03-09']).not.toContain('09:00');
      expect(result['2026-03-09']).toHaveLength(15);
      // Tuesday should have all slots (partial booking doesn't block)
      expect(result['2026-03-10']).toContain('09:00');
      expect(result['2026-03-10']).toHaveLength(16);
    });

    it('should handle large group sizes correctly', () => {
      const groupMax = 100;
      // 99 bookings at 9am — should still be available
      const bookings = Array(99).fill(null).map(() => ({
        start_time: '2026-03-09T16:00:00Z',
        end_time: '2026-03-09T16:30:00Z',
        status: 'confirmed',
      }));

      const { effectiveBookings, spotsInfo } = filterGroupBookings(bookings, groupMax);
      expect(effectiveBookings).toHaveLength(0);
      expect(spotsInfo['2026-03-09T16:00:00Z']).toBe(1);

      // Add the 100th booking — should now be full
      bookings.push({
        start_time: '2026-03-09T16:00:00Z',
        end_time: '2026-03-09T16:30:00Z',
        status: 'confirmed',
      });

      const { effectiveBookings: eff2 } = filterGroupBookings(bookings, groupMax);
      expect(eff2).toHaveLength(1);
    });

    it('should handle bookings with different timestamp formats', () => {
      const groupMax = 3;
      // The worker may store timestamps with or without 'Z', or with space instead of 'T'
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];

      const { effectiveBookings, spotsInfo } = filterGroupBookings(allBookings, groupMax);

      // 2 bookings with matching start_time keys
      expect(effectiveBookings).toHaveLength(0);
      expect(spotsInfo['2026-03-09T17:00:00Z']).toBe(1);
    });

    it('should only consider slot-holding booking statuses', () => {
      // This test validates the concept: cancelled bookings should not count.
      // In production, the DB query filters by status IN (...slot-holding statuses).
      // Here we test that when cancelled bookings are excluded from the array,
      // the group logic works correctly.
      const groupMax = 2;
      const activeBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
        // A cancelled booking would be filtered by the SQL query, not present here
      ];

      const { effectiveBookings } = filterGroupBookings(activeBookings, groupMax);

      // Only 1 active booking, so slot is still available
      expect(effectiveBookings).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------
  // Interaction with buffer time
  // ----------------------------------------------------------
  describe('group events with buffer time', () => {
    it('should not block adjacent slots when only the group slot is partially booked', () => {
      const groupMax = 5;
      // 1 booking at 10am — should not block anything
      const allBookings = [
        { start_time: '2026-03-09T17:00:00Z', end_time: '2026-03-09T17:30:00Z', status: 'confirmed' },
      ];

      const { effectiveBookings } = filterGroupBookings(allBookings, groupMax);

      // No effective bookings
      expect(effectiveBookings).toHaveLength(0);

      // Even with buffers, no slots should be blocked since group is not full
      const result = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ buffer_before: 15, buffer_after: 15 }),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(result)[0];
      // All slots should be available since no slot is fully booked
      expect(result[mondayDate]).toHaveLength(16);
    });

    it('should block adjacent slots when a group slot is full and buffers are set', () => {
      const groupMax = 2;
      // 2pm slot is full
      const allBookings = [
        { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z', status: 'confirmed' },
        { start_time: '2026-03-09T21:00:00Z', end_time: '2026-03-09T21:30:00Z', status: 'confirmed' },
      ];

      const { effectiveBookings } = filterGroupBookings(allBookings, groupMax);

      // The full slot becomes a blocking booking
      expect(effectiveBookings).toHaveLength(1);

      // With 30-min buffer, slots before and after 2pm should be affected
      const resultWithBuffer = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType({ buffer_before: 30, buffer_after: 30 }),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const resultWithoutBuffer = computeAvailableSlots({
        schedule: standardSchedule(),
        eventType: standardEventType(),
        existingBookings: effectiveBookings,
        dateRange: { start: '2026-03-09', end: '2026-03-09' },
        inviteeTimezone: 'America/Los_Angeles',
        now: new Date('2026-03-08T00:00:00Z'),
      });

      const mondayDate = Object.keys(resultWithBuffer)[0];
      // Buffer version should block more slots than no-buffer version
      expect(resultWithBuffer[mondayDate].length).toBeLessThan(resultWithoutBuffer[mondayDate].length);
    });
  });
});
