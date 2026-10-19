import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// public/pwa.js is an IIFE that runs on load. It:
//   (a) injects iOS/install <meta> + <link> tags into <head>, and
//   (b) shows a dismissible mobile install banner (#calendoPwaBanner) on pages
//       WITHOUT #pwaInstallBtn — Android via beforeinstallprompt, iOS via
//       "Add to Home Screen" instructions.
// We eval the source once per scenario after wiring window/navigator/matchMedia
// stubs, then drive events to exercise the real banner logic. These tests fail
// if the discoverability behavior is reverted (they assert real DOM effects,
// not source text).
// ---------------------------------------------------------------------------

const PWA_SRC = readFileSync(join(process.cwd(), 'public/pwa.js'), 'utf8');

// Run the IIFE fresh (new module-level state each time: deferredPrompt,
// bannerShown). The IIFE registers window listeners + injects meta synchronously.
//
// happy-dom keeps window listeners registered across runPwa() calls within a
// suite, so dispatching globally would fire *every* prior IIFE's handlers and
// duplicate banners. To keep each scenario isolated we capture the current
// run's window listeners and dispatch only to them via fire().
function runPwa() {
  const listeners = {};
  const real = window.addEventListener.bind(window);
  window.addEventListener = (type, fn, opts) => {
    (listeners[type] = listeners[type] || []).push(fn);
    return real(type, fn, opts);
  };
  try {
    // eslint-disable-next-line no-new-func
    new Function(PWA_SRC)();
  } finally {
    window.addEventListener = real;
  }
  return {
    fire(type, event) {
      const ev = event || new Event(type);
      (listeners[type] || []).forEach((fn) => fn.call(window, ev));
      return ev;
    },
  };
}

