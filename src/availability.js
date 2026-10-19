// Calendo - Availability Engine
// Pure ES module for computing available time slots
// Uses only APIs available in Cloudflare Workers (Intl.DateTimeFormat for timezone handling)

// ============================================================
// Timezone Utilities (using Intl API only — no external libraries)
// ============================================================

/**
 * Get the parts of a date in a specific timezone.
 * Returns { year, month, day, hour, minute, weekday }
 */
function getPartsInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    parts[type] = value;
  }

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour === '24' ? '0' : parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    weekday: weekdayMap[parts.weekday],
  };
}

/**
 * Get the UTC offset in minutes for a timezone at a given instant.
 * Positive means ahead of UTC (e.g., UTC+5:30 = 330).
 */
function getUtcOffsetMinutes(date, timezone) {
  const utcParts = getPartsInTimezone(date, 'UTC');
  const tzParts = getPartsInTimezone(date, timezone);

  // Build comparable minute-of-epoch values
  const utcMinutes =
    Date.UTC(utcParts.year, utcParts.month - 1, utcParts.day, utcParts.hour, utcParts.minute) / 60000;
  const tzMinutes =
    Date.UTC(tzParts.year, tzParts.month - 1, tzParts.day, tzParts.hour, tzParts.minute) / 60000;

  return tzMinutes - utcMinutes;
}

/**
 * Given a date string like "2026-03-15" and a time string like "09:00",
 * interpret them as being in the given timezone and return a UTC Date object.
 */
export function dateTimeInTimezoneToUtc(dateStr, timeStr, timezone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);

  // Create a rough UTC date first
  const roughUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // Get the offset at that rough time
  const offset = getUtcOffsetMinutes(roughUtc, timezone);

  // Adjust: if timezone is UTC+offset, then UTC = local - offset
  const utcMs = roughUtc.getTime() - offset * 60000;
  const result = new Date(utcMs);

  // Due to DST transitions, the offset might differ at the actual UTC time.
  // Re-check and correct if needed.
  const correctedOffset = getUtcOffsetMinutes(result, timezone);
  if (correctedOffset !== offset) {
    return new Date(roughUtc.getTime() - correctedOffset * 60000);
  }

  return result;
}

/**
 * Format a UTC Date as "HH:MM" in the given timezone.
 */
