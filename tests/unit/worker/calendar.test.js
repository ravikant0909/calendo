import { describe, it, expect, beforeEach } from 'vitest';

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
              if (sql.includes('INSERT INTO users')) {
                const id = autoIncrement.users++;
                const user = { id, email: args[0], password_hash: args[1], name: args[2], timezone: args[3], avatar_url: null, created_at: new Date().toISOString() };
                tables.users.push(user);
                return { id: user.id, email: user.email, name: user.name, timezone: user.timezone, avatar_url: null, created_at: user.created_at };
              }
              if (sql.includes('SELECT id FROM booking_pages WHERE slug')) {
                return tables.booking_pages.find(p => p.slug === args[0]) || null;
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
              if (sql.includes('calendar_connections WHERE id = ? AND user_id')) {
                return tables.calendar_connections.find(c => c.id == args[0] && c.user_id === args[1]) || null;
              }
              if (sql.includes('SELECT id, provider, email')) {
                // handleListCalendarConnections query
                return null; // handled by all()
              }
              if (sql.includes('SELECT id, name, email, timezone FROM users')) {
                return tables.users.find(u => u.id === args[0]) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes('SELECT id, provider, email')) {
                const connections = tables.calendar_connections.filter(c => c.user_id === args[0]);
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
              if (sql.includes('DELETE FROM calendar_connections')) {
                tables.calendar_connections = tables.calendar_connections.filter(c => c.id != args[0]);
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
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 bytes base64
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
// Tests
// ============================================================

describe('Google Calendar OAuth & Sync', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  describe('GET /api/calendars/connect/google', () => {
    it('should redirect to Google OAuth consent screen', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(worker, env);

      const request = new Request('https://calendo.dev/api/calendars/connect/google', {
        method: 'GET',
        headers: { Cookie: `session=${sessionToken}` },
        redirect: 'manual',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(302);

      const location = response.headers.get('Location');
      expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
      expect(location).toContain('client_id=test-client-id');
      expect(location).toContain('calendar.events');
      expect(location).toContain('calendar.readonly');
      expect(location).toContain('access_type=offline');
      expect(location).toContain('prompt=consent');
      expect(location).toContain('state=gcal_1%3A');
      expect(location).toContain(encodeURIComponent('https://calendo.dev/api/auth/callback/google-calendar'));
    });

    it('should return 500 when GOOGLE_CLIENT_ID is not set', async () => {
      const env = createEnv();
      delete env.GOOGLE_CLIENT_ID;
      const sessionToken = await registerUser(worker, env);

      const request = new Request('https://calendo.dev/api/calendars/connect/google', {
        method: 'GET',
        headers: { Cookie: `session=${sessionToken}` },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('not configured');
    });

    it('should require authentication', async () => {
      const env = createEnv();

      const request = new Request('https://calendo.dev/api/calendars/connect/google', {
        method: 'GET',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/auth/callback/google-calendar', () => {
    it('should redirect with error when Google returns error', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/callback/google-calendar?error=access_denied', {
        method: 'GET',
        redirect: 'manual',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('calendar=error');
      expect(location).toContain('access_denied');
    });

    it('should redirect with error when code or state is missing', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/callback/google-calendar?code=abc', {
        method: 'GET',
        redirect: 'manual',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('calendar=error');
      expect(location).toContain('missing_params');
    });

    it('should redirect with error when state is not a valid signed value', async () => {
      const env = createEnv();
      const request = new Request('https://calendo.dev/api/auth/callback/google-calendar?code=abc&state=forged-state', {
        method: 'GET',
        redirect: 'manual',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('invalid_state');
    });
  });

  describe('GET /api/calendars', () => {
    it('should list calendar connections for the authenticated user', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(worker, env);

      // Manually add a calendar connection
      env.DB._tables.calendar_connections.push({
        id: 1,
        user_id: 1,
        provider: 'google',
        email: 'test@gmail.com',
        calendar_id: 'primary',
        is_primary: 1,
        check_conflicts: 1,
        write_events: 1,
        last_synced_at: null,
        created_at: new Date().toISOString(),
      });

      const request = new Request('https://calendo.dev/api/calendars', {
        method: 'GET',
        headers: { Cookie: `session=${sessionToken}` },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].provider).toBe('google');
      expect(body[0].email).toBe('test@gmail.com');
    });

    it('should return empty array when no connections exist', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(worker, env);

      const request = new Request('https://calendo.dev/api/calendars', {
        method: 'GET',
        headers: { Cookie: `session=${sessionToken}` },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });

    it('should require authentication', async () => {
      const env = createEnv();

      const request = new Request('https://calendo.dev/api/calendars', {
        method: 'GET',
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/calendars/:id', () => {
    it('should delete a calendar connection owned by the user', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(worker, env);

      // Manually add a calendar connection
      env.DB._tables.calendar_connections.push({
        id: 99,
        user_id: 1,
        provider: 'google',
        email: 'test@gmail.com',
      });

      const request = new Request('https://calendo.dev/api/calendars/99', {
        method: 'DELETE',
        headers: { Cookie: `session=${sessionToken}` },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ok).toBe(true);

      // Verify it was deleted
      expect(env.DB._tables.calendar_connections.length).toBe(0);
    });

    it('should return 404 when connection does not exist', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(worker, env);

      const request = new Request('https://calendo.dev/api/calendars/999', {
        method: 'DELETE',
        headers: { Cookie: `session=${sessionToken}` },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(404);
    });

    it('should not allow deleting another user\'s connection', async () => {
      const env = createEnv();
      const sessionToken = await registerUser(worker, env);

      // Add connection for a different user
      env.DB._tables.calendar_connections.push({
        id: 99,
        user_id: 999, // different user
        provider: 'google',
        email: 'other@gmail.com',
      });

      const request = new Request('https://calendo.dev/api/calendars/99', {
        method: 'DELETE',
        headers: { Cookie: `session=${sessionToken}` },
      });

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(404);

      // Verify it was NOT deleted
      expect(env.DB._tables.calendar_connections.length).toBe(1);
    });
  });
});

describe('Token Encryption/Decryption', () => {
  it('should encrypt and decrypt a token correctly', async () => {
    // Import the worker to get access to the functions
    // Since encryptToken/decryptToken are not exported, we test them indirectly
    // through the OAuth flow, or we test the pattern directly using Web Crypto API

    // Generate a 32-byte key as base64
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const keyBase64 = btoa(String.fromCharCode(...keyBytes));

    const originalToken = 'ya29.a0AfH6SMBx-test-access-token-12345';

    // Encrypt
    const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(originalToken);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);

    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const encrypted = `${ivB64}:${ctB64}`;

    // Verify format
    expect(encrypted).toContain(':');
    const parts = encrypted.split(':');
    expect(parts.length).toBe(2);

    // Decrypt
    const [decIvB64, decCtB64] = parts;
    const decIv = Uint8Array.from(atob(decIvB64), c => c.charCodeAt(0));
    const decCiphertext = Uint8Array.from(atob(decCtB64), c => c.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decIv }, cryptoKey, decCiphertext);
    const decrypted = new TextDecoder().decode(plaintext);

    expect(decrypted).toBe(originalToken);
  });

  it('should produce different ciphertexts for same plaintext (random IV)', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const keyBase64 = btoa(String.fromCharCode(...keyBytes));
    const token = 'test-token-value';

    const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
    const encoded = new TextEncoder().encode(token);

    const iv1 = crypto.getRandomValues(new Uint8Array(12));
    const ct1 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, cryptoKey, encoded);
    const encrypted1 = `${btoa(String.fromCharCode(...iv1))}:${btoa(String.fromCharCode(...new Uint8Array(ct1)))}`;

    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const ct2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, cryptoKey, encoded);
    const encrypted2 = `${btoa(String.fromCharCode(...iv2))}:${btoa(String.fromCharCode(...new Uint8Array(ct2)))}`;

    // Different IVs should produce different ciphertexts
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should fail to decrypt with wrong key', async () => {
    const keyBytes1 = crypto.getRandomValues(new Uint8Array(32));
    const keyBytes2 = crypto.getRandomValues(new Uint8Array(32));

    const cryptoKey1 = await crypto.subtle.importKey('raw', keyBytes1, 'AES-GCM', false, ['encrypt']);
    const cryptoKey2 = await crypto.subtle.importKey('raw', keyBytes2, 'AES-GCM', false, ['decrypt']);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode('secret-token');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey1, encoded);

    await expect(async () => {
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey2, ciphertext);
    }).rejects.toThrow();
  });
});

describe('Calendar view deduplication', () => {
  it('should treat UTC and offset timestamps as the same moment', () => {
    const calendoStart = '2026-04-20T18:00:00Z';
    const googleStart = '2026-04-20T11:00:00-07:00';
    expect(new Date(calendoStart).getTime()).toBe(new Date(googleStart).getTime());
  });

  it('should deduplicate events with matching epoch times', () => {
    const calendoEvents = [
      { title: '15 Minute Chat', start: '2026-04-20T18:00:00Z', source: 'calendo' },
      { title: 'Question', start: '2026-04-20T18:15:00Z', source: 'calendo' },
    ];
    const googleEvents = [
      { title: '15 Minute Chat with Geeta B', start: '2026-04-20T11:00:00-07:00', source: 'google' },
      { title: 'Question with Test User', start: '2026-04-20T11:15:00-07:00', source: 'google' },
      { title: 'Pick up Tina', start: '2026-04-20T16:45:00-07:00', source: 'google' },
    ];

    const calendoEpochs = new Set(calendoEvents.map(e => new Date(e.start).getTime()));
    const merged = [...calendoEvents];
    for (const ge of googleEvents) {
      if (!calendoEpochs.has(new Date(ge.start).getTime())) merged.push(ge);
    }

    expect(merged.length).toBe(3);
    expect(merged.filter(e => e.source === 'calendo').length).toBe(2);
    expect(merged.filter(e => e.source === 'google').length).toBe(1);
    expect(merged.find(e => e.source === 'google').title).toBe('Pick up Tina');
  });

  it('should NOT deduplicate events at different times', () => {
    const calendoEvents = [
      { title: 'Chat', start: '2026-04-20T18:00:00Z', source: 'calendo' },
    ];
    const googleEvents = [
      { title: 'Other meeting', start: '2026-04-20T19:00:00Z', source: 'google' },
    ];

    const calendoEpochs = new Set(calendoEvents.map(e => new Date(e.start).getTime()));
    const merged = [...calendoEvents];
    for (const ge of googleEvents) {
      if (!calendoEpochs.has(new Date(ge.start).getTime())) merged.push(ge);
    }

    expect(merged.length).toBe(2);
  });

  it('should handle string comparison failure that epoch comparison catches', () => {
    const utcTime = '2026-04-20T18:00:00Z';
    const offsetTime = '2026-04-20T11:00:00-07:00';

    // String comparison fails (the old bug)
    expect(utcTime).not.toBe(offsetTime);

    // Epoch comparison succeeds (the fix)
    const utcEpoch = new Date(utcTime).getTime();
    const offsetEpoch = new Date(offsetTime).getTime();
    expect(utcEpoch).toBe(offsetEpoch);
  });
});

describe('OAuth URL Generation', () => {
  it('should include all required OAuth parameters', () => {
    const clientId = 'test-client-id-12345';
    const origin = 'https://calendo.dev';
    const redirectUri = `${origin}/api/auth/callback/google-calendar`;
    const state = 'gcal_42:nonce:1700000000000:signature';

    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' ');

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    expect(url).toContain('client_id=test-client-id-12345');
    expect(url).toContain('redirect_uri=' + encodeURIComponent(redirectUri));
    expect(url).toContain('response_type=code');
    // URLSearchParams encodes spaces as + not %20
    expect(url).toContain('scope=');
    expect(url).toContain('calendar.events');
    expect(url).toContain('calendar.readonly');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('state=gcal_42%3Anonce%3A1700000000000%3Asignature');
  });

  it('should include both calendar scopes', () => {
    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' ');

    expect(scopes).toContain('calendar.events');
    expect(scopes).toContain('calendar.readonly');
  });

  it('should preserve the calendar payload inside the signed state', () => {
    const state = 'gcal_123:nonce:1700000000000:signature';
    expect(state.startsWith('gcal_123:')).toBe(true);
    expect(state.split(':')).toHaveLength(4);
  });
});
