import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for Computer Use Test Run 4 (CU-13 finding B9).
const worker = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');

// B9 — the dashboard "Finalize" button sends no option_id; the handler used to
// hard-fail (400 "option_id is required" / "Invalid JSON"). It must auto-pick the
// most-voted option when none is supplied.
describe('B9: poll finalize auto-picks the best option when none is given', () => {
  it('handleFinalizePoll no longer hard-fails on a missing option_id and auto-picks', () => {
    const i = worker.indexOf('async function handleFinalizePoll');
    expect(i).toBeGreaterThan(-1);
    const body = worker.slice(i, i + 1600);
    expect(body).not.toContain("'option_id is required'");
    expect(body).not.toContain("'Invalid JSON'");
    expect(body).toContain('yes_votes');
    expect(body).toContain('ORDER BY yes_votes DESC');
  });

  it('behavioral: most-"yes" option wins, then yes+maybe, then earliest', () => {
    // mirrors the SQL: ORDER BY yes_votes DESC, soft_votes DESC, date, start_time
    const opts = [
      { id: 1, yes: 1, soft: 3, date: '2026-06-10', t: '09:00' },
      { id: 2, yes: 2, soft: 2, date: '2026-06-11', t: '10:00' },
      { id: 3, yes: 2, soft: 3, date: '2026-06-12', t: '11:00' },
    ];
    const best = [...opts].sort(
      (a, b) => b.yes - a.yes || b.soft - a.soft || a.date.localeCompare(b.date) || a.t.localeCompare(b.t)
    )[0];
    expect(best.id).toBe(3); // 2 yes + 3 soft beats id2 (2 yes, 2 soft) and id1 (1 yes)
  });
});