function formatTimeInTimezone(date, timezone) {
  const parts = getPartsInTimezone(date, timezone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * Format a UTC Date as "YYYY-MM-DD" in the given timezone.
 */
function formatDateInTimezone(date, timezone) {
  const parts = getPartsInTimezone(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseStoredUtcDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (!value) return new Date(NaN);

  let normalized = String(value).trim();
  if (normalized.includes(' ') && !normalized.includes('T')) {
    normalized = normalized.replace(' ', 'T');
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    normalized += 'Z';
  }

  return new Date(normalized);
}

/**
 * Generate an array of date strings (YYYY-MM-DD) from start to end inclusive.
 */
function getDateRange(startDate, endDate) {
  const dates = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);

  const start = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));

  const current = new Date(start);
  while (current <= end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, '0');
    const d = String(current.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

// ============================================================
// Core Availability Computation
// ============================================================

/**
 * Compute available time slots for booking.
 *
 * @param {Object} params
 * @param {Object} params.schedule - Availability schedule with rules, overrides, timezone
 * @param {Object} params.eventType - Event type config (duration, buffers, limits)
 * @param {Array} params.existingBookings - Array of {start_time, end_time} in ISO 8601 UTC
 * @param {Object} params.dateRange - {start: "YYYY-MM-DD", end: "YYYY-MM-DD"}
 * @param {string} params.inviteeTimezone - IANA timezone for the invitee
 * @param {Date} [params.now] - Current time (for testing; defaults to new Date())
 *
 * @returns {Object} Slots grouped by date in invitee timezone: { "2026-03-10": ["09:00", "09:30", ...], ... }
 */
export function computeAvailableSlots({
  schedule,
  eventType,
  existingBookings,
  dateRange,
  inviteeTimezone,
  now = new Date(),
}) {
  const {
    rules = [],
    overrides = [],
    holidays = [],
    timezone: scheduleTz,
    meeting_limits: rawMeetingLimits,
  } = schedule;

  // Parse meeting limits
  let meetingLimits = [];
  try {
    meetingLimits = typeof rawMeetingLimits === 'string' ? JSON.parse(rawMeetingLimits) : (rawMeetingLimits || []);
  } catch (e) {
    meetingLimits = [];
  }

  const {
    duration_minutes: duration,
    buffer_before = 0,
    buffer_after = 0,
    min_notice_hours = 4,
    max_future_days = 60,
    max_bookings_per_day = null,
    slot_interval = 15,
  } = eventType;

  // Step size for generating slot start times (in minutes)
  const step = slot_interval || 15;

  // Parse existing bookings into Date objects once
  const bookings = existingBookings.map((b) => ({
    start: parseStoredUtcDate(b.start_time),
    end: parseStoredUtcDate(b.end_time),
    status: b.status || 'confirmed',
  }));

  // Compute max future date cutoff (in schedule timezone calendar days)
  const maxDateObj = new Date(now.getTime() + max_future_days * 24 * 60 * 60 * 1000);
  const maxDateStr = formatDateInTimezone(maxDateObj, scheduleTz);

  // Min notice cutoff
  const minNoticeDate = new Date(now.getTime() + min_notice_hours * 60 * 60 * 1000);

  // Build override lookup by date string
  const overrideMap = {};
  for (const override of overrides) {
    overrideMap[override.date] = override;
  }
  // Holidays block entire days (lower priority than explicit overrides)
  for (const holiday of holidays) {
    if (holiday.date && holiday.enabled !== false && !overrideMap[holiday.date]) {
      overrideMap[holiday.date] = { date: holiday.date, available: false };
    }
  }

  // Iterate over each date in the requested range
  const dates = getDateRange(dateRange.start, dateRange.end);
  const slotsByUtc = []; // collect all slot UTC times, then group by invitee date

  for (const dateStr of dates) {
    // Get day-of-week in the schedule timezone for this date
    const noonUtc = dateTimeInTimezoneToUtc(dateStr, '12:00', scheduleTz);
    const scheduleParts = getPartsInTimezone(noonUtc, scheduleTz);
    const dayOfWeek = scheduleParts.weekday;

    // Check if this date is beyond max_future_days
    if (dateStr > maxDateStr) {
      continue;
    }

    // Check for date-specific override
    const override = overrideMap[dateStr];

    let windows = [];

    if (override) {
      if (override.available === false) {
        // Day is blocked entirely
        continue;
      }
      // Override with custom hours
      if (override.start && override.end) {
        windows = [{ start: override.start, end: override.end }];
      }
    } else {
      // Use regular weekly rules for this day
      windows = rules
        .filter((rule) => rule.day === dayOfWeek)
        .map((rule) => ({ start: rule.start, end: rule.end }));
    }

    if (windows.length === 0) {
      continue;
    }

    // Count confirmed bookings for this day (for max_bookings_per_day)
    let confirmedCountForDay = 0;
    if (max_bookings_per_day !== null) {
      for (const booking of bookings) {
        const bookingDate = formatDateInTimezone(booking.start, scheduleTz);
        if (bookingDate === dateStr && booking.status === 'confirmed') {
          confirmedCountForDay++;
        }
      }
      if (confirmedCountForDay >= max_bookings_per_day) {
        continue;
      }
    }

    // Check schedule-level meeting limits (daily/weekly)
    const dailyLimit = meetingLimits.find(l => l.type === 'daily');
    const weeklyLimit = meetingLimits.find(l => l.type === 'weekly');

    if (dailyLimit) {
      let dayCount = 0;
      for (const booking of bookings) {
        const bookingDate = formatDateInTimezone(booking.start, scheduleTz);
        if (bookingDate === dateStr && booking.status === 'confirmed') {
          dayCount++;
        }
      }
      if (dayCount >= dailyLimit.max) {
        continue;
      }
    }

    if (weeklyLimit) {
      // Get ISO week boundaries for this date (Mon-Sun)
      const dateParts = dateStr.split('-').map(Number);
      const dateObj = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], 12, 0, 0));
      const dayOfWeekISO = dateObj.getUTCDay() || 7; // 1=Mon..7=Sun
      const weekStart = new Date(dateObj);
      weekStart.setUTCDate(dateObj.getUTCDate() - dayOfWeekISO + 1);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
      const weekStartStr = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth()+1).padStart(2,'0')}-${String(weekStart.getUTCDate()).padStart(2,'0')}`;
      const weekEndStr = `${weekEnd.getUTCFullYear()}-${String(weekEnd.getUTCMonth()+1).padStart(2,'0')}-${String(weekEnd.getUTCDate()).padStart(2,'0')}`;

      let weekCount = 0;
      for (const booking of bookings) {
        const bookingDate = formatDateInTimezone(booking.start, scheduleTz);
        if (bookingDate >= weekStartStr && bookingDate <= weekEndStr && booking.status === 'confirmed') {
          weekCount++;
        }
      }
      if (weekCount >= weeklyLimit.max) {
        continue;
      }
    }

    const remainingSlots = Infinity; // Show all slots; enforce max at booking time

    let slotsAddedForDay = 0;

    // Generate slots for each availability window
    for (const window of windows) {
      const windowStartUtc = dateTimeInTimezoneToUtc(dateStr, window.start, scheduleTz);
      const windowEndUtc = dateTimeInTimezoneToUtc(dateStr, window.end, scheduleTz);

      // Generate slot candidates at slot_interval intervals
      let slotStartUtc = new Date(windowStartUtc);

      while (slotStartUtc < windowEndUtc) {
        if (slotsAddedForDay >= remainingSlots) break;

        const slotEndUtc = new Date(slotStartUtc.getTime() + duration * 60000);

        // Slot must fit within the window
        if (slotEndUtc > windowEndUtc) break;

        // Check min notice
        if (slotStartUtc < minNoticeDate) {
          slotStartUtc = new Date(slotStartUtc.getTime() + step * 60000);
          continue;
        }

        // Check conflicts with existing bookings (including buffer)
        const bufferedStart = new Date(slotStartUtc.getTime() - buffer_before * 60000);
        const bufferedEnd = new Date(slotEndUtc.getTime() + buffer_after * 60000);

        let hasConflict = false;
        for (const booking of bookings) {
          // Two intervals overlap if one starts before the other ends and vice versa
          if (bufferedStart < booking.end && bufferedEnd > booking.start) {
            hasConflict = true;
            break;
          }
        }

        if (!hasConflict) {
          slotsByUtc.push(slotStartUtc);
          slotsAddedForDay++;
        }

        // Move to next slot (advance by slot_interval, not duration)
        slotStartUtc = new Date(slotStartUtc.getTime() + step * 60000);
      }
    }
  }

  // Group slots by invitee's local date and format times
  const result = {};
  for (const slotUtc of slotsByUtc) {
    const inviteeDate = formatDateInTimezone(slotUtc, inviteeTimezone);
    const inviteeTime = formatTimeInTimezone(slotUtc, inviteeTimezone);

    if (!result[inviteeDate]) {
      result[inviteeDate] = [];
    }
    result[inviteeDate].push(inviteeTime);
  }

  return result;
}

// ============================================================
// Team Availability Computation
// ============================================================

/**
 * Compute available time slots for team scheduling (round-robin or collective).
 *
 * @param {Object} params
 * @param {Array} params.members - Array of { userId, schedule, existingBookings }
 *   - schedule: { rules, overrides, timezone }
 *   - existingBookings: Array of { start_time, end_time, status }
 * @param {Object} params.eventType - Event type config (duration, buffers, limits, round_robin_mode)
 * @param {Object} params.dateRange - { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
 * @param {string} params.inviteeTimezone - IANA timezone for the invitee
 * @param {Date} [params.now] - Current time (for testing; defaults to new Date())
 *
 * @returns {Object} Slots grouped by date in invitee timezone: { "2026-03-10": ["09:00", "09:30", ...], ... }
 */
export function computeTeamAvailableSlots({
  members,
  eventType,
  dateRange,
  inviteeTimezone,
  now = new Date(),
}) {
  const mode = eventType.round_robin_mode; // 'round-robin' or 'collective'

  // Filter out skipped members and those who hit daily cap for round-robin
  const eligibleMembers = mode === 'round-robin'
    ? members.filter(m => !m.skip)
    : members;

  // Compute individual availability for each eligible member
  const memberSlots = eligibleMembers.map((member) => {
    return computeAvailableSlots({
      schedule: member.schedule,
      eventType,
      existingBookings: member.existingBookings,
      dateRange,
      inviteeTimezone,
      now,
    });
  });

  if (mode === 'round-robin') {
    // UNION: a slot is available if ANY member is free
    return unionSlots(memberSlots);
  } else {
    // COLLECTIVE: a slot is available only if ALL members are free
    return intersectSlots(memberSlots);
  }
}

/**
 * Union of multiple members' slot sets.
 * A slot appears in the result if it exists in ANY member's slots.
 */
function unionSlots(memberSlots) {
  const result = {};
  for (const slots of memberSlots) {
    for (const [date, times] of Object.entries(slots)) {
      if (!result[date]) {
        result[date] = new Set();
      }
      for (const time of times) {
        result[date].add(time);
      }
    }
  }
  // Convert Sets to sorted arrays
  const final = {};
  for (const [date, timeSet] of Object.entries(result)) {
    final[date] = Array.from(timeSet).sort();
  }
  return final;
}

/**
 * Intersection of multiple members' slot sets.
 * A slot appears in the result only if it exists in ALL members' slots.
 */
function intersectSlots(memberSlots) {
  if (memberSlots.length === 0) return {};

  // Start with the first member's slots
  const first = memberSlots[0];
  const result = {};

  for (const [date, times] of Object.entries(first)) {
    const commonTimes = times.filter((time) => {
      return memberSlots.every((slots) => {
        const dateTimes = slots[date];
        return dateTimes && dateTimes.includes(time);
      });
    });
    if (commonTimes.length > 0) {
      result[date] = commonTimes;
    }
  }

  return result;
}

/**
 * Pick the least-booked available member for a round-robin assignment.
 * Supports priority weighting and skip rules.
 *
 * @param {Array} members - Array of { userId, schedule, existingBookings, recentBookingCount, weight, skip, maxDaily, todayBookingCount }
 * @param {string} slotStartTime - ISO 8601 UTC start time of the booked slot
 * @param {Object} eventType - Event type config
 * @param {Date} [now] - Current time
 * @returns {number|null} userId of the assigned member, or null if none available
 */
export function pickRoundRobinMember({
  members,
  slotStartTime,
  eventType,
  now = new Date(),
}) {
  const slotStart = new Date(slotStartTime);
  const slotEnd = new Date(slotStart.getTime() + eventType.duration_minutes * 60000);
  const bufferBefore = eventType.buffer_before || 0;
  const bufferAfter = eventType.buffer_after || 0;

  // Find which members are actually available at this specific time
  const availableMembers = members.filter((member) => {
    // Skip members marked as skip
    if (member.skip) return false;

    // Check daily cap
    if (member.maxDaily && (member.todayBookingCount || 0) >= member.maxDaily) return false;

    const bookings = member.existingBookings.map((b) => ({
      start: parseStoredUtcDate(b.start_time),
      end: parseStoredUtcDate(b.end_time),
    }));

    const bufferedStart = new Date(slotStart.getTime() - bufferBefore * 60000);
    const bufferedEnd = new Date(slotEnd.getTime() + bufferAfter * 60000);

    for (const booking of bookings) {
      if (bufferedStart < booking.end && bufferedEnd > booking.start) {
        return false;
      }
    }
    return true;
  });

  if (availableMembers.length === 0) return null;

  // Sort by weighted booking ratio: fewer bookings relative to weight = higher priority
  // ratio = recentBookingCount / weight (lower ratio = should get more bookings)
  availableMembers.sort((a, b) => {
    const weightA = a.weight || 1;
    const weightB = b.weight || 1;
    const ratioA = (a.recentBookingCount || 0) / weightA;
    const ratioB = (b.recentBookingCount || 0) / weightB;
    const diff = ratioA - ratioB;
    if (Math.abs(diff) > 0.001) return diff;
    return a.userId - b.userId;
  });

  return availableMembers[0].userId;
}

/**
 * Convert a human-readable name to a URL-friendly slug.
 * "30 Minute Meeting" -> "30-minute-meeting"
 */
export function generateSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
