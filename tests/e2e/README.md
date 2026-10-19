# End-to-end (Playwright) tests

## What CI runs
CI runs **only** `launch-booking-flow.spec.js` — the launch-critical path (sign up →
create event type → public booking → confirmation). That's the gate that must stay
green. See `.github/workflows/ci.yml` (`npm run test:e2e:ci`).

## The rest of this directory is quarantined (not run in CI yet)
The other specs (`advanced-event-types`, `booking-advanced`, `routing-polls-compound`,
`settings*`, `event-types`, `availability`, `cancel-reschedule`, `booking-*`,
`dashboard-flows`, `analytics-admin`, `operations-reporting`, `full-lifecycle`, `auth`)
were authored against helper functions and product features that weren't fully wired,
so they had **never passed CI** — they were failing every run on an import
`SyntaxError`, which is what generated the failure emails.

What's been fixed so far (so the suite at least loads and the basic flows work):
- Added the missing helper exports (`createEventTypeViaForm`, `gotoBookingPage`,
  `openEventTypeEditModal`, `setCheckbox`) in `helpers.js`.
- Test-only **auto-confirm** (`AUTH_AUTOCONFIRM=1` in `scripts/local-test.env`) so a
  headless signup reaches the dashboard (real signups require email verification, which
  a headless run can't complete).
- Block service workers during e2e (`serviceWorkers: 'block'` in `playwright.config.js`).

What still needs doing before re-enabling each spec in CI:
- The "advanced" specs need helpers that actually drive the edit-modal options they
  assert (secret events, guests, paid/coupon, max-per-slot, reminders, custom
  questions). `createEventTypeViaForm` currently only sets name/duration/description.
- Each spec must be **verified on a machine with a working browser**. Note: a
  sandboxed agent environment crashes Chromium on launch
  (`mach_port_rendezvous ... Permission denied (1100)`), so these must be run on a
  normal Mac/Linux: `npm run test:e2e`.

## Running locally
```bash
npm run test:e2e:install   # one-time: install the chromium browser
npm run test:e2e           # full suite
npm run test:e2e:ci        # just the launch gate (what CI runs)
```
