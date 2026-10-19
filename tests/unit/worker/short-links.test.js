import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pretty top-level booking links: /<username> and /<username>/<event-slug>.
function makeEnv(slugs) {
  return {
    DB: {
      prepare: (sql) => ({
        bind: (...a) => ({
          first: async () =>
            sql.includes('booking_pages WHERE slug') && slugs.includes(a[0]) ? { slug: a[0] } : null,
        }),
      }),
    },
    ASSETS: { fetch: (req) => { const u = new URL(req.url); return new Response('ASSET:' + u.pathname + u.search); } },
  };
}

describe('Short links: pretty /<user>[/<event>] routing', () => {
  it('serves the booking page at /<username> (clean URL, query rewrite under the hood)', async () => {
    const worker = await import('../../../src/worker.js');
    const res = await worker.default.fetch(new Request('http://localhost/ravi'), makeEnv(['ravi']), {});
    const body = await res.text();
    expect(body).toContain('/booking/');
    expect(body).toContain('user=ravi');
  });

  it('serves a specific event at /<username>/<event-slug>', async () => {
    const worker = await import('../../../src/worker.js');
    const res = await worker.default.fetch(new Request('http://localhost/ravi/30-min'), makeEnv(['ravi']), {});
    const body = await res.text();
    expect(body).toContain('user=ravi');
    expect(body).toContain('event=30-min');
  });

  it('does NOT hijack reserved system paths', async () => {
    const worker = await import('../../../src/worker.js');
    const res = await worker.default.fetch(new Request('http://localhost/dashboard'), makeEnv(['dashboard']), {});
    const body = await res.text();
    expect(body).toBe('ASSET:/dashboard'); // served as the real asset, not a booking page
    expect(body).not.toContain('user=');
  });

  it('falls through for unknown slugs (no booking page)', async () => {
    const worker = await import('../../../src/worker.js');
    const res = await worker.default.fetch(new Request('http://localhost/nobody'), makeEnv(['ravi']), {});
    const body = await res.text();
    expect(body).not.toContain('user=');
  });

  it('reserves slugs in the worker (route guard + slug validation)', () => {
    const src = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');
    expect(src).toContain('const RESERVED_PATHS');
    expect(src).toContain('isReservedSlug(prettyMatch[1])'); // route guard
    // user-set slug + auto-generated slug both reject/avoid reserved words
    expect(src).toMatch(/isReservedSlug\(newSlug\)/);
    expect(src).toMatch(/!isReservedSlug\(candidate\)/);
  });

  it('declares an ASSETS binding so env.ASSETS.fetch works (the pretty route depends on it)', () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), 'wrangler.json'), 'utf8'));
    expect(cfg.assets && cfg.assets.binding).toBe('ASSETS');
  });
});
