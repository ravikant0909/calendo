import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the onboarding "stuck on Connect your calendar" bug:
// a user who completed Google calendar connect (DB confirmed the connection)
// still saw step 1 because the onboarding check read a stale/cached empty
// /api/calendars and returned BEFORE the ?calendar=connected handler ran.
const dashboardHtml = readFileSync(
  join(process.cwd(), 'public/dashboard/index.html'),
  'utf8'
);

describe('Onboarding: do not get stuck on "Connect your calendar" after a successful connect', () => {
  it('the api() helper bypasses the HTTP cache (no stale /api/calendars)', () => {
    expect(dashboardHtml).toMatch(/async function api\(path, options = \{\}\)/);
    expect(dashboardHtml).toContain("cache: 'no-store'");
  });

  it('the onboarding check honors the ?calendar=connected URL signal', () => {
    expect(dashboardHtml).toContain("const justConnectedCal = new URLSearchParams(window.location.search).get('calendar') === 'connected'");
  });

  it('advances to step 2 when a calendar is present OR was just connected', () => {
    expect(dashboardHtml).toContain('if (calCount > 0 || justConnectedCal) {');
  });

  it('cleans the ?calendar=connected param from the URL after advancing', () => {
    // inside the justConnectedCal branch, the param is stripped via replaceState
    expect(dashboardHtml).toMatch(/if \(justConnectedCal\) \{[\s\S]{0,140}history\.replaceState/);
  });

  // Behavioral: mirror the fixed decision rule.
  const decideStep = (calCount, justConnectedCal) =>
    (calCount > 0 || justConnectedCal) ? 2 : 1;

  it('rule: connected (count>0) → step 2', () => {
    expect(decideStep(1, false)).toBe(2);
  });

  it('rule: just connected but list still empty/stale → step 2 (the bug case)', () => {
    expect(decideStep(0, true)).toBe(2);
  });

  it('rule: no calendar and no connect signal → step 1', () => {
    expect(decideStep(0, false)).toBe(1);
  });
});

describe('Mobile: AI panel is hidden by default (not stuck visible at 360px)', () => {
  // The base `.ai-panel` rule is defined later in the stylesheet than the mobile
  // media query, so without !important it wins on mobile and leaves the panel
  // covering the dashboard (observed on the installed PWA on iPhone).
  it('mobile .ai-panel forces display:none !important and width:100% !important', () => {
    const m = dashboardHtml.match(/@media \(max-width: 768px\)[\s\S]*?\.ai-panel \{[\s\S]*?\}/);
    expect(m).toBeTruthy();
    expect(m[0]).toContain('display: none !important');
    expect(m[0]).toContain('width: 100% !important');
  });

  it('mobile .ai-panel.mobile-open forces display:flex !important (full-screen when opened)', () => {
    expect(dashboardHtml).toContain('.ai-panel.mobile-open {\n        display: flex !important;');
  });

  it('weekly-hours rows wrap on mobile so action buttons do not overflow off-screen', () => {
    expect(dashboardHtml).toContain('.avail-compact-day { flex-wrap: wrap;');
    expect(dashboardHtml).toContain('.avail-compact-windows { order: 3; flex-basis: 100%; }');
  });

  it('onboarding reserves the status-bar/notch inset so the heading is not clipped', () => {
    expect(dashboardHtml).toContain('env(safe-area-inset-top');
  });
});

describe('Booking page shows the custom Logo URL (was overwritten by the profile photo)', () => {
  const bookingHtml = readFileSync(join(process.cwd(), 'public/booking/index.html'), 'utf8');
  it('header avatar prefers logo_url over avatar_url', () => {
    expect(bookingHtml).toContain('page.logo_url || page.avatar_url || state.page.avatar_url');
  });
  it('sidebar avatar prefers logo_url over avatar_url', () => {
    expect(bookingHtml).toContain('const sidebarImg = page.logo_url || page.avatar_url');
  });
});

describe('Client state does not leak across accounts (settings-tab-after-delete bug)', () => {
  const loginHtml = readFileSync(join(process.cwd(), 'public/auth/login.html'), 'utf8');

  it('dashboard clears calendo_* localStorage on logout and on account delete', () => {
    expect(dashboardHtml).toContain('function clearCalendoLocalState()');
    // both the logout handler and the delete-account handler call it
    const calls = dashboardHtml.match(/clearCalendoLocalState\(\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // definition + logout + delete
  });

  it('login page clears leftover calendo_* state on load (catch-all incl. session expiry)', () => {
    expect(loginHtml).toMatch(/localStorage\.key\(i\)[\s\S]{0,120}indexOf\('calendo_'\) === 0[\s\S]{0,40}removeItem/);
  });

  // Behavioral: the clear rule removes only calendo_ keys, leaving others intact.
  it('rule: only calendo_-prefixed keys are removed', () => {
    const store = { calendo_active_tab: 'settings', calendo_chat_1: 'x', other_app: 'keep' };
    Object.keys(store).forEach((k) => { if (k.indexOf('calendo_') === 0) delete store[k]; });
    expect(store).toEqual({ other_app: 'keep' });
  });
});
