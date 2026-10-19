import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Zoom UI lives inline in public/dashboard/index.html. These tests guard the
// per-user Zoom integration surface:
//   1. "zoom" is a selectable location option in BOTH event-type selects.
//   2. #zoomConnectSection + renderZoomConnectSection() show/hide on
//      /api/zoom/status and render connect vs. connected/disconnect UI.
//   3. ensureZoomConnected() gates Zoom selection in saveEditModal and
//      changeDefaultLocation.
//   4. The dashboard handles the AI 'connect_zoom' action and the
//      ?zoom=connected / ?zoom=error redirect param.
//
// Where possible the function is extracted and executed for real
// (non-tautological); the rest are source-structure assertions that assert BOTH
// that the new wiring is present AND that the buggy/missing pattern is absent.
// ---------------------------------------------------------------------------

const html = readFileSync(
  join(process.cwd(), 'public/dashboard/index.html'),
  'utf8'
);

// Extract a JS source block from a start needle to a stable end marker.
function sliceSrc(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  if (start === -1) throw new Error(`start needle not found: ${startNeedle}`);
  const end = html.indexOf(endNeedle, start);
  if (end === -1) throw new Error(`end needle not found: ${endNeedle}`);
  return html.slice(start, end + endNeedle.length);
}

// Slice the <select ...>...</select> element that has the given id attribute.
function sliceSelect(id) {
  const idIdx = html.indexOf(`id="${id}"`);
  if (idIdx === -1) throw new Error(`select id not found: ${id}`);
  const openStart = html.lastIndexOf('<select', idIdx);
  const close = html.indexOf('</select>', idIdx);
  return html.slice(openStart, close + '</select>'.length);
}

