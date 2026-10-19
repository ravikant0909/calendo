import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the 4 HIGH findings in the July 2026 security review:
//  H1 OAuth login matched accounts by email alone (account takeover)
//  H2 stored XSS: HTML escapers didn't escape quotes, used inside attributes
//  H3 public poll endpoint leaked every voter's email
//  H4 public /api/slot-debug leaked hosts' private calendar busy times

let worker;
beforeEach(async () => { worker = await import('../../../src/worker.js'); });

// ---------------------------------------------------------------- H1
function oauthDB(state) {
  state.users = state.users || [];
  state.identities = state.identities || [];
  let nextId = 500;
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/FROM oauth_identities oi/.test(sql)) {
                const i = state.identities.find(x => x.provider === args[0] && x.subject === args[1]);
                return i ? state.users.find(u => u.id === i.user_id) : null;
              }
              if (/FROM users WHERE email = \?/.test(sql)) return state.users.find(u => u.email === args[0]) || null;
              if (/INSERT INTO users/.test(sql)) {
                const u = { id: nextId++, email: args[0], name: args[2], timezone: args[3], email_verified: args[5] };
                state.users.push(u);
                return u;
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              if (/INSERT (OR IGNORE )?INTO oauth_identities/.test(sql)) {
                state.identities.push({ user_id: args[0], provider: args[1], subject: args[2] });
              }
              return { success: true };
            },
          };
        },
      };
    },
    batch: async () => [],
  };
}

