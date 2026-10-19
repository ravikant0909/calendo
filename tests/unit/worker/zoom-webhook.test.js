import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// ============================================================
// Zoom deauthorization webhook — POST /api/zoom/webhook
// (handleZoomWebhook in src/worker.js). PUBLIC route, no session.
//
// Behaviors locked in here (confirmed against src/worker.js):
//   - No ZOOM_WEBHOOK_SECRET_TOKEN  -> 503
//   - Invalid JSON body             -> 400
//   - endpoint.url_validation       -> 200 { plainToken, encryptedToken }
//                                      where encryptedToken = HMAC-SHA256(plainToken, secret) hex
//   - Non-validation event, missing/wrong x-zm-signature -> 401, NO deletion
//   - app_deauthorized + valid signature -> 200, DELETE FROM zoom_connections
//                                      WHERE zoom_user_id = ? bound to payload.user_id
//   - Correctly-signed unknown event -> 200, no deletion
//
// The signature is computed over the RAW request bytes. We build the rawBody
// string exactly once and use the same string for both the signature and the
// request body, otherwise the worker's HMAC over `request.text()` won't match.
// ============================================================

const WEBHOOK_SECRET = 'zm_test_secret_token_123';

// Node-crypto reference implementations so the test computes the expected
// values independently of the worker's WebCrypto code (non-tautological).
function hmacHex(message, secret) {
  return createHmac('sha256', secret).update(message).digest('hex');
}

// The worker authenticates non-validation events with:
//   x-zm-signature = 'v0=' + HMAC-SHA256('v0:<timestamp>:<rawBody>', secret)
function zoomSignature(rawBody, timestamp, secret = WEBHOOK_SECRET) {
  return `v0=${hmacHex(`v0:${timestamp}:${rawBody}`, secret)}`;
}

