import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mobile fix regression guard: the dashboard's horizontal tab strips
// (.settings-tabs and .avail-sub-tabs) were cut off on phones because the page
// is overflow-x:hidden and the strips neither scrolled internally nor kept the
// tabs at full width. The Settings "Advanced" tab was unreachable. The fix has
// two parts in public/dashboard/index.html:
//   1) CSS so the strips scroll internally and tabs don't wrap/shrink.
//   2) JS so switching to an off-screen tab scrolls it into view.
// These tests assert the source structure and FAIL if any piece is reverted.
// ---------------------------------------------------------------------------

const html = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

// Brace-match the body of a top-level `function <name>(` declaration so each JS
// assertion is scoped to the right function (not just "scrollIntoView appears
// somewhere in 9000 lines of file").
function extractFunctionBody(source, fnName) {
  const sig = 'function ' + fnName;
  const sigIdx = source.indexOf(sig);
  expect(sigIdx, `expected to find "${sig}" in dashboard HTML`).toBeGreaterThan(-1);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx, `expected an opening brace after "${sig}"`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting "${fnName}"`);
}

// Pull out the contents of a CSS rule whose selector list contains BOTH given
// selectors (order/whitespace tolerant). Returns the text between `{` and `}`.
function extractCombinedRuleBody(source, selA, selB) {
  // Match a `{...}` block whose selector prelude mentions both selectors, in
  // either order, separated by a comma. Restrict the prelude/body to non-brace
  // chars so we stay within a single flat rule.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = esc(selA);
  const b = esc(selB);
  const re = new RegExp(
    `(?:${a}\\s*,\\s*${b}|${b}\\s*,\\s*${a})\\s*\\{([^{}]*)\\}`
  );
  const m = source.match(re);
  expect(m, `expected a combined CSS rule for "${selA}" and "${selB}"`).not.toBeNull();
  return m[1];
}

describe('mobile tab strip scroll fix (source structure)', () => {
  // ========================================================================
  // 1) Combined .settings-tabs / .avail-sub-tabs rule scrolls and won't wrap
  // ========================================================================
  describe('combined .settings-tabs / .avail-sub-tabs rule', () => {
    const ruleBody = extractCombinedRuleBody(html, '.settings-tabs', '.avail-sub-tabs');

    it('exists as a single rule targeting both strips', () => {
      expect(ruleBody).toBeTruthy();
    });

    it('sets overflow-x: auto so the strip scrolls internally', () => {
      expect(ruleBody).toMatch(/overflow-x\s*:\s*auto/);
    });

    it('sets flex-wrap: nowrap so tabs stay on one line', () => {
      expect(ruleBody).toMatch(/flex-wrap\s*:\s*nowrap/);
    });

    it('does NOT leave the strip wrapping (no flex-wrap: wrap in this rule)', () => {
      // Guards against a revert that swaps nowrap back to the default wrap.
      expect(ruleBody).not.toMatch(/flex-wrap\s*:\s*wrap/);
    });
  });

  // ========================================================================
  // 2) Combined .settings-tab / .avail-sub-tab rule keeps tabs full width
  // ========================================================================
  describe('combined .settings-tab / .avail-sub-tab rule', () => {
    const ruleBody = extractCombinedRuleBody(html, '.settings-tab', '.avail-sub-tab');

    it('exists as a single rule targeting both tab elements', () => {
      expect(ruleBody).toBeTruthy();
    });

    it('sets flex: 0 0 auto so tabs do not grow or shrink', () => {
      expect(ruleBody).toMatch(/flex\s*:\s*0\s+0\s+auto/);
    });

    it('sets white-space: nowrap so tab labels do not wrap', () => {
      expect(ruleBody).toMatch(/white-space\s*:\s*nowrap/);
    });
  });

  // ========================================================================
  // 3) switchSettingsTab scrolls the active tab into view
  // ========================================================================
  describe('switchSettingsTab', () => {
    const body = extractFunctionBody(html, 'switchSettingsTab');

    it('takes a btn parameter', () => {
      expect(html).toMatch(/function\s+switchSettingsTab\s*\(\s*btn\b/);
    });

    it('calls btn.scrollIntoView so an off-screen active tab scrolls into view', () => {
      expect(body).toMatch(/btn\s*\.\s*scrollIntoView\s*\(/);
    });
  });

  // ========================================================================
  // 4) switchAvailSubTab scrolls the active tab into view
  // ========================================================================
  describe('switchAvailSubTab', () => {
    const body = extractFunctionBody(html, 'switchAvailSubTab');

    it('takes a btn parameter', () => {
      expect(html).toMatch(/function\s+switchAvailSubTab\s*\(\s*btn\b/);
    });

    it('calls btn.scrollIntoView so an off-screen active tab scrolls into view', () => {
      expect(body).toMatch(/btn\s*\.\s*scrollIntoView\s*\(/);
    });
  });
});
