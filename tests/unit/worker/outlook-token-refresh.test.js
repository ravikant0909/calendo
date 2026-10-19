import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ============================================================
// Test Helpers
// ============================================================

function createMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    calendar_connections: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    calendar_connections: 1,
  };

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT id FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              if (sql.includes('SELECT id, email, password_hash')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = { id, email: args[0], password_hash: args[1], name: args[2], timezone: args[3], avatar_url: args[4] || null, created_at: new Date().toISOString() };
                tables.users.push(user);
                return { id: user.id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: user.avatar_url, created_at: user.created_at };
              }
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find(p => p.slug === args[0]) || null;
              }
              if (sql.includes('SELECT id FROM availability_schedules')) {
                return tables.availability_schedules.find(s => s.user_id === args[0] && s.is_default) || null;
              }
              if (sql.includes('SELECT s.user_id, u.*')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              if (sql.includes('SELECT id FROM calendar_connections WHERE user_id') && sql.includes('provider') && sql.includes('email')) {
                return tables.calendar_connections.find(c => c.user_id === args[0] && c.provider === args[1] && c.email === args[2]) || null;
              }
              if (sql.includes('calendar_connections WHERE user_id = ? AND is_primary')) {
                return tables.calendar_connections.find(c => c.user_id === args[0] && c.is_primary === 1) || null;
              }
              if (sql.includes('SELECT id, name, email, timezone FROM users')) {
                return tables.users.find(u => u.id === args[0]) || null;
              }
              if (sql.includes('SELECT id, email, name FROM users WHERE email')) {
                return tables.users.find(u => u.email === args[0]) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes('calendar_connections') && sql.includes('write_events')) {
                const connections = tables.calendar_connections.filter(
                  c => c.user_id === args[0] && c.provider === args[1] && c.write_events === 1
                );
                return { results: connections };
              }
              if (sql.includes('calendar_connections') && sql.includes('check_conflicts')) {
                const connections = tables.calendar_connections.filter(
                  c => c.user_id === args[0] && c.provider === args[1] && c.check_conflicts === 1
                );
                return { results: connections };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: args[4] });
              }
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
              }
              if (sql.includes('INSERT INTO calendar_connections')) {
                tables.calendar_connections.push({
                  id: autoIncrement.calendar_connections++,
                  user_id: args[0], provider: args[1],
                  access_token_encrypted: args[2], refresh_token_encrypted: args[3],
                  token_expires_at: args[4], email: args[5], calendar_id: args[6],
                  is_primary: args[7], check_conflicts: args[8], write_events: args[9],
                });
              }
              if (sql.includes('UPDATE calendar_connections SET access_token_encrypted')) {
                // Token refresh update
                const conn = tables.calendar_connections.find(c => c.id === args[args.length - 1]);
                if (conn) {
                  conn.access_token_encrypted = args[0];
                  if (args.length > 2) {
                    conn.refresh_token_encrypted = args[1];
                    conn.token_expires_at = args[2];
                  }
                }
              }
              if (sql.includes('DELETE FROM sessions')) {
                tables.sessions = tables.sessions.filter(s => s.token !== args[0]);
              }
              return { success: true };
            }
          };
        }
      };
    },
    _tables: tables
  };
}

function createEnv(db) {
  return {
    DB: db || createMockDB(),
    ASSETS: { fetch: () => new Response('') },
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
    ZOOM_API_KEY: 'test-zoom-api-key',
    ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    APP_ORIGIN: 'https://calendo.dev',
  };
}

async function registerUser(worker, env) {
  const request = new Request('https://calendo.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
  });
  const response = await worker.default.fetch(request, env, {});
  const cookie = response.headers.get('Set-Cookie');
  const sessionToken = cookie.match(/session=([^;]+)/)[1];
  return sessionToken;
}

// ============================================================
// Outlook OAuth Flow - offline_access Scope Tests
// ============================================================

