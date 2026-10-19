import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// FEATURE #5 — AI Mode toggle confusing on mobile.
//
// On mobile the panel is already fullscreen, so the "AI Mode" toggle is
// meaningless; worse, the old click handler called
// `panel.classList.remove('mobile-open')`, which closed the panel and dumped
// the user back to the dashboard. The fix:
//   1. Add a dedicated X close button (#aiMobileClose) to the panel header.
//   2. Rename the "Clear" button class from ai-panel-close -> ai-panel-clear
//      so it can no longer double as a close button.
//   3. In @media (max-width: 768px): hide #aiModeToggleLabel (display:none)
//      and show #aiMobileClose (display:flex).
//   4. Make the aiModeToggle click handler a no-op on mobile
//      (window.innerWidth <= 768) and NOT remove 'mobile-open' there anymore.
//   5. Wire #aiMobileClose to remove 'mobile-open' and restore the FAB.
//
// The dashboard JS/CSS is inline in the HTML, so these are source-structure
// assertions (matching the existing style in
// tests/unit/worker/responsive-dashboard.test.js): assert the fix markers are
// present AND the old buggy patterns are absent, so each test fails if the fix
// were reverted.
// ---------------------------------------------------------------------------

const dashboardHtml = readFileSync(
  join(__dirname, '../../../public/dashboard/index.html'),
  'utf-8'
);

// Slice out the inline <head> CSS so media-query assertions don't accidentally
// match markup elsewhere in the document.
const styleMatch = dashboardHtml.match(/<style>([\s\S]*?)<\/style>/);
const css = styleMatch ? styleMatch[1] : '';

// Slice out the 768px media query block (mobile CSS).
const mobileMediaMatch = dashboardHtml.match(
  /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/
);
const mobileCSS = mobileMediaMatch ? mobileMediaMatch[1] : '';

// Slice out the AI panel header markup (between the opening header div and the
// messages list).
const headerMatch = dashboardHtml.match(
  /<div class="ai-panel-header">([\s\S]*?)<div class="ai-panel-messages"/
);
const headerHtml = headerMatch ? headerMatch[1] : '';

// Slice out the aiModeToggle click handler body. It starts at the
// addEventListener registration and runs to the next `});`.
const toggleHandlerMatch = dashboardHtml.match(
  /aiModeToggle\.parentElement\.addEventListener\('click',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/
);
const toggleHandler = toggleHandlerMatch ? toggleHandlerMatch[1] : '';

// Slice out the mobile FAB / mobile-close wiring block.
const fabWiringMatch = dashboardHtml.match(
  /const aiFab = document\.getElementById\('mobileAiFab'\);([\s\S]*?)\n\s*\}\n\s*\}/
);
const fabWiring = fabWiringMatch ? fabWiringMatch[1] : '';

