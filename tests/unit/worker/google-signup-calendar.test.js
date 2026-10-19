import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Combined-consent Google signup (Calendly-style): at signup we request calendar
// scopes in the SAME Google consent, and if granted we connect the calendar
// immediately so onboarding skips the separate "Connect your calendar" step.
// Plain login stays identity-only. (User request, June 2026.)

const TEST_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes base64

function makeEnv(dbState) {
  return {
    APP_ORIGIN: 'https://calendo.dev',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ASSETS: { fetch: () => new Response('') },
    DB: makeMockDB(dbState),
  };
}

// Permissive mock D1 that tracks calendar_connections + users for assertions.
function makeMockDB(state) {
  state.users = state.users || [];
  state.calendarConnections = state.calendarConnections || [];
  let userId = 100;
  let connId = 1;
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/FROM oauth_identities oi/.test(sql)) {
                const i = (state.identities || []).find(x => x.provider === args[0] && x.subject === args[1]);
                return i ? state.users.find(u => u.id === i.user_id) || null : null;
              }
              if (/SELECT id, email, name.* FROM users WHERE email/.test(sql)) {
                return state.users.find(u => u.email === args[0]) || null;
              }
              if (/INSERT INTO users/.test(sql)) {
                const u = { id: userId++, email: args[0], name: args[2], timezone: args[3] };
                state.users.push(u);
                return u;
              }
              if (/FROM calendar_connections WHERE user_id = \? AND provider = \? AND email/.test(sql)) {
                return state.calendarConnections.find(c => c.user_id === args[0] && c.provider === args[1] && c.email === args[2]) || null;
              }
              if (/FROM calendar_connections WHERE user_id = \? AND is_primary = 1/.test(sql)) {
                return state.calendarConnections.find(c => c.user_id === args[0] && c.is_primary === 1) || null;
              }
              if (/SELECT \* FROM calendar_connections.*ORDER BY id DESC/.test(sql)) {
                const mine = state.calendarConnections.filter(c => c.user_id === args[0] && c.provider === args[1]);
                return mine.length ? mine[mine.length - 1] : null;
              }
              return null; // slug-uniqueness checks etc. → treat as available
            },
            async all() { return { results: [] }; },
            async run() {
              if (/INSERT (OR IGNORE )?INTO oauth_identities/.test(sql)) {
                (state.identities = state.identities || []).push({ user_id: args[0], provider: args[1], subject: args[2] });
              }
              if (/INSERT INTO calendar_connections/.test(sql)) {
                state.calendarConnections.push({
                  id: connId++, user_id: args[0], provider: args[1], email: args[5],
                  calendar_id: args[6], is_primary: args[7], check_conflicts: args[8], write_events: args[9],
                });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

// Route Google's OAuth + calendar endpoints to deterministic mocks.
function mockGoogleFetch({ scope }) {
  return async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({
        access_token: 'ya29.test-access', refresh_token: '1//test-refresh',
        expires_in: 3600, scope, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify({
        id: 'g-sub-1', verified_email: true, email: 'newuser@gmail.com', name: 'New User', picture: 'https://x/p.png',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Calendar watch / anything else → benign ok (callback wraps it in try/catch).
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function freshState(worker, env, intent) {
  const path = intent ? `/api/auth/oauth/google?intent=${intent}` : '/api/auth/oauth/google';
  const res = await worker.default.fetch(new Request('https://calendo.dev' + path), env, {});
  const loc = res.headers.get('Location');
  return new URL(loc).searchParams.get('state');
}

describe('Google signup combined consent — OAuth initiator scopes', () => {
  let worker, originalFetch;
  beforeEach(async () => { worker = await import('../../../src/worker.js'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('signup (intent=signup) requests calendar scopes + offline access', async () => {
    const res = await worker.default.fetch(new Request('https://calendo.dev/api/auth/oauth/google?intent=signup'), makeEnv({}), {});
    expect(res.status).toBe(302);
    const params = new URL(res.headers.get('Location')).searchParams;
    const scope = params.get('scope');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');
    expect(params.get('access_type')).toBe('offline');
  });

  it('plain login (no intent) ALSO requests calendar + offline so first-time users skip step 1', async () => {
    const res = await worker.default.fetch(new Request('https://calendo.dev/api/auth/oauth/google'), makeEnv({}), {});
    const params = new URL(res.headers.get('Location')).searchParams;
    const scope = params.get('scope');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');
    expect(params.get('access_type')).toBe('offline');
  });
});

describe('Google signup combined consent — callback auto-connects calendar', () => {
  let worker, originalFetch;
  beforeEach(async () => { worker = await import('../../../src/worker.js'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('connects the calendar when the calendar scope was granted, and signals ?calendar=connected', async () => {
    const dbState = {};
    const env = makeEnv(dbState);
    const state = await freshState(worker, env, 'signup');
    globalThis.fetch = mockGoogleFetch({
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    });
    const res = await worker.default.fetch(
      new Request(`https://calendo.dev/api/auth/callback/google?code=abc&state=${encodeURIComponent(state)}`), env, {});
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location');
    expect(loc).toContain('/dashboard/');
    expect(loc).toContain('welcome=1');
    expect(loc).toContain('calendar=connected');
    expect(dbState.calendarConnections).toHaveLength(1);
    expect(dbState.calendarConnections[0].provider).toBe('google');
    expect(dbState.calendarConnections[0].is_primary).toBe(1);
  });

  it('returning user with an existing connection logs in WITHOUT a spurious ?calendar=connected', async () => {
    const dbState = {
      users: [{ id: 50, email: 'newuser@gmail.com', name: 'Return User', timezone: 'UTC' }],
      calendarConnections: [{ id: 1, user_id: 50, provider: 'google', email: 'newuser@gmail.com', is_primary: 1 }],
    };
    const env = makeEnv(dbState);
    const state = await freshState(worker, env); // plain login
    globalThis.fetch = mockGoogleFetch({
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    });
    const res = await worker.default.fetch(
      new Request(`https://calendo.dev/api/auth/callback/google?code=abc&state=${encodeURIComponent(state)}`), env, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).not.toContain('calendar=connected');
    expect(dbState.calendarConnections).toHaveLength(1); // no duplicate inserted
  });

  it('does NOT connect a calendar when the user declined the calendar checkbox', async () => {
    const dbState = {};
    const env = makeEnv(dbState);
    const state = await freshState(worker, env, 'signup');
    globalThis.fetch = mockGoogleFetch({ scope: 'openid email profile' });
    const res = await worker.default.fetch(
      new Request(`https://calendo.dev/api/auth/callback/google?code=abc&state=${encodeURIComponent(state)}`), env, {});
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location');
    expect(loc).toContain('welcome=1');
    expect(loc).not.toContain('calendar=connected');
    expect(dbState.calendarConnections).toHaveLength(0);
  });
});
