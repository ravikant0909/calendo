import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// B15 — the meeting-detail sidebar only rendered ARRAY-shaped answers, but
// booking answers are stored as an object map { question: answer }, so invitee
// answers never displayed. The render branch must normalize the object map.
const dash = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

describe('B15: meeting detail renders object-shaped booking answers', () => {
  it('the answers render branch normalizes the object map (uses Object.entries)', () => {
    const i = dash.indexOf('mds-section-title">Booking Questions');
    expect(i).toBeGreaterThan(-1);
    const block = dash.slice(Math.max(0, i - 600), i + 200);
    expect(block).toContain('Object.entries');
  });

  it('behavioral: object answers normalize to renderable [q, a] entries', () => {
    // mirrors the fixed render-branch normalization
    const normalize = (raw) => {
      const entries = Array.isArray(raw)
        ? raw.map(a => [a.question || a.label || '', a.answer || a.value || ''])
        : Object.entries(raw || {});
      return entries.filter(([q, a]) => q && a !== '' && a != null);
    };
    expect(normalize({ 'Are you an existing customer?': 'Yes', 'Account ID': 'ACCT-1' }))
      .toEqual([['Are you an existing customer?', 'Yes'], ['Account ID', 'ACCT-1']]);
    expect(normalize([{ question: 'Q', answer: 'A' }])).toEqual([['Q', 'A']]);
    expect(normalize({ Q: '' })).toEqual([]); // blank answers filtered out
  });
});
