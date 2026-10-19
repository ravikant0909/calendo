import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// FEATURE #4 — calendar "dead click" on month navigation.
//
// The bug: month nav awaited a network fetch BEFORE rendering, so nothing
// changed on screen until the fetch returned (the click felt dead). The fix
// renders the new month IMMEDIATELY, then fills in availability when it
// arrives. It also adds a per-(timezone+month) cache (so revisiting a month is
// instant) and a stale-response guard (so a slow fetch can't clobber a newer
// month).
//
// These are source-structure assertions (the fix lives in inline JS/CSS in the
// shipped HTML, not in exported functions). Each test asserts the fix's
// markers ARE present, and — where it matters — that the OLD buggy pattern is
// ABSENT, so the test fails if the fix were reverted. This mirrors the
// existing source-assertion style in
// tests/unit/worker/responsive-dashboard.test.js and
// tests/unit/worker/meeting-detail-sidebar.test.js.
// ---------------------------------------------------------------------------

const bookingHtml = readFileSync(
  join(__dirname, '../../../public/booking/index.html'),
  'utf-8'
);

const dashboardHtml = readFileSync(
  join(__dirname, '../../../public/dashboard/index.html'),
  'utf-8'
);

// Extract the body of a named function declaration from source so we can make
// ordering assertions on its contents. Handles `function name(` … matched
// brace. Returns the inner body string (between the outer braces).
function extractFunctionBody(src, signatureRegex) {
  const match = src.match(signatureRegex);
  if (!match) return null;
  // Find the first `{` at/after the match end.
  let i = src.indexOf('{', match.index + match[0].length - 1);
  if (i === -1) return null;
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

describe('Calendar dead-click regression — booking page (public/booking/index.html)', () => {

  // =========================================================================
  // 1. state object carries the cache, request id, and loading flag
  // =========================================================================
  describe('state shape', () => {
    it('state object includes slotCache, availReqId, and calendarLoading', () => {
      // These three properties only exist because of the fix; reverting drops them.
      expect(bookingHtml).toMatch(/slotCache\s*:/);
      expect(bookingHtml).toMatch(/availReqId\s*:/);
      expect(bookingHtml).toMatch(/calendarLoading\s*:/);
    });

    it('slotCache is initialised to an empty object', () => {
      expect(bookingHtml).toMatch(/slotCache\s*:\s*\{\s*\}/);
    });

    it('availReqId is initialised to 0', () => {
      expect(bookingHtml).toMatch(/availReqId\s*:\s*0/);
    });

    it('calendarLoading is initialised to false', () => {
      expect(bookingHtml).toMatch(/calendarLoading\s*:\s*false/);
    });
  });

  // =========================================================================
  // 2. changeMonth(delta) renders BEFORE awaiting the fetch — the core fix
  // =========================================================================
  describe('changeMonth(delta) — render before fetch', () => {
    it('a changeMonth(delta) function exists', () => {
      expect(bookingHtml).toMatch(/function\s+changeMonth\s*\(\s*delta\s*\)/);
    });

    it('calls renderCalendar() BEFORE awaiting loadAvailabilityForCurrentMonth()', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+changeMonth\s*\(\s*delta\s*\)/
      );
      expect(body).not.toBeNull();

      const renderIdx = body.indexOf('renderCalendar()');
      const awaitLoadIdx = body.indexOf('await loadAvailabilityForCurrentMonth()');

      expect(renderIdx).toBeGreaterThan(-1);
      expect(awaitLoadIdx).toBeGreaterThan(-1);
      // The whole point of the fix: paint the new month first, then await data.
      expect(renderIdx).toBeLessThan(awaitLoadIdx);
    });

    it('changeMonth advances/wraps the month before painting', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+changeMonth\s*\(\s*delta\s*\)/
      );
      expect(body).not.toBeNull();
      expect(body).toMatch(/state\.currentMonth\.month\s*\+=\s*delta/);
      const monthMutIdx = body.indexOf('state.currentMonth.month += delta');
      const renderIdx = body.indexOf('renderCalendar()');
      expect(monthMutIdx).toBeGreaterThan(-1);
      expect(monthMutIdx).toBeLessThan(renderIdx);
    });
  });

  // =========================================================================
  // 3. Nav buttons call changeMonth(...) — old inline await-before-render gone
  // =========================================================================
  describe('month nav buttons delegate to changeMonth()', () => {
    it('prev button onclick calls changeMonth(-1)', () => {
      expect(bookingHtml).toMatch(/prevBtn\.onclick\s*=\s*\(\)\s*=>\s*\{[^}]*changeMonth\(-1\)/);
    });

    it('next button onclick calls changeMonth(1)', () => {
      expect(bookingHtml).toMatch(/nextBtn\.onclick\s*=\s*\(\)\s*=>\s*changeMonth\(1\)/);
    });

    it('does NOT use the old inline await-fetch-then-render pattern in nav handlers', () => {
      // The reverted (buggy) handler awaited the fetch and only then rendered,
      // inline in the onclick. Assert that buggy shape is gone.
      expect(bookingHtml).not.toMatch(
        /(prev|next)Btn\.onclick\s*=\s*async[\s\S]{0,160}await\s+fetchAvailability\([\s\S]{0,80}renderCalendar\(\)/
      );
      // Also: nav buttons must not directly call fetchAvailability anymore.
      expect(bookingHtml).not.toMatch(/(prev|next)Btn\.onclick\s*=\s*[\s\S]{0,120}fetchAvailability\(/);
    });
  });

  // =========================================================================
  // 4. fetchAvailability(reqId) guards its state writes with a stale check
  // =========================================================================
  describe('fetchAvailability(reqId) — stale-response guard', () => {
    it('takes a reqId parameter', () => {
      expect(bookingHtml).toMatch(/async\s+function\s+fetchAvailability\s*\(\s*reqId\s*\)/);
    });

    it('guards state writes with reqId !== state.availReqId', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+fetchAvailability\s*\(\s*reqId\s*\)/
      );
      expect(body).not.toBeNull();
      expect(body).toMatch(/reqId\s*!==\s*state\.availReqId/);
    });

    it('the stale guard appears before assigning state.slots from the response', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+fetchAvailability\s*\(\s*reqId\s*\)/
      );
      expect(body).not.toBeNull();
      const guardIdx = body.indexOf('reqId !== state.availReqId');
      const assignIdx = body.indexOf('state.slots =');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(assignIdx).toBeGreaterThan(-1);
      // A superseded response must bail out before it overwrites the slots.
      expect(guardIdx).toBeLessThan(assignIdx);
    });
  });

  // =========================================================================
  // 5. loadAvailabilityForCurrentMonth caches by timezone+month and bumps reqId
  // =========================================================================
  describe('loadAvailabilityForCurrentMonth — cache + request id', () => {
    it('the function exists', () => {
      expect(bookingHtml).toMatch(/async\s+function\s+loadAvailabilityForCurrentMonth\s*\(\s*\)/);
    });

    it('builds a cache key combining timezone and month', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+loadAvailabilityForCurrentMonth\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      // key like `${timezone}|${currentMonth.year}-${currentMonth.month}`
      expect(body).toMatch(/timezone\}\|\$\{currentMonth\.year\}-\$\{currentMonth\.month\}/);
    });

    it('reads/writes state.slotCache keyed by that key', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+loadAvailabilityForCurrentMonth\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      expect(body).toMatch(/state\.slotCache\[key\]/);
    });

    it('increments availReqId (++state.availReqId) for each fetch', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+loadAvailabilityForCurrentMonth\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      expect(body).toMatch(/\+\+state\.availReqId/);
    });

    it('serves a cached month without re-fetching (early return on cache hit)', () => {
      const body = extractFunctionBody(
        bookingHtml,
        /async\s+function\s+loadAvailabilityForCurrentMonth\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      // cache hit reads slots from cache and returns before the fetch path.
      const cacheReadIdx = body.indexOf('cached.slots');
      const reqIdIdx = body.indexOf('++state.availReqId');
      expect(cacheReadIdx).toBeGreaterThan(-1);
      expect(reqIdIdx).toBeGreaterThan(-1);
      expect(cacheReadIdx).toBeLessThan(reqIdIdx);
    });
  });

  // =========================================================================
  // 6. timezone <select> onchange clears the cache (cache is tz-specific)
  // =========================================================================
  describe('timezone change invalidates the cache', () => {
    it('the timezone select onchange resets state.slotCache to {}', () => {
      // Find the timezone select onchange handler and confirm it clears the cache.
      const onchangeIdx = bookingHtml.indexOf('select.onchange');
      expect(onchangeIdx).toBeGreaterThan(-1);
      const handlerSlice = bookingHtml.slice(onchangeIdx, onchangeIdx + 600);
      expect(handlerSlice).toMatch(/state\.slotCache\s*=\s*\{\s*\}/);
      // It must also set the new timezone in the same handler (sanity that we
      // found the right handler).
      expect(handlerSlice).toMatch(/state\.timezone\s*=\s*select\.value/);
    });
  });

  // =========================================================================
  // 7. Loading CSS: pulsing skeleton day cells
  // =========================================================================
  describe('loading-state CSS', () => {
    it('.calendar-day.day-loading rule exists', () => {
      expect(bookingHtml).toMatch(/\.calendar-day\.day-loading\s*\{/);
    });

    it('.calendar-day.day-loading uses the calDayPulse animation', () => {
      const rule = bookingHtml.match(/\.calendar-day\.day-loading\s*\{([\s\S]*?)\}/);
      expect(rule).not.toBeNull();
      expect(rule[1]).toMatch(/animation:\s*calDayPulse/);
    });

    it('@keyframes calDayPulse is defined', () => {
      expect(bookingHtml).toMatch(/@keyframes\s+calDayPulse\s*\{/);
    });

    it('renderCalendar applies the day-loading class GUARDED by state.calendarLoading', () => {
      // The grid must actually apply the loading class, and only while loading —
      // otherwise the CSS is dead (a stray reference outside the guard would let a
      // revert that drops the loading state still pass). Assert the add() lives
      // inside the `if (state.calendarLoading)` branch, by index ordering within
      // the renderCalendar body.
      const body = extractFunctionBody(
        bookingHtml,
        /function\s+renderCalendar\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      const guardIdx = body.indexOf('if (state.calendarLoading)');
      const addIdx = body.search(/classList\.add\(['"]day-loading['"]\)/);
      expect(guardIdx).toBeGreaterThan(-1);
      expect(addIdx).toBeGreaterThan(-1);
      // The loading-cell class must be applied under the calendarLoading guard.
      expect(guardIdx).toBeLessThan(addIdx);
    });
  });
});

describe('Calendar dead-click regression — dashboard calendar view (public/dashboard/index.html)', () => {

  describe('renderCalendarView — label + skeleton before fetch', () => {
    it('a _calViewReqId stale guard counter exists', () => {
      expect(dashboardHtml).toMatch(/let\s+_calViewReqId\s*=\s*0/);
    });

    it('renderCalendarView updates the week label BEFORE awaiting the fetch', () => {
      const body = extractFunctionBody(
        dashboardHtml,
        /async\s+function\s+renderCalendarView\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      const labelIdx = body.indexOf("getElementById('calViewLabel')");
      const awaitIdx = body.indexOf("await api(`/api/calendar-view");
      expect(labelIdx).toBeGreaterThan(-1);
      expect(awaitIdx).toBeGreaterThan(-1);
      expect(labelIdx).toBeLessThan(awaitIdx);
    });

    it('renderCalendarView paints a skeleton grid (paintCalendarViewGrid) BEFORE awaiting the fetch', () => {
      const body = extractFunctionBody(
        dashboardHtml,
        /async\s+function\s+renderCalendarView\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      const paintIdx = body.indexOf('paintCalendarViewGrid(');
      const awaitIdx = body.indexOf('await api(`/api/calendar-view');
      expect(paintIdx).toBeGreaterThan(-1);
      expect(awaitIdx).toBeGreaterThan(-1);
      // First paint must happen before the fetch — that's the dead-click fix.
      expect(paintIdx).toBeLessThan(awaitIdx);
    });

    it('renderCalendarView increments _calViewReqId and bails on a stale response', () => {
      const body = extractFunctionBody(
        dashboardHtml,
        /async\s+function\s+renderCalendarView\s*\(\s*\)/
      );
      expect(body).not.toBeNull();
      expect(body).toMatch(/\+\+_calViewReqId/);
      expect(body).toMatch(/reqId\s*!==\s*_calViewReqId/);
      // The stale guard must come AFTER the await (it checks the post-fetch id).
      const awaitIdx = body.indexOf('await api(`/api/calendar-view');
      const guardIdx = body.indexOf('reqId !== _calViewReqId');
      expect(awaitIdx).toBeLessThan(guardIdx);
    });

    it('paintCalendarViewGrid accepts a loading flag', () => {
      expect(dashboardHtml).toMatch(/function\s+paintCalendarViewGrid\s*\(\s*dates\s*,\s*events\s*,\s*loading\s*\)/);
    });

    it('the loading skeleton applies the calview-loading class', () => {
      const body = extractFunctionBody(
        dashboardHtml,
        /function\s+paintCalendarViewGrid\s*\(\s*dates\s*,\s*events\s*,\s*loading\s*\)/
      );
      expect(body).not.toBeNull();
      expect(body).toMatch(/loading\s*\?\s*['"]calview-loading['"]/);
    });
  });

  describe('calview-loading CSS', () => {
    it('a .calview-loading CSS rule exists', () => {
      expect(dashboardHtml).toMatch(/\.calview-loading\s*\{/);
    });

    it('.calview-loading runs an animation', () => {
      const rule = dashboardHtml.match(/\.calview-loading\s*\{([\s\S]*?)\}/);
      expect(rule).not.toBeNull();
      expect(rule[1]).toMatch(/animation:\s*calviewPulse/);
    });

    it('@keyframes calviewPulse is defined', () => {
      expect(dashboardHtml).toMatch(/@keyframes\s+calviewPulse\s*\{/);
    });
  });
});