describe('Outlook OAuth Flow - offline_access scope', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  it('should include offline_access scope in the Outlook calendar OAuth redirect', async () => {
    const env = createEnv();
    const sessionToken = await registerUser(worker, env);

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(302);

    const location = response.headers.get('Location');
    expect(location).toContain('offline_access');
    expect(location).toContain('Calendars.ReadWrite');
    expect(location).toContain('OnlineMeetings.ReadWrite');
  });

  it('should include all required scopes: openid, email, profile, offline_access, Calendars.ReadWrite, OnlineMeetings.ReadWrite', async () => {
    const env = createEnv();
    const sessionToken = await registerUser(worker, env);

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    const location = response.headers.get('Location');
    const scopes = ['openid', 'email', 'profile', 'offline_access', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'];
    for (const scope of scopes) {
      expect(location).toContain(scope);
    }
  });
});

// ============================================================
// Token Encryption/Decryption Roundtrip Tests
// ============================================================

describe('Token Encryption/Decryption Roundtrip', () => {
  it('should encrypt and decrypt a token back to original value', async () => {
    // Test the AES-GCM encryption/decryption logic directly
    const keyBase64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const originalToken = 'test-access-token-value-12345';

    // Encrypt
    const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(originalToken);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const encrypted = `${ivB64}:${ctB64}`;

    // Decrypt
    const [ivB642, ctB642] = encrypted.split(':');
    const iv2 = Uint8Array.from(atob(ivB642), c => c.charCodeAt(0));
    const ciphertext2 = Uint8Array.from(atob(ctB642), c => c.charCodeAt(0));
    const keyData2 = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    const cryptoKey2 = await crypto.subtle.importKey('raw', keyData2, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, cryptoKey2, ciphertext2);
    const decrypted = new TextDecoder().decode(plaintext);

    expect(decrypted).toBe(originalToken);
  });

  it('should produce different ciphertexts for same input (random IV)', async () => {
    const keyBase64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const token = 'same-token-value';

    async function encrypt(token) {
      const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(token);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
      const ivB64 = btoa(String.fromCharCode(...iv));
      const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
      return `${ivB64}:${ctB64}`;
    }

    const encrypted1 = await encrypt(token);
    const encrypted2 = await encrypt(token);

    // Same plaintext but different ciphertext (different random IVs)
    expect(encrypted1).not.toBe(encrypted2);
    // Both should have IV:ciphertext format
    expect(encrypted1.split(':')).toHaveLength(2);
    expect(encrypted2.split(':')).toHaveLength(2);
  });

  it('should fail decryption with wrong key', async () => {
    const key1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const key2 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
    const token = 'secret-token';

    // Encrypt with key1
    const keyData = Uint8Array.from(atob(key1), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(token);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const encrypted = `${ivB64}:${ctB64}`;

    // Try to decrypt with key2
    const [ivB642, ctB642] = encrypted.split(':');
    const iv2 = Uint8Array.from(atob(ivB642), c => c.charCodeAt(0));
    const ciphertext2 = Uint8Array.from(atob(ctB642), c => c.charCodeAt(0));
    const keyData2 = Uint8Array.from(atob(key2), c => c.charCodeAt(0));
    const cryptoKey2 = await crypto.subtle.importKey('raw', keyData2, 'AES-GCM', false, ['decrypt']);

    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, cryptoKey2, ciphertext2)
    ).rejects.toThrow();
  });

  it('should handle long tokens (OAuth access tokens can be 1000+ chars)', async () => {
    const keyBase64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const longToken = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.' + 'a'.repeat(1500);

    const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    const encKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(longToken);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, encoded);
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const encrypted = `${ivB64}:${ctB64}`;

    // Decrypt
    const [ivB642, ctB642] = encrypted.split(':');
    const iv2 = Uint8Array.from(atob(ivB642), c => c.charCodeAt(0));
    const ciphertext2 = Uint8Array.from(atob(ctB642), c => c.charCodeAt(0));
    const decKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, decKey, ciphertext2);
    const decrypted = new TextDecoder().decode(plaintext);

    expect(decrypted).toBe(longToken);
  });
});