describe('Zoom UI in dashboard', () => {

  // ========================================================================
  // 1. "zoom" option present in BOTH event-type location selects
  // ========================================================================
  describe('location selects offer Zoom', () => {
    it('edit-panel select #editEtLocation contains a value="zoom" option', () => {
      const select = sliceSelect('editEtLocation');
      expect(select).toMatch(/<option value="zoom"[^>]*>[^<]*Zoom/);
    });

    it('create form select #etLocation contains a value="zoom" option', () => {
      const select = sliceSelect('etLocation');
      expect(select).toMatch(/<option value="zoom"[^>]*>[^<]*Zoom/);
    });

    it('the "zoom" option actually renders inside happy-dom as a selectable value', () => {
      // Functionally confirm the option is real, not just text in a comment.
      const select = sliceSelect('editEtLocation');
      const el = document.createElement('div');
      el.innerHTML = select;
      const values = Array.from(el.querySelectorAll('option')).map(o => o.value);
      expect(values).toContain('zoom');
    });
  });

  // ========================================================================
  // 2. #zoomConnectSection markup + renderZoomConnectSection()
  // ========================================================================
  describe('Zoom connect section markup', () => {
    it('has a #zoomConnectSection container hidden by default', () => {
      const idx = html.indexOf('id="zoomConnectSection"');
      expect(idx).toBeGreaterThan(-1);
      // the container div carries display:none initially
      const div = html.slice(html.lastIndexOf('<div', idx), html.indexOf('>', idx) + 1);
      expect(div).toMatch(/display:\s*none/);
    });

    it('has a #zoomConnectStatus host that JS fills', () => {
      expect(html).toContain('id="zoomConnectStatus"');
    });
  });

  describe('renderZoomConnectSection() behavior', () => {
    // Extract and execute the real function against a stubbed api/DOM.
    function loadRender() {
      const src = sliceSrc(
        'async function renderZoomConnectSection()',
        // ends right before disconnectZoom begins
        '    async function disconnectZoom()'
      );
      // Trim the trailing disconnectZoom signature back off; keep just the fn body.
      const fnSrc = src.slice(0, src.indexOf('    async function disconnectZoom()'));
      const factory = new Function(
        'document', 'api', 'escapeHtml',
        `${fnSrc}; return renderZoomConnectSection;`
      );
      return factory;
    }

    function makeDom() {
      document.body.innerHTML = `
        <div id="zoomConnectSection" style="display:none">
          <div id="zoomConnectStatus"></div>
        </div>`;
      return {
        section: document.getElementById('zoomConnectSection'),
        statusDiv: document.getElementById('zoomConnectStatus'),
      };
    }

    const escapeHtml = (s) => (s == null ? '' : String(s));

    it('hides the section when Zoom is not configured on the server', async () => {
      const { section } = makeDom();
      const api = vi.fn(async () => ({ configured: false }));
      const renderZoomConnectSection = loadRender()(document, api, escapeHtml);

      await renderZoomConnectSection();

      expect(api).toHaveBeenCalledWith('/api/zoom/status');
      expect(section.style.display).toBe('none');
    });

    it('shows a "Connect Zoom" link to /api/zoom/connect when configured but not connected', async () => {
      const { section, statusDiv } = makeDom();
      const api = vi.fn(async () => ({ configured: true, connected: false }));
      const renderZoomConnectSection = loadRender()(document, api, escapeHtml);

      await renderZoomConnectSection();

      expect(section.style.display).toBe('block');
      const link = statusDiv.querySelector('a');
      expect(link).not.toBeNull();
      expect(link.getAttribute('href')).toBe('/api/zoom/connect');
      expect(statusDiv.textContent).toContain('Connect Zoom');
      // Not connected => no disconnect control
      expect(statusDiv.innerHTML).not.toContain('disconnectZoom()');
    });

    it('shows the connected email + a disconnectZoom control when connected', async () => {
      const { section, statusDiv } = makeDom();
      const api = vi.fn(async () => ({ configured: true, connected: true, email: 'me@example.com' }));
      const renderZoomConnectSection = loadRender()(document, api, escapeHtml);

      await renderZoomConnectSection();

      expect(section.style.display).toBe('block');
      expect(statusDiv.textContent).toContain('me@example.com');
      expect(statusDiv.innerHTML).toContain('disconnectZoom()');
      // When connected we must NOT also render a fresh connect link.
      expect(statusDiv.querySelector('a[href="/api/zoom/connect"]')).toBeNull();
    });
  });

  describe('disconnectZoom() posts to the disconnect endpoint', () => {
    it('source POSTs /api/zoom/disconnect and re-renders', () => {
      const src = sliceSrc('async function disconnectZoom()', 'renderZoomConnectSection();\n      } catch');
      expect(src).toContain("api('/api/zoom/disconnect', { method: 'POST' })");
      expect(src).toContain('renderZoomConnectSection()');
    });
  });

  // ========================================================================
  // 3. ensureZoomConnected() — executed for real + call-site guards
  // ========================================================================
  describe('ensureZoomConnected()', () => {
    function loadEnsure(stubs) {
      const src = sliceSrc(
        'async function ensureZoomConnected()',
        // end marker: the closing of the function right before changeDefaultLocation
        '    async function changeDefaultLocation'
      );
      const fnSrc = src.slice(0, src.indexOf('    async function changeDefaultLocation'));
      const factory = new Function(
        'api', 'showToast', 'showConfirm', 'window',
        `${fnSrc}; return ensureZoomConnected;`
      );
      return factory(stubs.api, stubs.showToast, stubs.showConfirm, stubs.window);
    }

    it('returns false and toasts an error when Zoom is not configured', async () => {
      const showToast = vi.fn();
      const ensure = loadEnsure({
        api: vi.fn(async () => ({ configured: false })),
        showToast,
        showConfirm: vi.fn(),
        window: { location: { href: '' } },
      });

      const result = await ensure();

      expect(result).toBe(false);
      expect(showToast).toHaveBeenCalled();
      // error severity is passed
      expect(showToast.mock.calls[0][1]).toBe('error');
    });

    it('returns true when Zoom is already connected (no prompt)', async () => {
      const showConfirm = vi.fn();
      const ensure = loadEnsure({
        api: vi.fn(async () => ({ configured: true, connected: true })),
        showToast: vi.fn(),
        showConfirm,
        window: { location: { href: '' } },
      });

      const result = await ensure();

      expect(result).toBe(true);
      expect(showConfirm).not.toHaveBeenCalled();
    });

    it('prompts and redirects to /api/zoom/connect when configured but not connected', async () => {
      const win = { location: { href: '' } };
      const ensure = loadEnsure({
        api: vi.fn(async () => ({ configured: true, connected: false })),
        showToast: vi.fn(),
        showConfirm: vi.fn(async () => true), // user accepts
        window: win,
      });

      const result = await ensure();

      expect(result).toBe(false);
      expect(win.location.href).toBe('/api/zoom/connect');
    });

    it('does not redirect when the user declines the connect prompt', async () => {
      const win = { location: { href: '' } };
      const ensure = loadEnsure({
        api: vi.fn(async () => ({ configured: true, connected: false })),
        showToast: vi.fn(),
        showConfirm: vi.fn(async () => false), // user declines
        window: win,
      });

      const result = await ensure();

      expect(result).toBe(false);
      expect(win.location.href).toBe('');
    });

    it('returns false (does not throw) when the status check errors', async () => {
      const showToast = vi.fn();
      const ensure = loadEnsure({
        api: vi.fn(async () => { throw new Error('network'); }),
        showToast,
        showConfirm: vi.fn(),
        window: { location: { href: '' } },
      });

      const result = await ensure();

      expect(result).toBe(false);
      expect(showToast).toHaveBeenCalled();
    });
  });

  describe('ensureZoomConnected() is wired into the Zoom-selection call sites', () => {
    const GUARD = "locType === 'zoom' && !(await ensureZoomConnected())";

    it('saveEditModal() guards Zoom selection with ensureZoomConnected()', () => {
      const src = sliceSrc('async function saveEditModal()', 'const payload = {');
      expect(src).toContain(GUARD);
    });

    it('changeDefaultLocation() guards Zoom selection with ensureZoomConnected()', () => {
      const src = sliceSrc('async function changeDefaultLocation(locType)', 'await Promise.all(updates)');
      expect(src).toContain(GUARD);
    });

    it('the guard early-returns (so no Zoom event type is saved without a connection)', () => {
      // Assert the guard is followed by `return;` so it actually short-circuits.
      const guardWithReturn = new RegExp(
        "locType === 'zoom' && !\\(await ensureZoomConnected\\(\\)\\)\\)\\s*return;"
      );
      const occurrences = html.match(/locType === 'zoom' && !\(await ensureZoomConnected\(\)\)\) return;/g) || [];
      // Both saveEditModal AND changeDefaultLocation must short-circuit.
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
      expect(guardWithReturn.test(html)).toBe(true);
    });
  });

  // ========================================================================
  // 4. AI 'connect_zoom' action + ?zoom= redirect handling
  // ========================================================================
  describe("AI frontend action 'connect_zoom'", () => {
    it('handles action.type === connect_zoom by navigating to /api/zoom/connect', () => {
      // Slice the connect_zoom handler block.
      const start = html.indexOf("action.type === 'connect_zoom'");
      expect(start).toBeGreaterThan(-1);
      const block = html.slice(start, start + 160);
      expect(block).toContain("window.location.href = '/api/zoom/connect'");
    });
  });

  describe('?zoom= redirect param handling', () => {
    const start = () => html.indexOf("urlParams.get('zoom') === 'connected'");
    it('checks for both zoom=connected and zoom=error', () => {
      const idx = start();
      expect(idx).toBeGreaterThan(-1);
      const block = html.slice(idx, idx + 500);
      expect(block).toContain("urlParams.get('zoom') === 'connected'");
      expect(block).toContain("urlParams.get('zoom') === 'error'");
    });

    it('shows a success/failure toast for the zoom redirect', () => {
      const idx = start();
      const block = html.slice(idx, idx + 500);
      expect(block).toMatch(/showToast\([^)]*Zoom connected!/);
      expect(block).toContain('Zoom connection failed');
    });

    it('opens the calendar settings sub-tab after a Zoom redirect', () => {
      const idx = start();
      const block = html.slice(idx, idx + 500);
      // navigates to availability tab and switches to the calendar-settings sub-tab
      expect(block).toContain("switchTab('availability')");
      expect(block).toContain('calendar-settings');
    });

    it('clears the query string so the toast does not re-fire on refresh', () => {
      const idx = start();
      const block = html.slice(idx, idx + 500);
      expect(block).toContain('window.history.replaceState');
    });
  });
});

