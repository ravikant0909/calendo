import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const dashboardHtml = readFileSync(
  join(__dirname, '../../../public/dashboard/index.html'),
  'utf-8'
);

describe('Responsive Dashboard', () => {
  describe('Viewport meta tag', () => {
    it('should have a responsive viewport meta tag', () => {
      expect(dashboardHtml).toContain('name="viewport"');
      expect(dashboardHtml).toContain('width=device-width');
      expect(dashboardHtml).toContain('initial-scale=1.0');
    });
  });

  describe('Media queries', () => {
    it('should have a 768px breakpoint for tablet/mobile', () => {
      expect(dashboardHtml).toContain('@media (max-width: 768px)');
    });

    it('should have a 375px breakpoint for small phones', () => {
      expect(dashboardHtml).toContain('@media (max-width: 375px)');
    });
  });

  describe('Sidebar responsive behavior', () => {
    it('should hide sidebar off-screen on mobile via transform', () => {
      expect(dashboardHtml).toMatch(/\.sidebar\s*\{\s*transform:\s*translateX\(-100%\)/);
    });

    it('should show sidebar when open class is added', () => {
      expect(dashboardHtml).toMatch(/\.sidebar\.open\s*\{\s*transform:\s*translateX\(0\)/);
    });

    it('should have a mobile header element', () => {
      expect(dashboardHtml).toContain('class="mobile-header"');
      expect(dashboardHtml).toContain('id="menuToggle"');
    });

    it('should display mobile header on mobile', () => {
      expect(dashboardHtml).toMatch(/\.mobile-header\s*\{\s*display:\s*flex/);
    });

    it('should have a sidebar overlay for mobile', () => {
      expect(dashboardHtml).toContain('class="sidebar-overlay"');
      expect(dashboardHtml).toContain('id="sidebarOverlay"');
    });

    it('should have touch-friendly sidebar nav items (min 44px)', () => {
      expect(dashboardHtml).toMatch(/\.sidebar-nav a\s*\{[^}]*min-height:\s*44px/);
    });
  });

  describe('AI panel mobile behavior', () => {
    it('should have a mobile AI FAB button', () => {
      expect(dashboardHtml).toContain('class="mobile-ai-fab"');
      expect(dashboardHtml).toContain('id="mobileAiFab"');
    });

    it('should hide AI FAB by default (display: none)', () => {
      expect(dashboardHtml).toMatch(/\.mobile-ai-fab\s*\{[^}]*display:\s*none/);
    });

    it('should show AI FAB on mobile (display: flex in 768px query)', () => {
      // Extract the 768px media query block
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      expect(match768).not.toBeNull();
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.mobile-ai-fab\s*\{\s*display:\s*flex/);
    });

    it('should make AI panel full-screen on mobile when open', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      expect(match768).not.toBeNull();
      const mobileCSS = match768[1];
      expect(mobileCSS).toContain('.ai-panel.mobile-open');
      expect(mobileCSS).toMatch(/\.ai-panel\s*\{[^}]*width:\s*100%/);
    });

    it('should have JS to toggle mobile AI panel via FAB', () => {
      expect(dashboardHtml).toContain("aiPanel.classList.add('mobile-open')");
      expect(dashboardHtml).toContain("aiPanel.classList.remove('mobile-open')");
    });
  });

  describe('Touch-friendly tap targets', () => {
    it('should have minimum 44px buttons in mobile breakpoint', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      expect(match768).not.toBeNull();
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.btn\s*\{[^}]*min-height:\s*44px/);
      expect(mobileCSS).toMatch(/\.filter-btn\s*\{[^}]*min-height:\s*44px/);
    });
  });

  describe('Layout stacking on mobile', () => {
    it('should stack stats grid to single column', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.stats-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    });

    it('should stack event type cards to single column', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.event-types-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    });

    it('should stack form grids to single column', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.form-grid-2\s*\{[^}]*grid-template-columns:\s*1fr/);
    });

    it('should make meeting timeline rows full-width (no left margin)', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.meeting-row\s*\{[^}]*margin-left:\s*0/);
    });

    it('should make edit panel full-screen on mobile', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toContain('#editEtPanel');
      expect(mobileCSS).toMatch(/width:\s*100vw/);
    });

    it('should stack page headers vertically', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.page-header\s*\{[^}]*flex-direction:\s*column/);
    });
  });

  describe('Calendar grid scrollability', () => {
    it('should make calendar view grid horizontally scrollable on mobile', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/#calendarViewGrid\s*\{[^}]*overflow-x:\s*auto/);
    });
  });

  describe('Typography on mobile', () => {
    it('should set readable body font size on mobile', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/body\s*\{[^}]*font-size:\s*14px/);
    });

    it('should reduce heading sizes on mobile', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/h1\s*\{[^}]*font-size:\s*22px/);
      expect(mobileCSS).toMatch(/h2\s*\{[^}]*font-size:\s*18px/);
    });
  });

  describe('Content no longer cut off', () => {
    it('should remove main content left margin on mobile', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.main-content\s*\{[^}]*margin-left:\s*0/);
      expect(mobileCSS).toMatch(/\.main-content\s*\{[^}]*margin-right:\s*0/);
    });

    it('should make availability overrides layout single column', () => {
      const match768 = dashboardHtml.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\/\*\s*Toggle switch)/);
      const mobileCSS = match768[1];
      expect(mobileCSS).toMatch(/\.avail-overrides-layout\s*\{[^}]*grid-template-columns:\s*1fr/);
    });
  });
});
