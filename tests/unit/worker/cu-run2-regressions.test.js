import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for Computer Use Test Run 2 (worker-side findings).
// Repro guide: docs/computer-use-tests/results/run-2-bug-report.html

// ---------------------------------------------------------------------------
// Bug #2 (F2) — /auth/forgot-password used to fall through to the asset handler
// and return HTTP 500. It must redirect to the working reset page instead.
// ---------------------------------------------------------------------------
describe('Bug #2: /auth/forgot-password redirects to the reset page (no 500)', () => {
  it('redirects /auth/forgot-password -> /auth/reset-password.html', async () => {
    const worker = await import('../../../src/worker.js');
    const env = { DB: {}, ASSETS: { fetch: () => new Response('asset') } };
    const res = await worker.default.fetch(
      new Request('http://localhost/auth/forgot-password'),
      env,
      {}
    );
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('Location')).toContain('/auth/reset-password.html');
  });

  it('also redirects the trailing-slash variant', async () => {
    const worker = await import('../../../src/worker.js');
    const env = { DB: {}, ASSETS: { fetch: () => new Response('asset') } };
    const res = await worker.default.fetch(
      new Request('http://localhost/auth/forgot-password/'),
      env,
      {}
    );
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('Location')).toContain('/auth/reset-password.html');
  });
});

// ---------------------------------------------------------------------------
// Bug #3 (F4) — getOutlookBusyTimes must (a) force UTC in the Graph response so
// busy times are unambiguous, and (b) log failures to calendar_sync_errors
// instead of silently returning [] (which hides a double-booking risk).
// (Static guards: the function calls Graph, so behavioural testing is covered
//  by the existing outlook suite; here we lock in the hardening.)
// ---------------------------------------------------------------------------
describe('Bug #3: Outlook busy fetch is explicit-UTC and non-silent on failure', () => {
  const src = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');
  const fnStart = src.indexOf('async function getOutlookBusyTimes');
  const fnBody = src.slice(fnStart, src.indexOf('async function', fnStart + 1));

  it('forces UTC on the calendarView response', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnBody).toContain('outlook.timezone="UTC"');
  });

  it('logs failures to calendar_sync_errors (no silent swallow)', () => {
    expect(fnBody).toMatch(/logCalendarSyncError\([^)]*'outlook'/);
  });
});
