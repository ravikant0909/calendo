import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revokeOAuthGrant } from '../../../src/worker.js';

const TEST_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes base64

// Mirror src/worker.js encryptToken so we can build a realistic encrypted token.
async function encryptToken(token, keyBase64) {
  const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(token));
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

describe('revokeOAuthGrant — actually removes the grant at the provider', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('revokes a Google grant by POSTing the refresh token to Google revoke endpoint', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; });
    const refresh_token_encrypted = await encryptToken('1//refresh-xyz', TEST_KEY);
    const ok = await revokeOAuthGrant({ ENCRYPTION_KEY: TEST_KEY }, {
      provider: 'google', refresh_token_encrypted, access_token_encrypted: null,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.body).toContain('token=' + encodeURIComponent('1//refresh-xyz'));
  });

  it('prefers the refresh token but falls back to the access token', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; });
    const access_token_encrypted = await encryptToken('ya29.access-only', TEST_KEY);
    const ok = await revokeOAuthGrant({ ENCRYPTION_KEY: TEST_KEY }, {
      provider: 'google', refresh_token_encrypted: null, access_token_encrypted,
    });
    expect(ok).toBe(true);
    expect(calls[0].opts.body).toContain('ya29.access-only');
  });

  it('treats a 400 (already-invalid token) as effectively revoked', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400 }));
    const refresh_token_encrypted = await encryptToken('dead-token', TEST_KEY);
    const ok = await revokeOAuthGrant({ ENCRYPTION_KEY: TEST_KEY }, { provider: 'google', refresh_token_encrypted });
    expect(ok).toBe(true);
  });

  it('does NOT call any endpoint for Microsoft/Outlook (no delegated revoke endpoint)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const ok = await revokeOAuthGrant({ ENCRYPTION_KEY: TEST_KEY }, { provider: 'outlook', refresh_token_encrypted: 'x' });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns false (no throw) when there is no stored token', async () => {
    const ok = await revokeOAuthGrant({ ENCRYPTION_KEY: TEST_KEY }, { provider: 'google', refresh_token_encrypted: null, access_token_encrypted: null });
    expect(ok).toBe(false);
  });

  it('never throws even if revoke network call fails (must not block disconnect/delete)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    const refresh_token_encrypted = await encryptToken('t', TEST_KEY);
    const ok = await revokeOAuthGrant({ ENCRYPTION_KEY: TEST_KEY }, { provider: 'google', refresh_token_encrypted });
    expect(ok).toBe(false);
  });
});

describe('revoke is wired into disconnect + both delete paths', () => {
  const src = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');
  it('handleDeleteCalendarConnection revokes before deleting the row', () => {
    expect(src).toMatch(/await revokeOAuthGrant\(env, connection\)[\s\S]{0,120}DELETE FROM calendar_connections WHERE id/);
  });
  it('account deletion revokes all grants first (via the shared deleteAllUserData helper)', () => {
    // Both delete paths funnel through deleteAllUserData, which revokes calendar
    // (and Zoom) grants before the atomic batch delete.
    expect(src).toMatch(/async function deleteAllUserData[\s\S]{0,400}revokeAllCalendarGrants\(env, userId\)/);
    expect(src).toMatch(/async function deleteAllUserData[\s\S]{0,500}revokeZoomGrant\(env, userId\)/);
  });
  it('both delete paths (REST handler + AI tool) route through deleteAllUserData', () => {
    const count = (src.match(/await deleteAllUserData\(env, user\.id\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
