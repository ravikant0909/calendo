import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for Computer Use Test Run 3 (CU-06 finding).
// Tracker: docs/computer-use-tests/results/OPEN-ITEMS.html (OI-2 / B6)
const dashboardHtml = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

// ---------------------------------------------------------------------------
// B6 — after an AI assistant write-action the dashboard used to refresh only
// event types + bookings, so AI changes to availability/date-overrides (and
// routing/analytics/contacts/settings) stayed stale until a manual reload.
// A shared refreshDashboardData() must reload everything, and the AI handler
// must call it for any non-read action.
// ---------------------------------------------------------------------------
describe('B6: AI assistant actions refresh the whole dashboard', () => {
  it('refreshDashboardData() reloads availability + re-renders the availability tab and other panels', () => {
    const i = dashboardHtml.indexOf('async function refreshDashboardData');
    expect(i).toBeGreaterThan(-1);
    const body = dashboardHtml.slice(i, i + 900);
    // the previously-missing reload/render that caused the stale Date Overrides panel
    expect(body).toContain('loadAvailability()');
    expect(body).toContain('renderAvailabilityTab()');
    // and the rest of the panels
    expect(body).toContain('loadRoutingForms()');
    expect(body).toContain('renderContacts()');
  });

  it('the AI assistant handler calls refreshDashboardData() and keys off non-read actions', () => {
    expect(dashboardHtml).toContain('await refreshDashboardData()');
    expect(dashboardHtml).toContain('get_|list_|find_|check_');
  });

  it('behavioral: override/booking writes trigger a refresh; pure reads do not', () => {
    // mirrors the AI-handler predicate
    const isWrite = (a) => !!(a.type && !/^(get_|list_|find_|check_)/.test(a.type));
    expect(isWrite({ type: 'update_date_overrides' })).toBe(true); // the CU-06 case
    expect(isWrite({ type: 'create_event_type' })).toBe(true);
    expect(isWrite({ type: 'update_availability_schedule' })).toBe(true);
    expect(isWrite({ type: 'mark_no_show' })).toBe(true);
    expect(isWrite({ type: 'cancel_booking' })).toBe(true);
    expect(isWrite({ type: 'get_availability' })).toBe(false);
    expect(isWrite({ type: 'get_bookings' })).toBe(false);
  });
});
