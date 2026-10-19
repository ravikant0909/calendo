// Calendo Embed - Embeddable scheduling widget
// Usage:
//   <script src="https://calendo.dev/embed.js" data-calendo-user="username"></script>
//   <script src="https://calendo.dev/embed.js" data-calendo-user="username" data-calendo-event="30-minute-call" data-calendo-mode="popup"></script>
//
// Modes:
//   inline  - renders scheduler directly in a container div
//   popup   - opens scheduler in a modal on button click
//   badge   - floating button in bottom-right corner
//
// Data attributes:
//   data-calendo-user    - required, the booking page slug
//   data-calendo-event   - optional, specific event type slug
//   data-calendo-mode    - "inline" | "popup" | "badge" (default: "badge")
//   data-calendo-color   - primary color (default: "#2563eb")
//   data-calendo-text    - button text (default: "Book a meeting")

(function () {
  'use strict';

  const script = document.currentScript;
  if (!script) return;

  const config = {
    user: script.getAttribute('data-calendo-user'),
    event: script.getAttribute('data-calendo-event') || '',
    mode: script.getAttribute('data-calendo-mode') || 'badge',
    color: script.getAttribute('data-calendo-color') || '#2563eb',
    text: script.getAttribute('data-calendo-text') || 'Book a meeting',
    origin: script.src ? new URL(script.src).origin : window.location.origin,
  };

  if (!config.user) {
    console.error('Calendo Embed: data-calendo-user attribute is required');
    return;
  }

  const bookingUrl = `${config.origin}/booking/?user=${config.user}${config.event ? '&event=' + config.event : ''}`;

  function injectStyles() {
    if (document.getElementById('calendo-embed-styles')) return;
    const style = document.createElement('style');
    style.id = 'calendo-embed-styles';
    style.textContent = `
      .calendo-badge {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        background: ${config.color}; color: #fff; border: none; border-radius: 50px;
        padding: 14px 24px; cursor: pointer; font-size: 15px; font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: transform 0.15s;
        display: flex; align-items: center; gap: 8px;
      }
      .calendo-badge:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.25); }
      .calendo-badge svg { width: 18px; height: 18px; }
      .calendo-popup-btn {
        background: ${config.color}; color: #fff; border: none; border-radius: 8px;
        padding: 12px 24px; cursor: pointer; font-size: 15px; font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .calendo-popup-btn:hover { opacity: 0.9; }
      .calendo-overlay {
        position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        animation: calendo-fade-in 0.2s ease-out;
      }
      @keyframes calendo-fade-in { from { opacity: 0; } to { opacity: 1; } }
      .calendo-modal {
        width: 90vw; max-width: 520px; height: 80vh; max-height: 700px;
        background: #fff; border-radius: 16px; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3); position: relative;
        animation: calendo-scale-in 0.2s ease-out;
      }
      @keyframes calendo-scale-in { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      .calendo-modal-close {
        position: absolute; top: 12px; right: 12px; z-index: 1;
        background: rgba(0,0,0,0.05); border: none; border-radius: 50%;
        width: 32px; height: 32px; font-size: 18px; cursor: pointer;
        display: flex; align-items: center; justify-content: center; color: #64748b;
      }
      .calendo-modal-close:hover { background: rgba(0,0,0,0.1); }
      .calendo-iframe { width: 100%; height: 100%; border: none; }
      .calendo-inline { width: 100%; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; min-height: 500px; }
      .calendo-inline iframe { width: 100%; height: 600px; border: none; }
    `;
    document.head.appendChild(style);
  }

  function openModal() {
    const overlay = document.createElement('div');
    overlay.className = 'calendo-overlay';
    overlay.innerHTML = `
      <div class="calendo-modal">
        <button class="calendo-modal-close">&times;</button>
        <iframe class="calendo-iframe" src="${bookingUrl}&embed=1"></iframe>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.calendo-modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
    });
  }

  function init() {
    injectStyles();

    if (config.mode === 'badge') {
      const badge = document.createElement('button');
      badge.className = 'calendo-badge';
      badge.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        ${config.text}
      `;
      badge.addEventListener('click', openModal);
      document.body.appendChild(badge);
    } else if (config.mode === 'popup') {
      // Replace the script tag with a button
      const btn = document.createElement('button');
      btn.className = 'calendo-popup-btn';
      btn.textContent = config.text;
      btn.addEventListener('click', openModal);
      script.parentNode.insertBefore(btn, script);
    } else if (config.mode === 'inline') {
      const container = document.createElement('div');
      container.className = 'calendo-inline';
      container.innerHTML = `<iframe src="${bookingUrl}&embed=1"></iframe>`;
      script.parentNode.insertBefore(container, script);
    }
  }

  // Re-dispatch the booking-confirmed message from the iframe as a DOM event on
  // the host page, so badge/popup/inline hosts can hook conversion tracking
  // (parity with embed/calendo-embed.js).
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'calendo:booking-confirmed') return;
    var ev;
    try { ev = new CustomEvent('calendo:booking-confirmed', { detail: e.data }); }
    catch (x) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('calendo:booking-confirmed', true, true, e.data); }
    window.dispatchEvent(ev);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