describe('FEATURE #5 — AI Mode toggle on mobile', () => {
  // ========================================================================
  // 1. Dedicated close (X) button in the AI panel header
  // ========================================================================
  describe('dedicated mobile close button', () => {
    it('extracts the AI panel header markup', () => {
      expect(headerHtml.length).toBeGreaterThan(0);
    });

    it('has a close button with id "aiMobileClose"', () => {
      expect(headerHtml).toMatch(/id="aiMobileClose"/);
    });

    it('renders the X glyph (&times;) inside the close button', () => {
      // The button content is the X — assert the close button markup carries &times;
      expect(headerHtml).toMatch(/id="aiMobileClose"[^>]*>&times;<\/button>/);
    });

    it('the close button lives inside the AI panel header (not elsewhere)', () => {
      // Reconfirm it is scoped to the sliced header, not just anywhere in doc.
      const inHeader = headerHtml.includes('id="aiMobileClose"');
      expect(inHeader).toBe(true);
    });

    it('the close button is a styled real button (class "ai-panel-close")', () => {
      // The X must be an actual styled close button, not a bare element. It
      // reuses the existing .ai-panel-close styling (and the mobile media query
      // sizes it to a 44px tap target). Either class/id order is acceptable.
      expect(headerHtml).toMatch(
        /<button[^>]*class="ai-panel-close"[^>]*id="aiMobileClose"|<button[^>]*id="aiMobileClose"[^>]*class="ai-panel-close"/
      );
    });

    it('.ai-panel-close is styled in CSS (the X button has visible styling)', () => {
      expect(css).toMatch(/\.ai-panel-close\s*\{/);
    });
  });

  // ========================================================================
  // 2. "Clear" button is ai-panel-clear, not ai-panel-close
  // ========================================================================
  describe('Clear button can no longer double as close', () => {
    it('#aiClearChat uses class "ai-panel-clear"', () => {
      expect(dashboardHtml).toMatch(
        /<button[^>]*class="ai-panel-clear"[^>]*id="aiClearChat"|<button[^>]*id="aiClearChat"[^>]*class="ai-panel-clear"/
      );
    });

    it('#aiClearChat is NOT given class "ai-panel-close" anymore (old bug)', () => {
      // Old buggy markup gave the Clear button class="ai-panel-close" so it
      // doubled as a close button. Assert that combination is gone.
      expect(dashboardHtml).not.toMatch(
        /<button[^>]*class="ai-panel-close"[^>]*id="aiClearChat"|<button[^>]*id="aiClearChat"[^>]*class="ai-panel-close"/
      );
    });

    it('a CSS rule for .ai-panel-clear exists (the new class is styled)', () => {
      expect(css).toMatch(/\.ai-panel-clear\s*\{/);
    });
  });

  // ========================================================================
  // 3. Mobile media query hides the toggle label, shows the close button
  // ========================================================================
  describe('mobile media query (max-width: 768px)', () => {
    it('extracts a non-empty mobile CSS block', () => {
      expect(mobileMediaMatch).not.toBeNull();
      expect(mobileCSS.length).toBeGreaterThan(0);
    });

    it('hides #aiModeToggleLabel with display:none on mobile', () => {
      expect(mobileCSS).toMatch(/#aiModeToggleLabel\s*\{[^}]*display:\s*none/);
    });

    it('shows #aiMobileClose with display:flex on mobile', () => {
      expect(mobileCSS).toMatch(/#aiMobileClose\s*\{[^}]*display:\s*flex/);
    });
  });

  // ========================================================================
  // 4. aiModeToggle click handler is a no-op on mobile and no longer closes
  //    the panel (that was the bug)
  // ========================================================================
  describe('aiModeToggle click handler', () => {
    it('extracts the toggle click handler body', () => {
      expect(toggleHandlerMatch).not.toBeNull();
      expect(toggleHandler.length).toBeGreaterThan(0);
    });

    it('returns early / no-ops on mobile (window.innerWidth <= 768)', () => {
      expect(toggleHandler).toMatch(/if\s*\(\s*window\.innerWidth\s*<=\s*768\s*\)\s*return/);
    });

    it('does NOT remove "mobile-open" inside the toggle handler (the old bug)', () => {
      expect(toggleHandler).not.toMatch(/classList\.remove\(['"]mobile-open['"]\)/);
    });

    it('still toggles desktop fullscreen mode (handler is not gutted)', () => {
      // Sanity: the handler still does its real (desktop) job — proves we
      // matched the right block, so the "absent mobile-open" assertion is real.
      expect(toggleHandler).toMatch(/classList\.toggle\(['"]ai-fullscreen['"]\)/);
    });
  });

  // ========================================================================
  // 5. Mobile close wiring: #aiMobileClose removes 'mobile-open' + restores FAB
  // ========================================================================
  describe('mobile close button wiring', () => {
    it('extracts the FAB / mobile-close wiring block', () => {
      expect(fabWiringMatch).not.toBeNull();
      expect(fabWiring.length).toBeGreaterThan(0);
    });

    it('looks up #aiMobileClose to attach the close handler', () => {
      expect(fabWiring).toMatch(/getElementById\(['"]aiMobileClose['"]\)/);
    });

    it('listens for "click" on the mobile close button', () => {
      expect(fabWiring).toMatch(/aiMobileClose\.addEventListener\(['"]click['"]/);
    });

    it('removes the "mobile-open" class to close the panel', () => {
      expect(fabWiring).toMatch(/aiPanel\.classList\.remove\(['"]mobile-open['"]\)/);
    });

    it('restores the FAB (display:flex) after closing', () => {
      expect(fabWiring).toMatch(/aiFab\.style\.display\s*=\s*['"]flex['"]/);
    });

    it('the close wiring does NOT route through "aiClearChat" anymore (old bug)', () => {
      // The pre-fix close path was the "Clear" button (aiClearChat) doubling as
      // close. The dedicated mobile-close wiring block must not reference it —
      // Clear now only clears the chat, the X (aiMobileClose) is the only closer.
      expect(fabWiring).not.toMatch(/aiClearChat/);
    });
  });
});
