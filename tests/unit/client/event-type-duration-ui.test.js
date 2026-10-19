import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The duration controls must allow ANY duration (e.g. 20), not just the old fixed
// dropdown of 15/30/45/60/90/120. They're now number inputs (5-720) with a presets
// datalist that includes 20.
const html = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

describe('Event-type duration UI accepts any value', () => {
  it('the edit-panel duration is a number input bounded 5-720 (not a fixed <select>)', () => {
    const m = html.match(/<input[^>]*id="editEtDuration"[^>]*>/);
    expect(m, 'editEtDuration must be an <input>').not.toBeNull();
    expect(m[0]).toMatch(/type="number"/);
    expect(m[0]).toMatch(/min="5"/);
    expect(m[0]).toMatch(/max="720"/);
    expect(html).not.toMatch(/<select[^>]*id="editEtDuration"/);
  });

  it('the create-form duration is a number input bounded 5-720', () => {
    const m = html.match(/<input[^>]*id="etDuration"[^>]*>/);
    expect(m, 'etDuration must be an <input>').not.toBeNull();
    expect(m[0]).toMatch(/type="number"/);
    expect(m[0]).toMatch(/min="5"/);
    expect(m[0]).toMatch(/max="720"/);
    expect(html).not.toMatch(/<select[^>]*id="etDuration"/);
  });

  it('offers a 20-minute preset via the shared datalist', () => {
    const dl = html.match(/<datalist[^>]*id="etDurationPresets"[\s\S]*?<\/datalist>/);
    expect(dl, 'etDurationPresets datalist must exist').not.toBeNull();
    expect(dl[0]).toMatch(/value="20"/);
  });

  it('showEtForm no longer iterates select .options (would break on a number input)', () => {
    expect(html).not.toMatch(/durationSelect\.options/);
  });
});
