import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PUB = (p) => join(ROOT, 'public', p);

// ---------------------------------------------------------------------------
// Manifest: valid, complete, and every icon actually exists on disk.
// (The old manifest pointed at /icon-192.png and /icon-512.png which did NOT
// exist, so install showed a broken/blank icon — this guards against that.)
// ---------------------------------------------------------------------------
describe('PWA manifest', () => {
  const manifest = JSON.parse(readFileSync(PUB('manifest.json'), 'utf8'));

  it('has the required installability fields', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#2563eb');
    expect(manifest.background_color).toBe('#ffffff');
    expect(Array.isArray(manifest.icons)).toBe(true);
  });

  it('every icon src exists on disk', () => {
    for (const icon of manifest.icons) {
      const rel = icon.src.replace(/^\//, '');
      expect(existsSync(PUB(rel)), `${icon.src} should exist`).toBe(true);
    }
  });

  it('provides a 192, a 512, and a maskable icon', () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i) => (i.purpose || '').includes('maskable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Service worker: behavioral test of the caching rules. The #1 rule is that
// /api/* is NEVER intercepted (a cached "free" slot could cause a double-book).
// ---------------------------------------------------------------------------
describe('Service worker behavior', () => {
  const swSource = readFileSync(PUB('service-worker.js'), 'utf8');

  function loadSW() {
    const handlers = {};
    const self = {
      addEventListener: (type, cb) => { handlers[type] = cb; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      location: { origin: 'https://calendo.dev' },
    };
    const caches = {
      open: async () => ({ add: async () => {}, put: async () => {}, match: async () => undefined }),
      match: async () => undefined,
      keys: async () => [],
      delete: async () => {},
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, type: 'basic', clone: () => ({}) }));
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', swSource)(self, caches, fetchMock);
    return { handlers, fetchMock };
  }

  const evt = (request) => ({ request, respondWith: vi.fn() });

  it('NEVER intercepts /api/* GET requests (passes straight through to network)', () => {
    const { handlers } = loadSW();
    const e = evt({ method: 'GET', url: 'https://calendo.dev/api/public/x/y/slots', mode: 'cors' });
    handlers.fetch(e);
    expect(e.respondWith).not.toHaveBeenCalled();
  });

  it('never intercepts non-GET requests (bookings, logins, etc.)', () => {
    const { handlers } = loadSW();
    const e = evt({ method: 'POST', url: 'https://calendo.dev/api/bookings', mode: 'cors' });
    handlers.fetch(e);
    expect(e.respondWith).not.toHaveBeenCalled();
  });

  it('never intercepts cross-origin requests', () => {
    const { handlers } = loadSW();
    const e = evt({ method: 'GET', url: 'https://www.googleapis.com/oauth2/v2/userinfo', mode: 'cors' });
    handlers.fetch(e);
    expect(e.respondWith).not.toHaveBeenCalled();
  });

  it('handles navigations (so it can fall back to offline.html)', () => {
    const { handlers } = loadSW();
    const e = evt({ method: 'GET', url: 'https://calendo.dev/dashboard/', mode: 'navigate' });
    handlers.fetch(e);
    expect(e.respondWith).toHaveBeenCalledTimes(1);
  });

  it('handles same-origin static assets (stale-while-revalidate)', () => {
    const { handlers } = loadSW();
    const e = evt({ method: 'GET', url: 'https://calendo.dev/favicon-32.png', mode: 'no-cors' });
    handlers.fetch(e);
    expect(e.respondWith).toHaveBeenCalledTimes(1);
  });

  it('precaches the offline fallback at the clean URL (avoids the .html→/offline 307)', () => {
    expect(swSource).toContain("'/offline'");
    expect(swSource).not.toContain("'/offline.html'");
    expect(existsSync(PUB('offline.html'))).toBe(true); // file on disk; served at /offline
  });
});

// ---------------------------------------------------------------------------
// Registration + page wiring.
// ---------------------------------------------------------------------------
describe('PWA registration + page wiring', () => {
  it('pwa.js registers the service worker', () => {
    const src = readFileSync(PUB('pwa.js'), 'utf8');
    expect(src).toContain("navigator.serviceWorker");
    expect(src).toContain("register('/service-worker.js'");
  });

  it('pwa.js wires the install-click handler only once (beforeinstallprompt can refire)', () => {
    const src = readFileSync(PUB('pwa.js'), 'utf8');
    expect(src).toContain('pwaWired');
  });

  it('dashboard forces the install button hidden (btn-logout display:block would override [hidden])', () => {
    const dash = readFileSync(PUB('dashboard/index.html'), 'utf8');
    expect(dash).toContain('#pwaInstallBtn[hidden] { display: none; }');
  });

  it('landing page has a "Get the app" install section with QR + platform branches', () => {
    const landing = readFileSync(PUB('index.html'), 'utf8');
    expect(landing).toContain('id="get-app"');
    expect(landing).toContain('href="#get-app"');           // nav/footer entry points
    expect(landing).toContain('/install-qr.png');           // desktop QR
    expect(landing).toContain('id="getAppIos"');            // iOS Add-to-Home-Screen steps
    expect(landing).toContain('id="getAppAndroid"');        // Android install button branch
    expect(landing).toContain('id="pwaInstallBtn"');        // the install button (revealed by pwa.js)
  });

  it('the install QR image exists on disk', () => {
    expect(existsSync(PUB('install-qr.png'))).toBe(true);
  });

  it('every HTML page links the manifest and loads pwa.js', () => {
    const htmlFiles = [];
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith('.html')) htmlFiles.push(abs);
      }
    })(join(ROOT, 'public'));

    expect(htmlFiles.length).toBeGreaterThan(10);
    for (const f of htmlFiles) {
      const s = readFileSync(f, 'utf8');
      expect(s, `${f} should link the manifest`).toContain('rel="manifest"');
      expect(s, `${f} should load /pwa.js`).toContain('/pwa.js');
      expect(s, `${f} should set theme-color`).toContain('name="theme-color"');
    }
  });
});
