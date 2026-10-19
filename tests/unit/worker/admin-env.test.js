import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAdmin } from '../../../src/worker.js';

// Admins come from the ADMIN_EMAIL env var so self-hosted deployments pick their
// own (and no personal email is hardcoded in the public source).
describe('isAdmin(env, user)', () => {
  it('matches a listed email, case-insensitively', () => {
    expect(isAdmin({ ADMIN_EMAIL: 'Boss@Example.com' }, { email: 'boss@example.com' })).toBe(true);
  });
  it('supports a comma-separated list', () => {
    expect(isAdmin({ ADMIN_EMAIL: 'a@x.com, b@x.com' }, { email: 'b@x.com' })).toBe(true);
  });
  it('denies everyone when ADMIN_EMAIL is unset or empty', () => {
    expect(isAdmin({}, { email: 'a@x.com' })).toBe(false);
    expect(isAdmin({ ADMIN_EMAIL: '' }, { email: '' })).toBe(false);
  });
  it('denies non-listed users', () => {
    expect(isAdmin({ ADMIN_EMAIL: 'a@x.com' }, { email: 'b@x.com' })).toBe(false);
  });
  it('no hardcoded admin email remains in the worker', () => {
    const src = readFileSync(new URL('../../../src/worker.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/user\.email !== '[^']+@/);
  });
});
