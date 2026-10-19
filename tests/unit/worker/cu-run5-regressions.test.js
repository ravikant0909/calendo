import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// B14 — wrangler.json declared no cron triggers, so the scheduled() handler
// (reminders, reconfirmations, email sequences, calendar sync, cleanup) never
// ran in production. Every cron the handler switches on must be registered.
describe('B14: cron triggers are registered so scheduled() runs in prod', () => {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'wrangler.json'), 'utf8'));
  const worker = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');

  it('wrangler.json registers the 5-minute cron (single trigger to fit the account limit)', () => {
    const crons = cfg.triggers && cfg.triggers.crons;
    expect(Array.isArray(crons)).toBe(true);
    expect(crons).toContain('*/5 * * * *');
    expect(crons.length).toBe(1); // account-wide cron-trigger budget is tight
  });

  it('scheduled() still drives reminders, calendar sync, and cleanup (time-gated)', () => {
    const i = worker.indexOf('async scheduled(');
    expect(i).toBeGreaterThan(-1);
    const body = worker.slice(i, i + 900);
    expect(body).toContain('sendPendingReminders(env)');
    expect(body).toContain('syncCalendars(env)');
    expect(body).toContain('cleanupExpired(env)');
  });
});
