import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for Computer Use Test Run 4 (CU-07, CU-13, CU-19 findings).
// Tracker: docs/computer-use-tests/results/OPEN-ITEMS.html
const dash = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');
const embed = readFileSync(join(process.cwd(), 'public/embed.js'), 'utf8');

// B7 — hosts could not reschedule from the dashboard (only cancel + rebook).
describe('B7: host can reschedule from the dashboard', () => {
  it('the meeting detail offers a Reschedule link via the booking token', () => {
    expect(dash).toContain('reschedule.html?token=');
    expect(dash).toContain('b.cancel_token');
  });
});

// B8 — analytics no-show rate showed a stale snapshot until a full page reload.
describe('B8: analytics refreshes after no-show / when opening the Analytics tab', () => {
  it('switchTab re-fetches analytics on activation', () => {
    expect(dash).toMatch(/tab === 'analytics'[\s\S]{0,90}loadAnalytics\(\)\.then\(renderAnalytics\)/);
  });
  it('markNoShow refreshes analytics', () => {
    const i = dash.indexOf('async function markNoShow');
    expect(i).toBeGreaterThan(-1);
    const body = dash.slice(i, i + 900);
    expect(body).toContain('loadAnalytics()');
    expect(body).toContain('renderAnalytics()');
  });
});

// B10 — dashboard poll Copy Link / list link pointed at the dead /booking/?poll=.
describe('B10: dashboard poll links point to the working /poll/ page', () => {
  it('uses /poll/?id= and never the dead /booking/?poll=', () => {
    expect(dash).not.toContain('/booking/?poll=');
    expect(dash).toMatch(/\/poll\/\?id=\$\{/);
  });
});

// B13 — badge embed (embed.js) did not re-dispatch the booking-confirmed message.
describe('B13: badge embed re-dispatches booking-confirmed', () => {
  it('embed.js listens for the iframe message and re-dispatches a CustomEvent', () => {
    expect(embed).toContain("addEventListener('message'");
    expect(embed).toContain('calendo:booking-confirmed');
    expect(embed).toContain('dispatchEvent');
  });
});
