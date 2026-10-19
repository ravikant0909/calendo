import { describe, it, expect } from 'vitest';
import { jsonResponse, classifyAiError } from '../../../src/worker.js';

// Round-6 regressions from the Computer Use test loop:
//  - RETEST CU-04 Step 5: deleted Outlook event's blocked slots persisted because
//    /api/availability responses were cacheable (no Cache-Control). Stale availability
//    is a correctness/double-booking risk, so every API JSON response is now no-store.
//  - CU-09: the dashboard AI assistant failed mid-run and surfaced a generic
//    "something went wrong", making it impossible to tell it was an external Anthropic
//    issue. Errors are now classified into actionable messages (OI-9).

describe('CU run-6: API responses are never cached (RETEST CU-04 stale availability)', () => {
  it('jsonResponse always sets Cache-Control: no-store', () => {
    const res = jsonResponse({ slots: ['10:00', '10:30'] });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('sets no-store on non-200 responses too (errors must not be cached)', () => {
    const res = jsonResponse({ error: 'not found' }, 404);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('availability endpoint output is not cacheable end-to-end', async () => {
    // Empty mock DB → public availability route returns a jsonResponse error,
    // which still proves the header is applied on the public booking path.
    const worker = await import('../../../src/worker.js');
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) },
      ASSETS: { fetch: () => new Response('asset') },
    };
    const res = await worker.default.fetch(
      new Request('http://localhost/api/public/nobody/none/slots?date=2026-06-10&tz=America/Los_Angeles'),
      env,
      {}
    );
    // Whatever status it returns, an API JSON response must carry no-store.
    if ((res.headers.get('Content-Type') || '').includes('application/json')) {
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});

describe('CU run-6: dashboard AI error classification (OI-9 / CU-09)', () => {
  it('429 → rate-limited message', () => {
    expect(classifyAiError(new Error('Claude API 429: rate_limit_error'))).toMatch(/rate-limited/i);
  });

  it('529 / overloaded → busy message', () => {
    expect(classifyAiError(new Error('Claude API 529: overloaded_error'))).toMatch(/busy/i);
    expect(classifyAiError(new Error('overloaded'))).toMatch(/busy/i);
  });

  it('401 / 403 / auth → authentication message (covers BYOK and system key)', () => {
    expect(classifyAiError(new Error('Claude API 401: authentication_error invalid x-api-key'))).toMatch(/authenticate/i);
    expect(classifyAiError(new Error('Claude API 403: permission_error'))).toMatch(/authenticate/i);
  });

  it('400 + credit/billing → out-of-credit message', () => {
    expect(classifyAiError(new Error('Claude API 400: your credit balance is too low'))).toMatch(/credit/i);
    expect(classifyAiError(new Error('Claude API 400: billing issue'))).toMatch(/credit/i);
  });

  it('5xx → provider outage message', () => {
    expect(classifyAiError(new Error('Claude API 500: Internal server error'))).toMatch(/temporarily unavailable|outage/i);
    expect(classifyAiError(new Error('Claude API 503: service unavailable'))).toMatch(/temporarily unavailable|outage/i);
  });

  it('network/fetch failure (no status) → connectivity message', () => {
    expect(classifyAiError(new Error('fetch failed'))).toMatch(/reach the AI service/i);
    expect(classifyAiError(new TypeError('Failed to fetch'))).toMatch(/reach the AI service/i);
  });

  it('unknown error → generic but specific fallback', () => {
    const msg = classifyAiError(new Error('some unexpected thing'));
    expect(msg).toMatch(/AI assistant/i);
  });

  it('400 without credit keywords does NOT claim out-of-credit', () => {
    const msg = classifyAiError(new Error('Claude API 400: invalid request: messages too long'));
    expect(msg).not.toMatch(/out of credit/i);
  });
});