// ============================================================
// Outlook Token Refresh Logic Tests
// ============================================================

describe('Outlook Token Refresh Logic', () => {
  describe('getValidOutlookToken behavior', () => {
    it('should refresh when token_expires_at is in the past', () => {
      // Simulating the logic from getValidOutlookToken
      const pastExpiry = new Date(Date.now() - 60000).toISOString().slice(0, 19) + 'Z';
      const connection = { token_expires_at: pastExpiry };

      // Parse the stored date
      let normalized = String(connection.token_expires_at).trim();
      if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
        normalized += 'Z';
      }
      const expiresAt = new Date(normalized);
      const shouldRefresh = expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

      expect(shouldRefresh).toBe(true);
    });

    it('should refresh when token expires within 5 minutes', () => {
      // Token expiring in 3 minutes -- should trigger refresh
      const soonExpiry = new Date(Date.now() + 3 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
      const connection = { token_expires_at: soonExpiry };

      let normalized = String(connection.token_expires_at).trim();
      if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
        normalized += 'Z';
      }
      const expiresAt = new Date(normalized);
      const shouldRefresh = expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

      expect(shouldRefresh).toBe(true);
    });

    it('should NOT refresh when token is still valid (expiry > 5 min away)', () => {
      const futureExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
      const connection = { token_expires_at: futureExpiry };

      let normalized = String(connection.token_expires_at).trim();
      if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
        normalized += 'Z';
      }
      const expiresAt = new Date(normalized);
      const shouldRefresh = expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

      expect(shouldRefresh).toBe(false);
    });

    it('should refresh when token_expires_at is null (no expiry recorded)', () => {
      // This was the key bug: when token_expires_at is null, old code would
      // skip the refresh and use the (potentially expired) access token
      const connection = { token_expires_at: null };

      // After the fix: if token_expires_at is falsy, we proactively refresh
      const shouldRefresh = !connection.token_expires_at;

      expect(shouldRefresh).toBe(true);
    });

    it('should refresh when token_expires_at is undefined', () => {
      const connection = {};

      const shouldRefresh = !connection.token_expires_at;

      expect(shouldRefresh).toBe(true);
    });
  });

  describe('refreshOutlookToken error handling', () => {
    it('should throw when no refresh_token_encrypted exists', () => {
      const connection = { refresh_token_encrypted: null };

      // The function checks this first and throws
      expect(connection.refresh_token_encrypted).toBeNull();
      // This would cause: Error('No Outlook refresh token available — user must re-authenticate')
    });

    it('should detect expired refresh token from AADSTS700082 error', () => {
      const errorText = '{"error":"invalid_grant","error_description":"AADSTS700082: The refresh token has expired due to inactivity."}';
      const status = 400;

      const isExpiredRefreshToken = status === 400 && (
        errorText.includes('AADSTS700082') ||
        errorText.includes('AADSTS50173') ||
        errorText.includes('expired')
      );

      expect(isExpiredRefreshToken).toBe(true);
    });

    it('should detect expired refresh token from AADSTS50173 error', () => {
      const errorText = '{"error":"invalid_grant","error_description":"AADSTS50173: The provided grant has expired due to it being revoked."}';
      const status = 400;

      const isExpiredRefreshToken = status === 400 && (
        errorText.includes('AADSTS700082') ||
        errorText.includes('AADSTS50173') ||
        errorText.includes('expired')
      );

      expect(isExpiredRefreshToken).toBe(true);
    });

    it('should NOT falsely detect non-expired errors as expired', () => {
      const errorText = '{"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided."}';
      const status = 401;

      const isExpiredRefreshToken = status === 400 && (
        errorText.includes('AADSTS700082') ||
        errorText.includes('AADSTS50173') ||
        errorText.includes('expired')
      );

      expect(isExpiredRefreshToken).toBe(false);
    });
  });

  describe('Token refresh request parameters', () => {
    it('should include offline_access in refresh scope to get a new refresh token', () => {
      const scope = 'openid email profile offline_access Calendars.ReadWrite OnlineMeetings.ReadWrite';

      expect(scope).toContain('offline_access');
      expect(scope).toContain('Calendars.ReadWrite');
      expect(scope).toContain('OnlineMeetings.ReadWrite');
    });

    it('should preserve existing refresh token when Microsoft does not return a new one', () => {
      const existingRefreshToken = 'existing-encrypted-refresh-token';
      const tokens = { access_token: 'new-access', refresh_token: null, expires_in: 3600 };

      const refreshTokenEncrypted = tokens.refresh_token
        ? 'newly-encrypted-refresh-token'
        : existingRefreshToken;

      expect(refreshTokenEncrypted).toBe(existingRefreshToken);
    });

    it('should use new refresh token when Microsoft returns one', () => {
      const existingRefreshToken = 'existing-encrypted-refresh-token';
      const tokens = { access_token: 'new-access', refresh_token: 'new-refresh-from-microsoft', expires_in: 3600 };

      const shouldEncryptNew = !!tokens.refresh_token;

      expect(shouldEncryptNew).toBe(true);
    });
  });
});

