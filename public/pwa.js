/*
 * Calendo PWA bootstrap (loaded on every page via <script src="/pwa.js" defer>).
 *  - Registers the service worker.
 *  - Injects iOS/install <meta>+<link> tags so "Add to Home Screen" looks right.
 *  - Reveals the dashboard sidebar install button (#pwaInstallBtn) on desktop.
 *  - On mobile, shows a small dismissible install banner tailored to the
 *    environment, because "install a PWA" differs a lot per platform/browser:
 *      • Android + real browser  -> native install prompt ("Install").
 *      • Android + in-app webview -> "Open in Chrome" (jumps out via intent URL),
 *        since PWAs can't be installed from in-app webviews (Gmail, FB, etc.).
 *      • iOS Safari              -> "Share -> Add to Home Screen".
 *      • iOS Chrome/other/webview -> "Open in Safari first" (only Safari can add
 *        to the home screen on iOS).
 *  Banner is mobile-only, hidden once installed, dismissible (14-day cooldown).
 */
(function () {
  // --- Service worker ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker
        .register('/service-worker.js', { updateViaCache: 'none' })
        .catch(function (err) { console.warn('Calendo SW registration failed:', err); });
    });
  }

  // --- iOS / install metadata (idempotent) ---
  function ensureMeta(name, content) {
    if (!document.head || document.querySelector('meta[name="' + name + '"]')) return;
    var m = document.createElement('meta'); m.name = name; m.content = content;
    document.head.appendChild(m);
  }
  function ensureLink(rel, href) {
    if (!document.head || document.querySelector('link[rel="' + rel + '"]')) return;
    var l = document.createElement('link'); l.rel = rel; l.href = href;
    document.head.appendChild(l);
  }
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-status-bar-style', 'default');
  ensureMeta('apple-mobile-web-app-title', 'Calendo');
  ensureLink('apple-touch-icon', '/apple-touch-icon.png');
  ensureLink('manifest', '/manifest.json');

  var ua = navigator.userAgent || '';
  var deferredPrompt = null;

  // --- Environment detection ---
  function isAndroid() { return /android/i.test(ua); }
  function isiOS() { return /iphone|ipad|ipod/i.test(ua) && !window.MSStream; }
  function isIOSSafari() { return isiOS() && /safari/i.test(ua) && !/(crios|fxios|edgios|opios|mercury)/i.test(ua); }
  function isInAppBrowser() {
    return /\bwv\b/.test(ua) ||  // Android System WebView
      /(FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|LinkedInApp|MicroMessenger|Snapchat|Pinterest|GSA\/)/i.test(ua);
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }
  function isMobile() { return window.matchMedia && window.matchMedia('(max-width: 768px)').matches; }

  // --- Dashboard sidebar install button (desktop) ---
  function onInstallClick() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () {
      deferredPrompt = null;
      var b = document.getElementById('pwaInstallBtn');
      if (b) b.hidden = true;
    });
  }
  function wireSidebarButton() {
    var btn = document.getElementById('pwaInstallBtn');
    if (!btn) return;
    btn.hidden = false;
    if (!btn.dataset.pwaWired) { btn.dataset.pwaWired = '1'; btn.addEventListener('click', onInstallClick); }
  }

  // --- Install banner ---
  var DISMISS_KEY = 'calendo_pwa_banner_dismissed';
  var COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
  var bannerMode = null;

  function recentlyDismissed() {
    try { var t = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10); return t && (Date.now() - t) < COOLDOWN_MS; }
    catch (e) { return false; }
  }
  function removeBanner() {
    var b = document.getElementById('calendoPwaBanner');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    bannerMode = null;
  }
  function dismissBanner() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
    removeBanner();
  }
  function injectBannerStyles() {
    if (document.getElementById('calendoPwaBannerStyles')) return;
    var s = document.createElement('style');
    s.id = 'calendoPwaBannerStyles';
    s.textContent =
      '.calendo-pwa-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
      'display:flex;align-items:center;gap:10px;background:#fff;color:#0f172a;' +
      'border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.18);' +
      'padding:10px 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'transform:translateY(180%);transition:transform .3s ease}' +
      '.calendo-pwa-banner.cpb-visible{transform:translateY(0)}' +
      '.calendo-pwa-banner.cpb-raised{bottom:84px}' +          // above the dashboard AI FAB
      '.calendo-pwa-banner .cpb-icon{width:36px;height:36px;border-radius:8px;flex:0 0 auto}' +
      '.calendo-pwa-banner .cpb-text{flex:1;font-size:13px;line-height:1.35}' +
      '.calendo-pwa-banner .cpb-action{background:#2563eb;color:#fff;border:none;border-radius:8px;' +
      'font-size:13px;font-weight:600;padding:9px 16px;cursor:pointer;flex:0 0 auto;white-space:nowrap}' +
      '.calendo-pwa-banner .cpb-close{background:none;border:none;color:#94a3b8;font-size:22px;' +
      'line-height:1;cursor:pointer;padding:2px 6px;flex:0 0 auto}' +
      '@media(min-width:769px){.calendo-pwa-banner{display:none}}';
    document.head.appendChild(s);
  }

  // opts: { mode, text, actionLabel?, onAction? }
  function renderBanner(opts) {
    if (!document.body) return;
    removeBanner();              // replace any existing banner (e.g. upgrade to native install)
    bannerMode = opts.mode;
    injectBannerStyles();

    var bar = document.createElement('div');
    bar.id = 'calendoPwaBanner';
    bar.className = 'calendo-pwa-banner';
    if (document.getElementById('mobileAiFab')) bar.className += ' cpb-raised';

    var icon = document.createElement('img');
    icon.className = 'cpb-icon'; icon.src = '/apple-touch-icon.png'; icon.alt = '';
    var text = document.createElement('span');
    text.className = 'cpb-text'; text.textContent = opts.text;
    bar.appendChild(icon);
    bar.appendChild(text);

    if (opts.actionLabel && opts.onAction) {
      var action = document.createElement('button');
      action.className = 'cpb-action'; action.textContent = opts.actionLabel;
      action.addEventListener('click', opts.onAction);
      bar.appendChild(action);
    }
    var close = document.createElement('button');
    close.className = 'cpb-close'; close.setAttribute('aria-label', 'Dismiss'); close.innerHTML = '&times;';
    close.addEventListener('click', dismissBanner);
    bar.appendChild(close);

    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('cpb-visible'); });
  }

  function nativeInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () { deferredPrompt = null; removeBanner(); });
  }
  function openInChrome() {
    // Jump out of an Android in-app webview into Chrome so the user can install.
    var rest = location.href.replace(/^https?:\/\//, '');
    window.location.href = 'intent://' + rest + '#Intent;scheme=https;package=com.android.chrome;end';
  }

  // Pick and show the right banner for this environment.
  function maybeShowBanner() {
    if (isStandalone() || !isMobile() || recentlyDismissed()) return;
    if (bannerMode === 'install') return;                 // best variant already up

    if (deferredPrompt) {
      renderBanner({ mode: 'install', text: 'Install Calendo for one-tap access.', actionLabel: 'Install', onAction: nativeInstall });
      return;
    }
    if (bannerMode) return;                                // some banner already shown; don't churn
    if (isiOS()) {
      renderBanner(isIOSSafari()
        ? { mode: 'ios-safari', text: 'Install Calendo: tap the Share icon, then “Add to Home Screen”.' }
        : { mode: 'ios-other', text: 'To install Calendo, open this page in Safari (⋯ or Share → “Open in Safari”), then Share → “Add to Home Screen”.' });
      return;
    }
    if (isAndroid() && isInAppBrowser()) {
      renderBanner({ mode: 'android-inapp', text: 'To install Calendo, open it in your browser.', actionLabel: 'Open in Chrome', onAction: openInChrome });
      return;
    }
    if (isAndroid()) {
      renderBanner({ mode: 'android-menu', text: 'Install Calendo: open the browser menu (⋮) and tap “Add to Home screen”.' });
    }
  }

  // --- Wire events ---
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();                 // suppress Chrome's mini-infobar; we drive install ourselves
    deferredPrompt = e;
    wireSidebarButton();
    setTimeout(maybeShowBanner, 800);   // upgrade/show the native-install banner
  });

  // After install, Android drops the icon in the app drawer (not the home screen,
  // unless the launcher is set to auto-add) — which confuses people who expect it
  // on the home screen like a Play Store app. Show a clear, jargon-free
  // confirmation of WHERE it went and how to pin it, so "where did it go?" never
  // happens. (Doesn't fire on iOS, where Add to Home Screen places it directly.)
  function renderInstalledConfirmation() {
    if (!document.body) return;
    removeBanner();
    bannerMode = 'installed';
    injectBannerStyles();
    var bar = document.createElement('div');
    bar.id = 'calendoPwaBanner';
    bar.className = 'calendo-pwa-banner';
    if (document.getElementById('mobileAiFab')) bar.className += ' cpb-raised';

    var icon = document.createElement('img');
    icon.className = 'cpb-icon'; icon.src = '/apple-touch-icon.png'; icon.alt = '';
    var text = document.createElement('span');
    text.className = 'cpb-text';
    text.innerHTML = isMobile()
      ? '<strong>Calendo installed.</strong> Find it in your app drawer (swipe up and search “Calendo”). To keep it on your home screen, long-press the icon and drag it up.'
      : '<strong>Calendo installed.</strong> Open it anytime from your apps — it now runs in its own window.';
    var action = document.createElement('button');
    action.className = 'cpb-action'; action.textContent = 'Got it';
    action.addEventListener('click', removeBanner);

    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(action);
    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('cpb-visible'); });
  }

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    var btn = document.getElementById('pwaInstallBtn'); if (btn) btn.hidden = true;
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
    renderInstalledConfirmation();
  });

  window.addEventListener('load', function () {
    setTimeout(maybeShowBanner, 1500);
  });
})();
