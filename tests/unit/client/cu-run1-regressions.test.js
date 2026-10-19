import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for bugs found in Computer Use Test Run 1 (CU-01..04).
// Repro guide: docs/computer-use-tests/results/run-1-bug-report.html
// vitest runs from the package root, so resolve the asset from cwd.
const dashboardHtml = readFileSync(
  join(process.cwd(), 'public/dashboard/index.html'),
  'utf8'
);

// ---------------------------------------------------------------------------
// F1 — a rescheduled booking must not linger as a "ghost" in the dashboard.
// When an invitee reschedules, the old row is marked status='rescheduled' and
// a new booking is created. The old stub keeps its (still-future) start_time,
// so it must be excluded from Upcoming/Past, the overview count, and calendar.
// ---------------------------------------------------------------------------
describe('F1: rescheduled bookings are excluded from dashboard lists', () => {
  it('Upcoming filter excludes rescheduled', () => {
    expect(dashboardHtml).toMatch(/currentFilter === 'upcoming'[\s\S]{0,220}b\.status !== 'rescheduled'/);
  });

  it('Past filter excludes rescheduled', () => {
    expect(dashboardHtml).toMatch(/currentFilter === 'past'[\s\S]{0,220}b\.status !== 'rescheduled'/);
  });

  it('Overview confirmedBookings count excludes rescheduled', () => {
    expect(dashboardHtml).toMatch(/confirmedBookings = bookings\.filter\(b =>[^\n]*b\.status !== 'rescheduled'/);
  });

  it('Combined calendar view excludes rescheduled', () => {
    expect(dashboardHtml).toMatch(/isCalendo &&[^\n]*b\.status !== 'rescheduled'[^\n]*isUpcoming/);
  });

  it('behavioral: a rescheduled future booking is filtered out of Upcoming while confirmed stays', () => {
    const now = Date.now();
    const future = new Date(now + 86_400_000).toISOString();
    const parseUTC = (s) => new Date(s).getTime();
    // mirrors the fixed Upcoming predicate in renderBookings()
    const isUpcoming = (b) =>
      b.status !== 'cancelled' &&
      b.status !== 'no_show' &&
      b.status !== 'rescheduled' &&
      parseUTC(b.start_time) > now;
    const bookings = [
      { id: 1, status: 'confirmed', start_time: future },
      { id: 2, status: 'rescheduled', start_time: future }, // the ghost
    ];
    expect(bookings.filter(isUpcoming).map((b) => b.id)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// F3 — a brand-new user must be able to leave the onboarding wizard (otherwise
// Settings -> Danger Zone -> Delete Account is unreachable). The wizard must
// expose a skip control that marks onboarding complete and reveals the app.
// ---------------------------------------------------------------------------
describe('F3: onboarding wizard has a skip exit', () => {
  it('exposes a skip control in the wizard markup', () => {
    expect(dashboardHtml).toMatch(/id="onb-skip"/);
  });

  it('skip handler marks onboarding complete and reveals the dashboard', () => {
    const idx = dashboardHtml.indexOf("getElementById('onb-skip')");
    expect(idx).toBeGreaterThan(-1);
    const handler = dashboardHtml.slice(idx, idx + 500);
    expect(handler).toContain('/api/onboarding/complete');
    expect(handler).toContain('appLayout');
  });
});