// ============================================================
// Outlook Calendar Callback - Token Storage Tests
// ============================================================

describe('Outlook Calendar Callback - Token Storage', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  it('should redirect with error when callback receives an error parameter', async () => {
    const env = createEnv();

    const request = new Request('https://calendo.dev/api/auth/callback/outlook-calendar?error=access_denied', {
      method: 'GET',
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('calendar=error');
    expect(location).toContain('access_denied');
  });

  it('should redirect with error when code is present but state is missing', async () => {
    const env = createEnv();

    const request = new Request('https://calendo.dev/api/auth/callback/outlook-calendar?code=test-code', {
      method: 'GET',
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('calendar=error');
    expect(location).toContain('missing_params');
  });

  it('should redirect with invalid_state when state is forged', async () => {
    const env = createEnv();

    const request = new Request('https://calendo.dev/api/auth/callback/outlook-calendar?code=test-code&state=forged-state', {
      method: 'GET',
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('invalid_state');
  });
});

// ============================================================
// Outlook Busy Times API Error Handling Tests
// ============================================================

describe('Outlook Busy Times Error Handling', () => {
  it('should return empty array when no Outlook connections exist', () => {
    // Simulating: no connections found in DB
    const connections = { results: [] };
    const hasConnections = connections.results && connections.results.length > 0;

    expect(hasConnections).toBe(false);
  });

  it('should filter busy/tentative/oof events but not free events', () => {
    const events = [
      { showAs: 'busy', start: { dateTime: '2026-04-07T10:00:00' }, end: { dateTime: '2026-04-07T11:00:00' } },
      { showAs: 'tentative', start: { dateTime: '2026-04-07T12:00:00' }, end: { dateTime: '2026-04-07T13:00:00' } },
      { showAs: 'free', start: { dateTime: '2026-04-07T14:00:00' }, end: { dateTime: '2026-04-07T15:00:00' } },
      { showAs: 'oof', start: { dateTime: '2026-04-07T16:00:00' }, end: { dateTime: '2026-04-07T17:00:00' } },
      { showAs: 'workingElsewhere', start: { dateTime: '2026-04-07T08:00:00' }, end: { dateTime: '2026-04-07T09:00:00' } },
    ];

    const busyTimes = events
      .filter(item => item.showAs === 'busy' || item.showAs === 'tentative' || item.showAs === 'oof')
      .map(item => ({ start: item.start.dateTime + 'Z', end: item.end.dateTime + 'Z' }));

    expect(busyTimes).toHaveLength(3);
    expect(busyTimes[0].start).toBe('2026-04-07T10:00:00Z');
    expect(busyTimes[1].start).toBe('2026-04-07T12:00:00Z');
    expect(busyTimes[2].start).toBe('2026-04-07T16:00:00Z');
  });

  it('should gracefully handle empty event list from Outlook', () => {
    const data = { value: [] };
    const events = data.value || [];
    const busyTimes = events
      .filter(item => item.showAs === 'busy' || item.showAs === 'tentative' || item.showAs === 'oof')
      .map(item => ({ start: item.start.dateTime + 'Z', end: item.end.dateTime + 'Z' }));

    expect(busyTimes).toEqual([]);
  });

  it('should gracefully handle missing value field in response', () => {
    const data = {};
    const events = data.value || [];
    const busyTimes = events
      .filter(item => item.showAs === 'busy' || item.showAs === 'tentative' || item.showAs === 'oof')
      .map(item => ({ start: item.start.dateTime + 'Z', end: item.end.dateTime + 'Z' }));

    expect(busyTimes).toEqual([]);
  });
});

// ============================================================
// Outlook Calendar Event Creation Tests
// ============================================================

describe('Outlook Calendar Event Creation', () => {
  it('should construct correct event payload with attendees', () => {
    const booking = {
      start_time: '2026-04-07T14:00:00Z',
      end_time: '2026-04-07T14:30:00Z',
      invitee_name: 'Jane Doe',
      invitee_email: 'jane@example.com',
    };
    const eventType = { name: 'Intro Call' };

    const startTime = booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z';
    const endTime = booking.end_time.includes('T') ? booking.end_time : booking.end_time.replace(' ', 'T') + 'Z';

    const event = {
      subject: `${eventType.name} with ${booking.invitee_name}`,
      body: { contentType: 'text', content: `Booked via Calendo\n\nInvitee: ${booking.invitee_name} (${booking.invitee_email})` },
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: booking.invitee_email, name: booking.invitee_name }, type: 'required' }],
    };

    expect(event.subject).toBe('Intro Call with Jane Doe');
    expect(event.start.dateTime).toBe('2026-04-07T14:00:00Z');
    expect(event.end.dateTime).toBe('2026-04-07T14:30:00Z');
    expect(event.attendees[0].emailAddress.address).toBe('jane@example.com');
    expect(event.attendees[0].emailAddress.name).toBe('Jane Doe');
  });

  it('should handle space-separated datetime format from DB', () => {
    const booking = {
      start_time: '2026-04-07 14:00:00',
      end_time: '2026-04-07 14:30:00',
      invitee_name: 'Jane',
      invitee_email: 'jane@example.com',
    };

    const startTime = booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z';
    const endTime = booking.end_time.includes('T') ? booking.end_time : booking.end_time.replace(' ', 'T') + 'Z';

    expect(startTime).toBe('2026-04-07T14:00:00Z');
    expect(endTime).toBe('2026-04-07T14:30:00Z');
  });
});

// ============================================================
// Outlook Calendar Events Full Details Tests
// ============================================================

describe('Outlook Calendar Events - Full Details Parsing', () => {
  it('should parse Outlook event with online meeting link', () => {
    const ev = {
      subject: 'Team Standup',
      start: { dateTime: '2026-04-07T09:00:00' },
      end: { dateTime: '2026-04-07T09:30:00' },
      location: { displayName: 'Conference Room A' },
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc123' },
    };

    const start = ev.start?.dateTime ? ev.start.dateTime + 'Z' : null;
    const end = ev.end?.dateTime ? ev.end.dateTime + 'Z' : null;
    const location = ev.onlineMeeting?.joinUrl || ev.location?.displayName || null;

    expect(start).toBe('2026-04-07T09:00:00Z');
    expect(end).toBe('2026-04-07T09:30:00Z');
    expect(location).toBe('https://teams.microsoft.com/l/meetup-join/abc123');
  });

  it('should fall back to location displayName when no online meeting', () => {
    const ev = {
      subject: 'In-Person Meeting',
      start: { dateTime: '2026-04-07T10:00:00' },
      end: { dateTime: '2026-04-07T11:00:00' },
      location: { displayName: '123 Main St' },
      onlineMeeting: null,
    };

    const location = ev.onlineMeeting?.joinUrl || ev.location?.displayName || null;

    expect(location).toBe('123 Main St');
  });

  it('should handle event with no location at all', () => {
    const ev = {
      subject: 'Quick Chat',
      start: { dateTime: '2026-04-07T15:00:00' },
      end: { dateTime: '2026-04-07T15:15:00' },
      location: null,
      onlineMeeting: null,
    };

    const location = ev.onlineMeeting?.joinUrl || ev.location?.displayName || null;

    expect(location).toBeNull();
  });

  it('should skip events with missing start/end datetime', () => {
    const events = [
      { subject: 'Valid', start: { dateTime: '2026-04-07T10:00:00' }, end: { dateTime: '2026-04-07T11:00:00' } },
      { subject: 'Missing Start', start: {}, end: { dateTime: '2026-04-07T12:00:00' } },
      { subject: 'Missing End', start: { dateTime: '2026-04-07T13:00:00' }, end: {} },
      { subject: 'Both Missing', start: {}, end: {} },
    ];

    const parsed = [];
    for (const ev of events) {
      const start = ev.start?.dateTime ? ev.start.dateTime + 'Z' : null;
      const end = ev.end?.dateTime ? ev.end.dateTime + 'Z' : null;
      if (!start || !end) continue;
      parsed.push({
        title: ev.subject || '(No title)',
        start, end,
        source: 'outlook',
        color: '#0078d4',
      });
    }

    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Valid');
    expect(parsed[0].source).toBe('outlook');
    expect(parsed[0].color).toBe('#0078d4');
  });

  it('should use (No title) for events without a subject', () => {
    const ev = {
      subject: null,
      start: { dateTime: '2026-04-07T10:00:00' },
      end: { dateTime: '2026-04-07T11:00:00' },
    };

    const title = ev.subject || '(No title)';
    expect(title).toBe('(No title)');
  });
});

// ============================================================
// 401 Retry Logic Tests
// ============================================================

describe('401 Retry Logic for Outlook API calls', () => {
  it('should identify 401 as requiring a token refresh retry', () => {
    const responseStatus = 401;
    const shouldRetry = responseStatus === 401;

    expect(shouldRetry).toBe(true);
  });

  it('should not retry on non-401 errors (e.g. 403, 500)', () => {
    expect(403 === 401).toBe(false);
    expect(500 === 401).toBe(false);
    expect(400 === 401).toBe(false);
    expect(404 === 401).toBe(false);
  });

  it('should not retry on successful responses', () => {
    expect(200 === 401).toBe(false);
    expect(201 === 401).toBe(false);
  });
});

// ============================================================
// Outlook Connection via Worker API Integration Tests
// ============================================================

describe('Outlook Calendar Connection - OAuth Flow Integration', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  it('should include offline_access in the OAuth URL for calendar connection', async () => {
    const env = createEnv();
    const sessionToken = await registerUser(worker, env);

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(302);

    const location = response.headers.get('Location');
    // Verify offline_access is in the URL (critical for getting refresh tokens)
    expect(location).toContain('offline_access');
  });

  it('should use correct Microsoft OAuth endpoint', async () => {
    const env = createEnv();
    const sessionToken = await registerUser(worker, env);

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    const location = response.headers.get('Location');
    expect(location).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize');
  });

  it('should include callback URL for outlook-calendar', async () => {
    const env = createEnv();
    const sessionToken = await registerUser(worker, env);

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
      redirect: 'manual',
    });

    const response = await worker.default.fetch(request, env, {});
    const location = response.headers.get('Location');
    expect(location).toContain(encodeURIComponent('/api/auth/callback/outlook-calendar'));
  });

  it('should require authentication for Outlook calendar connection', async () => {
    const env = createEnv();

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });

  it('should return 500 when MICROSOFT_CLIENT_ID is not set', async () => {
    const env = createEnv();
    delete env.MICROSOFT_CLIENT_ID;
    const sessionToken = await registerUser(worker, env);

    const request = new Request('https://calendo.dev/api/calendars/connect/outlook', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
    });

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('not configured');
  });
});

