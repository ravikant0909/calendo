import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The product-tour engine is inline in public/dashboard/index.html. We extract
// the two pure/data pieces — shouldShowProductTour() and PRODUCT_TOUR_STEPS —
// by reading the HTML and evaling the exact shipped slices (same read+slice+eval
// pattern as qr-generator.test.js). This guarantees the tests fail if the
// shipped logic/data is reverted, rather than testing a re-implemented copy.
// ---------------------------------------------------------------------------

const html = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

function loadTourSteps() {
  const start = html.indexOf('const PRODUCT_TOUR_STEPS = [');
  expect(start).toBeGreaterThan(-1);
  // Slice from the opening through the terminating "];" of the array literal.
  const arrStart = html.indexOf('[', start);
  const arrEnd = html.indexOf('];', arrStart);
  expect(arrEnd).toBeGreaterThan(arrStart);
  const expr = html.slice(arrStart, arrEnd + 1);
  // eslint-disable-next-line no-eval
  return eval('(' + expr + ')');
}

function loadShouldShow() {
  const start = html.indexOf('function shouldShowProductTour(user) {');
  expect(start).toBeGreaterThan(-1);
  const bodyEnd = html.indexOf('}', start);
  expect(bodyEnd).toBeGreaterThan(start);
  const src = html.slice(start, bodyEnd + 1);
  // eslint-disable-next-line no-eval
  return eval('(' + src + ')');
}

describe('Product tour client engine', () => {
  const PRODUCT_TOUR_STEPS = loadTourSteps();
  const shouldShowProductTour = loadShouldShow();

  // ========================================================================
  // shouldShowProductTour — auto-launch gate
  // ========================================================================
  describe('shouldShowProductTour', () => {
    it('returns falsy for null', () => {
      expect(shouldShowProductTour(null)).toBeFalsy();
    });

    it('returns falsy for undefined', () => {
      expect(shouldShowProductTour(undefined)).toBeFalsy();
    });

    it('returns falsy when onboarding is not completed', () => {
      expect(shouldShowProductTour({ onboarding_completed: 0, product_tour_completed: 0 })).toBeFalsy();
    });

    it('returns falsy when onboarding_completed is missing', () => {
      expect(shouldShowProductTour({ product_tour_completed: 0 })).toBeFalsy();
    });

    it('returns falsy when the tour was already completed', () => {
      expect(shouldShowProductTour({ onboarding_completed: 1, product_tour_completed: 1 })).toBeFalsy();
    });

    it('returns TRUE when onboarded but tour not yet completed', () => {
      expect(shouldShowProductTour({ onboarding_completed: 1, product_tour_completed: 0 })).toBe(true);
    });

    it('still gates on tour completion even if onboarded (truthy tour flag)', () => {
      // Guards the && !user.product_tour_completed half of the condition: any
      // truthy completion value must suppress the tour.
      expect(shouldShowProductTour({ onboarding_completed: 1, product_tour_completed: 1 })).toBeFalsy();
    });
  });

  // ========================================================================
  // PRODUCT_TOUR_STEPS — shape & content
  // ========================================================================
  describe('PRODUCT_TOUR_STEPS', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(PRODUCT_TOUR_STEPS)).toBe(true);
      expect(PRODUCT_TOUR_STEPS.length).toBeGreaterThan(0);
    });

    it('every step has a non-empty id, title and body string', () => {
      for (const step of PRODUCT_TOUR_STEPS) {
        expect(typeof step.id).toBe('string');
        expect(step.id.length).toBeGreaterThan(0);
        expect(typeof step.title).toBe('string');
        expect(step.title.length).toBeGreaterThan(0);
        expect(typeof step.body).toBe('string');
        expect(step.body.length).toBeGreaterThan(0);
      }
    });

    it('step ids are unique', () => {
      const ids = PRODUCT_TOUR_STEPS.map(s => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('targets the expected dashboard elements', () => {
      const targets = PRODUCT_TOUR_STEPS.map(s => s.target);
      expect(targets).toContain('#bookingLinkBar');
      expect(targets).toContain('#overviewCreateEtBtn');
      expect(targets).toContain('#scheduleChip');
      expect(targets).toContain('#calendarSetupCard');
      expect(targets).toContain('#aiPanel');
    });

    it('the AI step has a mobile target pointing at the FAB', () => {
      const aiStep = PRODUCT_TOUR_STEPS.find(s => s.target === '#aiPanel');
      expect(aiStep).toBeTruthy();
      expect(aiStep.mobileTarget).toBe('#mobileAiFab');
    });

    it('only the AI step carries a mobileTarget override', () => {
      // The mobile FAB fallback is specific to the AI panel (the desktop sidebar
      // becomes a FAB on phones). Any other step gaining a mobileTarget — or the
      // AI step losing it — should fail here.
      const withMobile = PRODUCT_TOUR_STEPS.filter(s => s.mobileTarget != null);
      expect(withMobile.map(s => s.target)).toEqual(['#aiPanel']);
      expect(withMobile.map(s => s.mobileTarget)).toEqual(['#mobileAiFab']);
    });

    it('first step is a centered welcome intro with no target', () => {
      expect(PRODUCT_TOUR_STEPS[0].target).toBeNull();
      expect(PRODUCT_TOUR_STEPS[0].id).toBe('welcome');
    });

    it('last step is a centered outro with no target', () => {
      const last = PRODUCT_TOUR_STEPS[PRODUCT_TOUR_STEPS.length - 1];
      expect(last.target).toBeNull();
      expect(last.id).toBe('done');
    });

    it('only the first and last steps are untargeted (all middle steps point somewhere)', () => {
      const middle = PRODUCT_TOUR_STEPS.slice(1, -1);
      for (const step of middle) {
        expect(typeof step.target).toBe('string');
        expect(step.target.length).toBeGreaterThan(0);
      }
    });
  });

  // ========================================================================
  // Source / DOM structure assertions on the shipped HTML
  // ========================================================================
  describe('tour DOM scaffolding present in dashboard HTML', () => {
    it('defines the .tour-overlay style hook', () => {
      expect(html).toMatch(/\.tour-overlay\s*\{/);
    });

    it('defines the .tour-spotlight style hook', () => {
      expect(html).toMatch(/\.tour-spotlight\s*\{/);
    });

    it('defines the .tour-card style hook', () => {
      expect(html).toMatch(/\.tour-card\s*\{/);
    });

    it('ships a replay button with id="takeTourBtn"', () => {
      expect(html).toMatch(/id="takeTourBtn"/);
    });

    it('the replay button wires a click handler into ProductTour.start', () => {
      // Functional-ish source assertion: the replay button must register a click
      // listener that actually launches the tour. Require the listener + start()
      // call together (not just loose proximity) so a stubbed/no-op handler fails.
      expect(html).toMatch(/takeTourBtn\.addEventListener\(\s*['"]click['"][\s\S]{0,200}ProductTour\.start\(\)/);
    });

    it('the auto-launch gate function is actually consumed (not dead code)', () => {
      // shouldShowProductTour() is only useful if something gates the auto-launch
      // on it. Guards against the pure function being shipped but never wired.
      expect(html).toMatch(/shouldShowProductTour\(\s*currentUser\s*\)/);
    });
  });
});