// Control isMobile() (max-width:768px) and isStandalone() (display-mode:standalone).
function stubMatchMedia({ mobile = true, standalone = false } = {}) {
  window.matchMedia = (q) => ({
    matches: q.includes('max-width: 768px') ? mobile
      : q.includes('display-mode: standalone') ? standalone
      : false,
    media: q,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

function setUserAgent(ua) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

// happy-dom's HTMLElement.click() doesn't reliably fire attached listeners for
// dynamically created buttons; dispatch a real bubbling click event instead.
function clickEl(el) {
  el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

// A beforeinstallprompt event carrying a spy-able deferred prompt.
function makeBipEvent() {
  const e = new Event('beforeinstallprompt');
  e.prompt = vi.fn();
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  return e;
}

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
// Real iOS Safari (has Version/ + Safari/, no CriOS) -> "Add to Home Screen".
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// iOS Chrome (CriOS) -> can't Add to Home Screen; must open in Safari.
const IOS_CHROME_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';
// Android in-app webview (";  wv") -> must open in Chrome to install.
const ANDROID_WV_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  localStorage.clear();
  setUserAgent(DESKTOP_UA);
  // ensure iOS detection's MSStream guard sees undefined
  try { delete window.MSStream; } catch { /* noop */ }
  window.MSStream = undefined;
  // requestAnimationFrame: run synchronously so .cpb-visible is added immediately
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  stubMatchMedia({ mobile: true, standalone: false });
  vi.useFakeTimers();
  // Fake timers start Date.now() at 0, which would make dismissal timestamps
  // falsy (recentlyDismissed() short-circuits on `t && ...`). Anchor to a real
  // nonzero clock so the cooldown logic behaves as it does in production.
  vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PWA install discoverability (public/pwa.js)', () => {
  // 1. Meta + link injection -------------------------------------------------
  it('injects apple PWA meta + apple-touch-icon + manifest links into <head>', () => {
    runPwa();
    const cap = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
    expect(cap).not.toBeNull();
    expect(cap.getAttribute('content')).toBe('yes');
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')).not.toBeNull();
    expect(document.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull();
    expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
  });

  // 2. Android banner --------------------------------------------------------
  it('Android (beforeinstallprompt + mobile, no #pwaInstallBtn): shows banner with Install button that fires the deferred prompt', () => {
    const pwa = runPwa();
    const bip = makeBipEvent();
    pwa.fire('beforeinstallprompt', bip);
    // banner is deferred 2500ms after the prompt is captured
    expect(document.getElementById('calendoPwaBanner')).toBeNull();
    vi.advanceTimersByTime(2600);

    const banner = document.getElementById('calendoPwaBanner');
    expect(banner).not.toBeNull();
    const install = banner.querySelector('.cpb-action');
    expect(install).not.toBeNull();
    expect(install.textContent).toMatch(/install/i);

    clickEl(install);
    expect(bip.prompt).toHaveBeenCalledTimes(1);
  });

  // 3. iOS Safari banner -----------------------------------------------------
  it('iOS Safari (no beforeinstallprompt): shows "Add to Home Screen" banner with NO action button', () => {
    setUserAgent(IOS_UA);
    const pwa = runPwa();
    pwa.fire('load');
    vi.advanceTimersByTime(2600);

    const banner = document.getElementById('calendoPwaBanner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/Add to Home Screen/i);
    expect(banner.textContent).toMatch(/Share/i);
    expect(banner.querySelector('.cpb-action')).toBeNull();
  });

  // 3b. iOS Chrome (can't install) -> "open in Safari" guidance ---------------
  it('iOS Chrome (CriOS): tells the user to open in Safari, with NO action button', () => {
    setUserAgent(IOS_CHROME_UA);
    const pwa = runPwa();
    pwa.fire('load');
    vi.advanceTimersByTime(2600);

    const banner = document.getElementById('calendoPwaBanner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/open .*in Safari/i);
    expect(banner.querySelector('.cpb-action')).toBeNull();
  });

  // 3c. Android in-app webview -> "Open in Chrome" action ---------------------
  it('Android in-app webview (wv): shows an "Open in Chrome" action to escape the webview', () => {
    setUserAgent(ANDROID_WV_UA);
    const pwa = runPwa();
    pwa.fire('load');
    vi.advanceTimersByTime(2600);

    const banner = document.getElementById('calendoPwaBanner');
    expect(banner).not.toBeNull();
    const action = banner.querySelector('.cpb-action');
    expect(action).not.toBeNull();
    expect(action.textContent).toMatch(/chrome/i);
  });

  // 4. Dashboard (mobile): banner STILL shows even though #pwaInstallBtn exists.
  // On mobile the sidebar install button is hidden behind the hamburger, so the
  // banner is the only visible install affordance — it must appear. The sidebar
  // button is also un-hidden (for desktop, where CSS hides the banner instead).
  it('shows the banner on mobile even when #pwaInstallBtn exists (dashboard), and reveals the sidebar button too', () => {
    const btn = document.createElement('button');
    btn.id = 'pwaInstallBtn';
    btn.hidden = true;
    document.body.appendChild(btn);

    const pwa = runPwa();
    pwa.fire('beforeinstallprompt', makeBipEvent());
    vi.advanceTimersByTime(2600);

    // Banner appears (mobile path), AND the sidebar button is revealed for desktop.
    expect(document.getElementById('calendoPwaBanner')).not.toBeNull();
    expect(btn.hidden).toBe(false);
  });

  // 5. Suppressed on desktop -------------------------------------------------
  it('does NOT show the banner on desktop (max-width:768px does not match)', () => {
    stubMatchMedia({ mobile: false, standalone: false });
    const pwa = runPwa();
    pwa.fire('beforeinstallprompt', makeBipEvent());
    vi.advanceTimersByTime(2600);
    expect(document.getElementById('calendoPwaBanner')).toBeNull();
  });

  // 6. Suppressed when already installed (standalone) ------------------------
  it('does NOT show the banner when running standalone (display-mode:standalone)', () => {
    stubMatchMedia({ mobile: true, standalone: true });
    const pwa = runPwa();
    pwa.fire('beforeinstallprompt', makeBipEvent());
    vi.advanceTimersByTime(2600);
    expect(document.getElementById('calendoPwaBanner')).toBeNull();
  });

  // 7. Dismiss + cooldown ----------------------------------------------------
  it('dismiss (.cpb-close) removes the banner, records the dismissal, and suppresses re-show within cooldown', () => {
    const pwa = runPwa();
    pwa.fire('beforeinstallprompt', makeBipEvent());
    vi.advanceTimersByTime(2600);

    const banner = document.getElementById('calendoPwaBanner');
    expect(banner).not.toBeNull();
    const close = banner.querySelector('.cpb-close');
    expect(close).not.toBeNull();

    clickEl(close);
    expect(document.getElementById('calendoPwaBanner')).toBeNull();
    expect(localStorage.getItem('calendo_pwa_banner_dismissed')).toBeTruthy();

    // A fresh eval + event within the cooldown window must NOT re-show it.
    const pwa2 = runPwa();
    pwa2.fire('beforeinstallprompt', makeBipEvent());
    vi.advanceTimersByTime(2600);
    expect(document.getElementById('calendoPwaBanner')).toBeNull();
  });

  // 8. Post-install confirmation (Android "where did it go?" fix) -------------
  it('on appinstalled, shows a confirmation telling the user where the app went', () => {
    const pwa = runPwa();
    pwa.fire('appinstalled');

    const banner = document.getElementById('calendoPwaBanner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/installed/i);
    // Mobile guidance: where to find it + how to pin it.
    expect(banner.textContent).toMatch(/app drawer|home screen/i);
    const action = banner.querySelector('.cpb-action');
    expect(action).not.toBeNull();
    expect(action.textContent).toMatch(/got it/i);
    // "Got it" dismisses the confirmation.
    clickEl(action);
    expect(document.getElementById('calendoPwaBanner')).toBeNull();
  });
});