// ===========================================================================
// 5. Zoom as a first-class option in the ONBOARDING location step.
//    Zoom is the one meeting location with its own OAuth (Meet/Teams ride on
//    the calendar connection from step 1). These guard that picking Zoom in
//    onboarding (a) offers the tile, (b) EXPLAINS the connect before leaving the
//    page and only commits + hands off once the user opts in, and (c) on return
//    moves the user FORWARD to the final step rather than back onto the step
//    they just left.
// ===========================================================================
describe('Zoom in onboarding location step', () => {
  it('offers a value="zoom" radio tile labelled "Zoom"', () => {
    // Slice the onboarding location grid (radios share name="onb-loc").
    const first = html.indexOf('name="onb-loc"');
    expect(first).toBeGreaterThan(-1);
    const gridStart = html.lastIndexOf('<div', first);
    const gridEnd = html.indexOf('id="onb-save-location"', first);
    const grid = html.slice(gridStart, gridEnd);
    const el = document.createElement('div');
    el.innerHTML = grid;
    const values = Array.from(el.querySelectorAll('input[name="onb-loc"]')).map(i => i.value);
    expect(values).toContain('zoom');
    expect(grid).toMatch(/value="zoom"[\s\S]*?<strong[^>]*>\s*Zoom\s*</);
  });

  // Extract and actually run the onb-save-location click handler.
  function loadSaveLocationHandler() {
    const raw = sliceSrc(
      "document.getElementById('onb-save-location')?.addEventListener('click',",
      'onbGoTo(4);\n    });'
    );
    const body = raw
      .replace(
        "document.getElementById('onb-save-location')?.addEventListener('click',",
        'const __handler ='
      )
      .replace(/\}\);\s*$/, '};');
    const factory = new Function(
      'document', 'api', 'showToast', 'window', 'onbGoTo', 'showConfirm',
      `${body} return __handler;`
    );
    return factory;
  }

  function runWith({ locValue, zoomStatus, confirmResult = true }) {
    document.body.innerHTML = `<input type="radio" name="onb-loc" value="${locValue}" checked>`;
    const calls = [];
    const api = vi.fn(async (path, opts) => {
      calls.push({ path, opts });
      if (path === '/api/event-types') return [{ id: 7 }];
      if (path === '/api/zoom/status') return zoomStatus;
      return {};
    });
    const win = { location: { href: '' } };
    const onbGoTo = vi.fn();
    const showToast = vi.fn();
    const showConfirm = vi.fn(async () => confirmResult);
    const handler = loadSaveLocationHandler()(document, api, showToast, win, onbGoTo, showConfirm);
    return { handler, api, calls, win, onbGoTo, showToast, showConfirm };
  }

  it('explains, saves, then redirects to /api/zoom/connect when the user accepts (Zoom unconnected)', async () => {
    const { handler, calls, win, onbGoTo, showConfirm } = runWith({
      locValue: 'zoom',
      zoomStatus: { configured: true, connected: false },
    });

    await handler({ currentTarget: { disabled: false } });

    // The user must be told what's about to happen before leaving Calendo.
    expect(showConfirm).toHaveBeenCalled();
    // The event type PUT (location_type:zoom) must happen BEFORE we navigate away,
    // so the choice survives the OAuth redirect.
    const put = calls.find(c => c.path === '/api/event-types/7');
    expect(put).toBeTruthy();
    expect(JSON.parse(put.opts.body)).toEqual({ location_type: 'zoom' });
    // Then we hand off to the standard Zoom connect flow and do NOT advance here
    // (the forward move happens on return).
    expect(win.location.href).toBe('/api/zoom/connect');
    expect(onbGoTo).not.toHaveBeenCalled();
  });

  it('does NOT save or redirect if the user cancels the Zoom connect prompt', async () => {
    const { handler, calls, win, onbGoTo } = runWith({
      locValue: 'zoom',
      zoomStatus: { configured: true, connected: false },
      confirmResult: false,
    });

    await handler({ currentTarget: { disabled: false } });

    // Cancelling leaves everything untouched so the user can pick another option.
    expect(calls.find(c => c.path === '/api/event-types/7')).toBeUndefined();
    expect(win.location.href).toBe('');
    expect(onbGoTo).not.toHaveBeenCalled();
  });

  it('advances to the final step with no prompt/redirect when Zoom is already connected', async () => {
    const { handler, win, onbGoTo, showConfirm } = runWith({
      locValue: 'zoom',
      zoomStatus: { configured: true, connected: true },
    });

    await handler({ currentTarget: { disabled: false } });

    expect(showConfirm).not.toHaveBeenCalled();
    expect(win.location.href).toBe('');
    expect(onbGoTo).toHaveBeenCalledWith(4);
  });

  it('does not touch Zoom status for non-Zoom locations (Google Meet just advances)', async () => {
    const { handler, api, win, onbGoTo, showConfirm } = runWith({
      locValue: 'google_meet',
      zoomStatus: { configured: true, connected: false },
    });

    await handler({ currentTarget: { disabled: false } });

    expect(api).not.toHaveBeenCalledWith('/api/zoom/status');
    expect(showConfirm).not.toHaveBeenCalled();
    expect(win.location.href).toBe('');
    expect(onbGoTo).toHaveBeenCalledWith(4);
  });

  it('renders the confirm dialog ABOVE the onboarding overlay (else the prompt is unclickable → freeze)', () => {
    // Regression: the Zoom confirm uses showConfirm(#confirmDialog). During
    // onboarding the full-screen #calendarOnboarding overlay is up; if the dialog
    // is not stacked above it, its buttons can't be clicked, the await never
    // resolves, and the Next button stays disabled forever.
    const zEl = (id) => {
      const i = html.indexOf('id="' + id + '"');
      expect(i).toBeGreaterThan(-1);
      const tag = html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1);
      const m = tag.match(/z-index:\s*(\d+)/);
      expect(m, 'no inline z-index on #' + id).toBeTruthy();
      return parseInt(m[1], 10);
    };
    expect(zEl('confirmDialog')).toBeGreaterThan(zEl('calendarOnboarding'));
  });

  it('on return, advances to the FINAL step on ?zoom=connected and back to location on ?zoom=error', () => {
    const idx = html.indexOf('const zoomReturn');
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 1300);
    expect(block).toContain("get('zoom')");
    // Success => forward to step 4 (not step 3, which the user just left).
    expect(block).toMatch(/zoomReturn === 'connected'[\s\S]*?onbGoTo\(4\)/);
    // Failure => back to the location step to retry.
    expect(block).toMatch(/zoomReturn === 'error'[\s\S]*?onbGoTo\(3\)/);
  });
});