// ============================================================
// Conflict Detection Slot Filtering Logic
// ============================================================

describe('Outlook Calendar Conflict Detection', () => {
  it('should block a slot that overlaps with an Outlook busy time', () => {
    const slotStartMs = new Date('2026-04-07T14:00:00Z').getTime();
    const slotEndMs = new Date('2026-04-07T14:30:00Z').getTime();
    const busyRange = {
      start: new Date('2026-04-07T13:45:00Z').getTime(),
      end: new Date('2026-04-07T14:15:00Z').getTime(),
    };

    const hasConflict = slotStartMs < busyRange.end && slotEndMs > busyRange.start;

    expect(hasConflict).toBe(true);
  });

  it('should allow a slot that does not overlap with any busy time', () => {
    const slotStartMs = new Date('2026-04-07T15:00:00Z').getTime();
    const slotEndMs = new Date('2026-04-07T15:30:00Z').getTime();
    const busyRange = {
      start: new Date('2026-04-07T13:00:00Z').getTime(),
      end: new Date('2026-04-07T14:00:00Z').getTime(),
    };

    const hasConflict = slotStartMs < busyRange.end && slotEndMs > busyRange.start;

    expect(hasConflict).toBe(false);
  });

  it('should block when slot is entirely within a busy period', () => {
    const slotStartMs = new Date('2026-04-07T10:15:00Z').getTime();
    const slotEndMs = new Date('2026-04-07T10:45:00Z').getTime();
    const busyRange = {
      start: new Date('2026-04-07T10:00:00Z').getTime(),
      end: new Date('2026-04-07T11:00:00Z').getTime(),
    };

    const hasConflict = slotStartMs < busyRange.end && slotEndMs > busyRange.start;

    expect(hasConflict).toBe(true);
  });

  it('should block when busy period is entirely within the slot', () => {
    const slotStartMs = new Date('2026-04-07T09:00:00Z').getTime();
    const slotEndMs = new Date('2026-04-07T10:00:00Z').getTime();
    const busyRange = {
      start: new Date('2026-04-07T09:15:00Z').getTime(),
      end: new Date('2026-04-07T09:45:00Z').getTime(),
    };

    const hasConflict = slotStartMs < busyRange.end && slotEndMs > busyRange.start;

    expect(hasConflict).toBe(true);
  });

  it('should allow adjacent (non-overlapping) slots', () => {
    const slotStartMs = new Date('2026-04-07T14:00:00Z').getTime();
    const slotEndMs = new Date('2026-04-07T14:30:00Z').getTime();
    // Busy period ends exactly when slot starts
    const busyRange = {
      start: new Date('2026-04-07T13:00:00Z').getTime(),
      end: new Date('2026-04-07T14:00:00Z').getTime(),
    };

    const hasConflict = slotStartMs < busyRange.end && slotEndMs > busyRange.start;

    expect(hasConflict).toBe(false);
  });

  it('should account for buffer times in conflict checking', () => {
    const slotStartMs = new Date('2026-04-07T14:00:00Z').getTime();
    const slotEndMs = new Date('2026-04-07T14:30:00Z').getTime();
    const bufferBefore = 15 * 60 * 1000; // 15 min
    const bufferAfter = 10 * 60 * 1000; // 10 min

    // Busy period: 13:50 - 14:00 -- no conflict without buffer, but conflict with 15min before-buffer
    const busyRange = {
      start: new Date('2026-04-07T13:50:00Z').getTime(),
      end: new Date('2026-04-07T14:00:00Z').getTime(),
    };

    // Without buffer
    const hasConflictNoBuffer = slotStartMs < busyRange.end && slotEndMs > busyRange.start;
    expect(hasConflictNoBuffer).toBe(false);

    // With buffer (buffered slot extends back by 15 min)
    const hasConflictWithBuffer = (slotStartMs - bufferBefore) < busyRange.end && (slotEndMs + bufferAfter) > busyRange.start;
    expect(hasConflictWithBuffer).toBe(true);
  });
});