describe('H1 resolveOAuthLogin — no account takeover via asserted email', () => {
  const victim = { id: 1, email: 'victim@corp.com', name: 'Victim', timezone: 'UTC' };

  it('Microsoft login asserting an existing account\'s email is refused', async () => {
    const state = { users: [{ ...victim }] };
    const r = await worker.resolveOAuthLogin({ DB: oauthDB(state) }, {
      provider: 'microsoft', subject: 'attacker-oid', email: 'victim@corp.com', emailVerified: false, name: 'x',
    });
    expect(r.error).toBe('account_exists');
    expect(state.identities).toHaveLength(0);
  });

  it('Google login with an UNverified email is refused for an existing account', async () => {
    const state = { users: [{ ...victim }] };
    const r = await worker.resolveOAuthLogin({ DB: oauthDB(state) }, {
      provider: 'google', subject: 'g1', email: 'victim@corp.com', emailVerified: false, name: 'x',
    });
    expect(r.error).toBe('account_exists');
  });

  it('Google login with a verified email links the existing account', async () => {
    const state = { users: [{ ...victim }] };
    const r = await worker.resolveOAuthLogin({ DB: oauthDB(state) }, {
      provider: 'google', subject: 'g1', email: 'victim@corp.com', emailVerified: true, name: 'x',
    });
    expect(r.user.id).toBe(1);
    expect(r.isNewUser).toBe(false);
    expect(state.identities).toEqual([{ user_id: 1, provider: 'google', subject: 'g1' }]);
  });

  it('a known identity logs into its own account, whatever email is asserted', async () => {
    const state = {
      users: [{ ...victim }, { id: 2, email: 'owner@outlook.com', name: 'Owner', timezone: 'UTC' }],
      identities: [{ user_id: 2, provider: 'microsoft', subject: 'oid-2' }],
    };
    const r = await worker.resolveOAuthLogin({ DB: oauthDB(state) }, {
      provider: 'microsoft', subject: 'oid-2', email: 'victim@corp.com', emailVerified: false, name: 'x',
    });
    expect(r.user.id).toBe(2);
  });

  it('a new Microsoft signup is bound to its subject and NOT marked email-verified', async () => {
    const state = {};
    const r = await worker.resolveOAuthLogin({ DB: oauthDB(state) }, {
      provider: 'microsoft', subject: 'oid-new', email: 'new@outlook.com', emailVerified: false, name: 'New',
    });
    expect(r.isNewUser).toBe(true);
    expect(state.users[0].email_verified).toBe(0);
    expect(state.identities[0]).toMatchObject({ provider: 'microsoft', subject: 'oid-new' });
  });

  it('password reset drops Microsoft identities (closes pre-registration hijack)', () => {
    const src = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handleResetPassword('), src.indexOf('async function handleLogout('));
    expect(fn).toMatch(/DELETE FROM oauth_identities WHERE user_id = \? AND provider = 'microsoft'/);
  });
});

// ---------------------------------------------------------------- H2
describe('H2 stored XSS — quote-unsafe escapers and permissive email regex', () => {
  const payload = 'a"onmouseover=alert(1);x="@evil.co';

  it('EMAIL_RE rejects the attribute-breakout payload but accepts real addresses', () => {
    expect(worker.EMAIL_RE.test(payload)).toBe(false);
    expect(worker.EMAIL_RE.test('x<script>@a.co')).toBe(false);
    for (const ok of ['a@b.co', "o'brien@x.com", 'a.b+tag@gmail.com']) expect(worker.EMAIL_RE.test(ok)).toBe(true);
  });

  // Every public page's escaper must neutralise quotes.
  function htmlFiles(dir) {
    return readdirSync(dir).flatMap(f => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith('.html') ? [p] : [];
    });
  }
  const files = htmlFiles(join(process.cwd(), 'public'));

  it('no page still uses the textContent→innerHTML escaper (it leaves " and \' raw)', () => {
    const offenders = files.filter(f => /(div|d)\.textContent = str/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('each escapeHtml/esc helper escapes quotes when executed', () => {
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/function (escapeHtml|esc)\(str\) \{[\s\S]*?\n\s*\}/g)) {
        const fn = new Function(`${m[0]}; return ${m[1]};`)();
        const out = fn(payload);
        expect(out, `${f} ${m[1]}`).not.toMatch(/["']/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------- H3
describe('H3 public poll endpoint does not leak voter emails', () => {
  function pollDB() {
    const votes = [
      { id: 1, poll_id: 7, option_id: 1, voter_name: 'Ann', voter_email: 'ann@secret.com', vote: 'yes' },
      { id: 2, poll_id: 7, option_id: 1, voter_name: 'Bob', voter_email: 'bob@secret.com', vote: 'no' },
    ];
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (/FROM meeting_polls mp/.test(sql)) return { id: 7, user_id: 3, title: 'Sync', status: 'open', creator_name: 'Host' };
                return null;
              },
              async all() {
                if (/FROM poll_options/.test(sql)) return { results: [{ id: 1, poll_id: 7, date: '2026-11-01', start_time: '10:00', end_time: '10:30' }] };
                if (/FROM poll_votes/.test(sql)) return { results: votes };
                return { results: [] };
              },
              async run() { return { success: true }; },
            };
          },
        };
      },
    };
  }

  it('response has voter names and keys, but no email anywhere', async () => {
    const res = await worker.default.fetch(new Request('https://calendo.dev/api/polls/7'), { DB: pollDB(), DISABLE_RATE_LIMITS: '1' }, {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/@secret\.com/);
    expect(text).not.toMatch(/voter_email/);
    const body = JSON.parse(text);
    expect(body.voters).toEqual([{ key: 'v0', name: 'Ann' }, { key: 'v1', name: 'Bob' }]);
    expect(body.options[0].votes.map(v => v.voter_key)).toEqual(['v0', 'v1']);
  });

  it('poll page matches votes to voters by key, not email', () => {
    const src = readFileSync(join(process.cwd(), 'public/poll/index.html'), 'utf8');
    expect(src).toContain('v.voter_key === voter.key');
    expect(src).not.toContain('voter.email');
  });
});

// ---------------------------------------------------------------- H4
describe('H4 /api/slot-debug is host-only', () => {
  it('anonymous request gets 401', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }) };
    const res = await worker.default.fetch(
      new Request('https://calendo.dev/api/slot-debug/jane/intro?time=2026-11-01T10:00:00'),
      { DB: db, DISABLE_RATE_LIMITS: '1' }, {});
    expect(res.status).toBe(401);
  });

  it('a logged-in user asking about someone else\'s page gets 404', async () => {
    const src = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handleSlotDebug('), src.indexOf('async function handleGetBookingPage('));
    expect(fn).toMatch(/page\.user_id !== user\.id\) return jsonResponse\(\{ error: 'User not found' \}, 404\)/);
  });
});
