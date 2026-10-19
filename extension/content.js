// Calendo Gmail Content Script
// Adds a "Calendo" button to Gmail compose windows to insert booking links.

(function () {
  'use strict';

  const BUTTON_CLASS = 'calendo-insert-btn';
  const TOOLBAR_SELECTOR = '.btC';
  const COMPOSE_BODY_SELECTOR = '.Am.Al.editable';

  // Track which compose windows already have a button
  const processedToolbars = new WeakSet();

  /**
   * Create the Calendo insert button element.
   */
  function createCalendoButton() {
    const btn = document.createElement('div');
    btn.className = BUTTON_CLASS;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', 'Insert Calendo booking link');
    btn.setAttribute('data-tooltip', 'Insert Calendo booking link');
    btn.textContent = 'Calendo';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      insertBookingLink(btn);
    });

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        insertBookingLink(btn);
      }
    });

    return btn;
  }

  /**
   * Insert the booking link into the compose body.
   */
  function insertBookingLink(buttonEl) {
    chrome.storage.sync.get(['calendoBookingLink'], (result) => {
      const link = result.calendoBookingLink;
      if (!link) {
        showTooltip(buttonEl, 'Set your link in extension settings first');
        return;
      }

      // Find the compose body closest to this button
      const composeWindow = buttonEl.closest('.M9');
      if (!composeWindow) return;

      const composeBody = composeWindow.querySelector(COMPOSE_BODY_SELECTOR);
      if (!composeBody) return;

      // Build the HTML to insert
      const html = `<br><br>Book a time with me: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a><br>`;

      // Insert at cursor if there is a selection inside the compose body,
      // otherwise append to the end.
      const selection = window.getSelection();
      if (selection.rangeCount > 0 && composeBody.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const fragment = createFragment(html);
        range.insertNode(fragment);
        // Move cursor after the inserted content
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        composeBody.innerHTML += html;
      }

      showTooltip(buttonEl, 'Link inserted!');
    });
  }

  /**
   * Create a document fragment from an HTML string.
   */
  function createFragment(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const fragment = document.createDocumentFragment();
    while (temp.firstChild) {
      fragment.appendChild(temp.firstChild);
    }
    return fragment;
  }

  /**
   * Escape HTML special characters to prevent XSS.
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Show a brief tooltip/notification near the button.
   */
  function showTooltip(buttonEl, message) {
    // Remove any existing tooltip
    const existing = buttonEl.parentElement.querySelector('.calendo-tooltip');
    if (existing) existing.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'calendo-tooltip';
    tooltip.textContent = message;
    buttonEl.parentElement.appendChild(tooltip);

    // Position the tooltip above the button
    const btnRect = buttonEl.getBoundingClientRect();
    const parentRect = buttonEl.parentElement.getBoundingClientRect();
    tooltip.style.left = (btnRect.left - parentRect.left) + 'px';
    tooltip.style.bottom = (parentRect.bottom - btnRect.top + 4) + 'px';

    setTimeout(() => tooltip.remove(), 2500);
  }

  /**
   * Scan for Gmail compose windows and add the Calendo button.
   */
  function scanForComposeWindows() {
    const toolbars = document.querySelectorAll(TOOLBAR_SELECTOR);
    toolbars.forEach((toolbar) => {
      if (processedToolbars.has(toolbar)) return;
      processedToolbars.add(toolbar);

      const btn = createCalendoButton();
      toolbar.appendChild(btn);
    });
  }

  /**
   * Start observing the DOM for new compose windows.
   */
  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        scanForComposeWindows();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Initial scan
    scanForComposeWindows();
  }

  // Wait for Gmail to finish loading, then start observing
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();