// ------------------------------------------------------------
// Mock DB — models zoom_connections SELECT/INSERT/DELETE and
// exposes db._queries for assertions (extended from ai-dashboard mock).
// ------------------------------------------------------------
function createMockDB(opts = {}) {
  const tables = {
    zoom_connections: opts.zoomConnections || [],
  };

  const queries = [];

  return {
    _tables: tables,
    _queries: queries,
    prepare(sql) {
      return {
        bind(...args) {
          queries.push({ sql, args });
          return {
            async first() {
              if (sql.includes('FROM zoom_connections') && sql.includes('zoom_user_id = ?')) {
                return tables.zoom_connections.find(c => c.zoom_user_id === args[0]) || null;
              }
              if (sql.includes('FROM zoom_connections') && sql.includes('user_id = ?')) {
                return tables.zoom_connections.find(c => c.user_id === args[0]) || null;
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.includes('DELETE FROM zoom_connections') && sql.includes('zoom_user_id = ?')) {
                const idx = tables.zoom_connections.findIndex(c => c.zoom_user_id === args[0]);
                if (idx !== -1) tables.zoom_connections.splice(idx, 1);
              } else if (sql.includes('DELETE FROM zoom_connections') && sql.includes('user_id = ?')) {
                const idx = tables.zoom_connections.findIndex(c => c.user_id === args[0]);
                if (idx !== -1) tables.zoom_connections.splice(idx, 1);
              }
              if (sql.includes('INSERT INTO zoom_connections')) {
                tables.zoom_connections.push({
                  id: tables.zoom_connections.length + 1,
                  user_id: args[0],
                  zoom_user_id: args[4],
                  email: args[5],
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

// env with the webhook secret configured (Zoom OAuth deliberately left
// unconfigured so the data-compliance fetch is skipped — keeps the deauth
// path from making a real network call).
function createWebhookEnv(dbOpts = {}, envOverrides = {}) {
  const db = createMockDB(dbOpts);
  return {
    env: {
      DB: db,
      ASSETS: { fetch: () => new Response('') },
      ZOOM_WEBHOOK_SECRET_TOKEN: WEBHOOK_SECRET,
      ...envOverrides,
    },
    db,
  };
}

function webhookRequest(rawBody, headers = {}) {
  return new Request('https://calendo.dev/api/zoom/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
}

describe('Zoom webhook (POST /api/zoom/webhook)', () => {
  let worker;
  let originalFetch;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------
  // 1. NOT CONFIGURED
  // ----------------------------------------------------------
  it('returns 503 when ZOOM_WEBHOOK_SECRET_TOKEN is not set', async () => {
    const { env } = createWebhookEnv({}, { ZOOM_WEBHOOK_SECRET_TOKEN: undefined });
    delete env.ZOOM_WEBHOOK_SECRET_TOKEN;

    // Valid JSON so we exercise the "not configured" branch, not the JSON branch.
    const rawBody = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } });
    const response = await worker.default.fetch(webhookRequest(rawBody), env, {});

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/not configured/i);
  });

  // ----------------------------------------------------------
  // 2. INVALID JSON
  // ----------------------------------------------------------
  it('returns 400 for an invalid JSON body', async () => {
    const { env } = createWebhookEnv();
    const response = await worker.default.fetch(webhookRequest('{not valid json'), env, {});

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  // ----------------------------------------------------------
  // 3. URL VALIDATION HANDSHAKE
  // ----------------------------------------------------------
  it('echoes plainToken and HMAC-SHA256 encryptedToken for endpoint.url_validation', async () => {
    const { env } = createWebhookEnv();
    const plainToken = 'abc123';
    const rawBody = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken } });

    const response = await worker.default.fetch(webhookRequest(rawBody), env, {});
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.plainToken).toBe(plainToken);

    // encryptedToken must be HMAC-SHA256(plainToken, secret) as lowercase hex,
    // computed here independently with node crypto.
    const expectedEncrypted = hmacHex(plainToken, WEBHOOK_SECRET);
    expect(body.encryptedToken).toBe(expectedEncrypted);
    expect(body.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
  });

  // ----------------------------------------------------------
  // 4. SIGNATURE REQUIRED
  // ----------------------------------------------------------
  it('returns 401 and does NOT delete when x-zm-signature is missing', async () => {
    const { env, db } = createWebhookEnv({
      zoomConnections: [{ id: 1, user_id: 7, zoom_user_id: 'zoom-user-XYZ', email: 'gone@example.com' }],
    });
    const ts = '1718400000';
    const rawBody = JSON.stringify({ event: 'app_deauthorized', payload: { user_id: 'zoom-user-XYZ', account_id: 'acct-1' } });

    // No x-zm-signature header at all.
    const response = await worker.default.fetch(webhookRequest(rawBody, { 'x-zm-request-timestamp': ts }), env, {});

    expect(response.status).toBe(401);
    const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM zoom_connections'));
    expect(deleteQuery).toBeUndefined();
    // The seeded connection must still be present.
    expect(db._tables.zoom_connections).toHaveLength(1);
  });

  it('returns 401 and does NOT delete when x-zm-signature is wrong', async () => {
    const { env, db } = createWebhookEnv({
      zoomConnections: [{ id: 1, user_id: 7, zoom_user_id: 'zoom-user-XYZ', email: 'gone@example.com' }],
    });
    const ts = '1718400000';
    const rawBody = JSON.stringify({ event: 'app_deauthorized', payload: { user_id: 'zoom-user-XYZ', account_id: 'acct-1' } });

    // A signature computed with the WRONG secret must be rejected.
    const wrongSig = zoomSignature(rawBody, ts, 'totally-wrong-secret');
    const response = await worker.default.fetch(
      webhookRequest(rawBody, { 'x-zm-request-timestamp': ts, 'x-zm-signature': wrongSig }),
      env,
      {}
    );

    expect(response.status).toBe(401);
    const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM zoom_connections'));
    expect(deleteQuery).toBeUndefined();
    expect(db._tables.zoom_connections).toHaveLength(1);
  });

  // ----------------------------------------------------------
  // 5. VALID SIGNATURE + app_deauthorized -> delete the connection
  // ----------------------------------------------------------
  it('deletes the zoom_connections row for payload.user_id on a validly-signed app_deauthorized', async () => {
    const zoomUserId = 'zoom-user-XYZ';
    const { env, db } = createWebhookEnv({
      zoomConnections: [
        { id: 1, user_id: 7, zoom_user_id: zoomUserId, email: 'gone@example.com' },
        { id: 2, user_id: 8, zoom_user_id: 'other-zoom-user', email: 'stays@example.com' },
      ],
    });

    const ts = '1718400000';
    // Build the rawBody string ONCE and reuse it for both signature and body.
    const rawBody = JSON.stringify({
      event: 'app_deauthorized',
      payload: { user_id: zoomUserId, account_id: 'acct-1' },
    });
    const signature = zoomSignature(rawBody, ts);

    // Zoom OAuth is not configured in this env, so the data-compliance fetch is
    // skipped; guard fetch anyway so a real network call can never happen.
    globalThis.fetch = async () => { throw new Error('unexpected network call'); };

    const response = await worker.default.fetch(
      webhookRequest(rawBody, { 'x-zm-request-timestamp': ts, 'x-zm-signature': signature }),
      env,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    // The worker issued DELETE FROM zoom_connections WHERE zoom_user_id = ?
    // bound to the payload's user_id.
    const deleteQuery = db._queries.find(q =>
      q.sql.includes('DELETE FROM zoom_connections') && q.sql.includes('zoom_user_id = ?')
    );
    expect(deleteQuery).toBeTruthy();
    expect(deleteQuery.args[0]).toBe(zoomUserId);

    // The matching row is gone; the unrelated connection survives.
    expect(db._tables.zoom_connections.find(c => c.zoom_user_id === zoomUserId)).toBeUndefined();
    expect(db._tables.zoom_connections.find(c => c.zoom_user_id === 'other-zoom-user')).toBeTruthy();
    expect(db._tables.zoom_connections).toHaveLength(1);
  });

  // ----------------------------------------------------------
  // 6. Correctly-signed unknown event -> 200, no deletion
  // ----------------------------------------------------------
  it('acknowledges a correctly-signed unknown event with 200 and no deletion', async () => {
    const { env, db } = createWebhookEnv({
      zoomConnections: [{ id: 1, user_id: 7, zoom_user_id: 'zoom-user-XYZ', email: 'stays@example.com' }],
    });

    const ts = '1718400000';
    const rawBody = JSON.stringify({
      event: 'meeting.started',
      payload: { user_id: 'zoom-user-XYZ', object: { id: '123' } },
    });
    const signature = zoomSignature(rawBody, ts);

    const response = await worker.default.fetch(
      webhookRequest(rawBody, { 'x-zm-request-timestamp': ts, 'x-zm-signature': signature }),
      env,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM zoom_connections'));
    expect(deleteQuery).toBeUndefined();
    expect(db._tables.zoom_connections).toHaveLength(1);
  });

  // ----------------------------------------------------------
  // 7. General-app deauthorization fallback: Zoom's deauthorization endpoint has
  //    no Secret Token, so the event may arrive WITHOUT an x-zm-signature. In
  //    that case the event is accepted only if payload.client_id matches our own
  //    OAuth client id, and we still only delete a connection we actually hold.
  // ----------------------------------------------------------
  it('deletes on UNSIGNED app_deauthorized when payload.client_id matches our app (no webhook secret set)', async () => {
    const zoomUserId = 'zoom-user-XYZ';
    const { env, db } = createWebhookEnv(
      { zoomConnections: [{ id: 1, user_id: 7, zoom_user_id: zoomUserId, email: 'gone@example.com' }] },
      { ZOOM_WEBHOOK_SECRET_TOKEN: undefined, ZOOM_OAUTH_CLIENT_ID: 'our-client-id' }
    );
    delete env.ZOOM_WEBHOOK_SECRET_TOKEN; // realistic: deauth endpoint has no Secret Token

    const rawBody = JSON.stringify({
      event: 'app_deauthorized',
      payload: { user_id: zoomUserId, account_id: 'acct-1', client_id: 'our-client-id' },
    });
    // Zoom OAuth not fully configured (no client secret) -> compliance fetch is
    // skipped; guard fetch so a real network call can never happen.
    globalThis.fetch = async () => { throw new Error('unexpected network call'); };

    // No x-zm-signature header at all.
    const response = await worker.default.fetch(webhookRequest(rawBody), env, {});

    expect(response.status).toBe(200);
    const del = db._queries.find(q =>
      q.sql.includes('DELETE FROM zoom_connections') && q.sql.includes('zoom_user_id = ?'));
    expect(del).toBeTruthy();
    expect(del.args[0]).toBe(zoomUserId);
    expect(db._tables.zoom_connections).toHaveLength(0);
  });

  it('returns 401 and does NOT delete on UNSIGNED app_deauthorized when client_id is not ours', async () => {
    const { env, db } = createWebhookEnv(
      { zoomConnections: [{ id: 1, user_id: 7, zoom_user_id: 'zoom-user-XYZ', email: 'stays@example.com' }] },
      { ZOOM_WEBHOOK_SECRET_TOKEN: undefined, ZOOM_OAUTH_CLIENT_ID: 'our-client-id' }
    );
    delete env.ZOOM_WEBHOOK_SECRET_TOKEN;

    const rawBody = JSON.stringify({
      event: 'app_deauthorized',
      payload: { user_id: 'zoom-user-XYZ', account_id: 'acct-1', client_id: 'attacker-client-id' },
    });
    const response = await worker.default.fetch(webhookRequest(rawBody), env, {});

    expect(response.status).toBe(401);
    const del = db._queries.find(q => q.sql.includes('DELETE FROM zoom_connections'));
    expect(del).toBeUndefined();
    expect(db._tables.zoom_connections).toHaveLength(1);
  });
});
