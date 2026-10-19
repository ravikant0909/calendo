import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Outlook parity for combined-consent signup: "Sign up with Microsoft" requests
// calendar access in the same Microsoft consent, and if granted we connect the
// Outlook calendar immediately so onboarding skips the "Connect your calendar"
// step. Plain login stays identity-only. Mirrors the Google signup behavior.

const TEST_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes base64

function makeEnv(dbState) {
  return {
    APP_ORIGIN: 'https://calendo.dev',
    MICROSOFT_CLIENT_ID: 'test-ms-client-id',
    MICROSOFT_CLIENT_SECRET: 'test-ms-secret',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ASSETS: { fetch: () => new Response('') },
    DB: makeMockDB(dbState),
  };
}

function makeMockDB(state) {
  state.users = state.users || [];
  state.calendarConnections = state.calendarConnections || [];
  let userId = 200;
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
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              if (/INSERT (OR IGNORE )?INTO oauth_identities/.test(sql)) {
                (state.identities = state.identities || []).push({ user_id: args[0], provider: args[1], subject: args[2] });
              }
              if (/INSERT INTO calendar_connections/.test(sql)) {
                state.calendarConnections.push({
                  id: connId++, user_id: args[0], provider: args[1], email: args[5],
                  is_primary: args[7], check_conflicts: args[8], write_events: args[9],
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

function mockMsFetch({ scope }) {
  return async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.includes('login.microsoftonline.com') && u.includes('/token')) {
      return new Response(JSON.stringify({
        access_token: 'ms.test-access', refresh_token: 'ms.test-refresh',
        expires_in: 3600, scope, token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('graph.microsoft.com/v1.0/me')) {
      return new Response(JSON.stringify({
        id: 'ms-oid-1', mail: 'newuser@outlook.com', userPrincipalName: 'newuser@outlook.com', displayName: 'New User',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

async function freshState(worker, env, intent) {
  const path = intent ? `/api/auth/oauth/microsoft?intent=${intent}` : '/api/auth/oauth/microsoft';
  const res = await worker.default.fetch(new Request('https://calendo.dev' + path), env, {});
  return new URL(res.headers.get('Location')).searchParams.get('state');
}

describe('Microsoft signup combined consent — initiator scopes', () => {
  let worker, originalFetch;
  beforeEach(async () => { worker = await import('../../../src/worker.js'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('signup (intent=signup) requests Outlook calendar scopes + offline_access', async () => {
    const res = await worker.default.fetch(new Request('https://calendo.dev/api/auth/oauth/microsoft?intent=signup'), makeEnv({}), {});
    expect(res.status).toBe(302);
    const scope = new URL(res.headers.get('Location')).searchParams.get('scope');
    expect(scope).toContain('Calendars.ReadWrite');
    expect(scope).toContain('offline_access');
  });

  it('plain login stays identity-only (no calendar scopes)', async () => {
    const res = await worker.default.fetch(new Request('https://calendo.dev/api/auth/oauth/microsoft'), makeEnv({}), {});
    const scope = new URL(res.headers.get('Location')).searchParams.get('scope');
    expect(scope).not.toContain('Calendars');
    expect(scope).not.toContain('offline_access');
  });
});

describe('Microsoft signup combined consent — callback auto-connects Outlook', () => {
  let worker, originalFetch;
  beforeEach(async () => { worker = await import('../../../src/worker.js'); originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('connects Outlook when calendar scope was granted and signals ?calendar=connected', async () => {
    const dbState = {};
    const env = makeEnv(dbState);
    const state = await freshState(worker, env, 'signup');
    globalThis.fetch = mockMsFetch({ scope: 'openid email profile User.Read Calendars.ReadWrite OnlineMeetings.ReadWrite' });
    const res = await worker.default.fetch(
      new Request(`https://calendo.dev/api/auth/callback/microsoft?code=abc&state=${encodeURIComponent(state)}`), env, {});
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location');
    expect(loc).toContain('/dashboard/');
    expect(loc).toContain('welcome=1');
    expect(loc).toContain('calendar=connected');
    expect(dbState.calendarConnections).toHaveLength(1);
    expect(dbState.calendarConnections[0].provider).toBe('outlook');
    expect(dbState.calendarConnections[0].is_primary).toBe(1);
  });

  it('plain login (state=login) never auto-connects a calendar', async () => {
    const dbState = {};
    const env = makeEnv(dbState);
    const state = await freshState(worker, env); // no intent → state 'login'
    globalThis.fetch = mockMsFetch({ scope: 'openid email profile User.Read' });
    const res = await worker.default.fetch(
      new Request(`https://calendo.dev/api/auth/callback/microsoft?code=abc&state=${encodeURIComponent(state)}`), env, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).not.toContain('calendar=connected');
    expect(dbState.calendarConnections).toHaveLength(0);
  });
});
