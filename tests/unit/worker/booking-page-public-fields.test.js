import { describe, it, expect, beforeAll } from 'vitest';

// Regression: public GET /api/booking-page/:slug used `SELECT bp.*` and leaked
// host-only fields (blocked_emails, custom_domain, user_id) to anyone.

// The mock returns the FULL row (like `bp.*` would), so the test also proves the
// handler filters the response, not just the SQL.
const FULL_ROW = {
  id: 7,
  user_id: 42,
  slug: 'test-host',
  display_name: 'Test Host',
  bio: 'Hi',
  brand_color: '#123456',
  custom_css: null,
  custom_domain: 'book.secret-host.com',
  welcome_message: 'Welcome',
  logo_url: null,
  hide_branding: 0,
  cancellation_policy: '24h notice',
  blocked_emails: 'stalker@example.com\n@baddomain.com',
  ga_measurement_id: 'G-PUBLIC',
  meta_pixel_id: '123',
  created_at: '2026-01-01',
  updated_at: '2026-01-02',
  name: 'Test User',
  avatar_url: 'https://example.com/a.png',
};

function createMockDB() {
  const seenSql = [];
  return {
    seenSql,
    prepare(sql) {
      seenSql.push(sql);
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM booking_pages bp') && sql.includes('JOIN users u')) {
                return args[0] === 'test-host' ? { ...FULL_ROW } : null;
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { success: true }; },
          };
        },
      };
    },
  };
}

describe('public GET /api/booking-page/:slug hides host-only fields', () => {
  let worker;
  beforeAll(async () => {
    worker = await import('../../../src/worker.js');
  });

  async function getPage(db) {
    const req = new Request('https://calendo.dev/api/booking-page/test-host', { method: 'GET' });
    const res = await worker.default.fetch(req, { DB: db }, {});
    return { res, data: await res.json() };
  }

  it('does not return blocked_emails, custom_domain or user_id', async () => {
    const { res, data } = await getPage(createMockDB());
    expect(res.status).toBe(200);
    expect(data.page).not.toHaveProperty('blocked_emails');
    expect(data.page).not.toHaveProperty('custom_domain');
    expect(data.page).not.toHaveProperty('user_id');
    expect(data.page).not.toHaveProperty('id');
    expect(JSON.stringify(data)).not.toContain('stalker@example.com');
  });

  it('still returns the fields the booking page uses', async () => {
    const { data } = await getPage(createMockDB());
    expect(data.page).toMatchObject({
      slug: 'test-host',
      display_name: 'Test Host',
      brand_color: '#123456',
      welcome_message: 'Welcome',
      cancellation_policy: '24h notice',
      ga_measurement_id: 'G-PUBLIC',
      meta_pixel_id: '123',
      name: 'Test User',
      avatar_url: 'https://example.com/a.png',
    });
  });

  it('does not select bp.* or blocked_emails in SQL', async () => {
    const db = createMockDB();
    await getPage(db);
    const sql = db.seenSql.find(s => s.includes('FROM booking_pages bp') && s.includes('JOIN users u'));
    expect(sql).toBeTruthy();
    expect(sql).not.toContain('bp.*');
    expect(sql).not.toContain('blocked_emails');
  });

  it('returns 404 for unknown slug', async () => {
    const req = new Request('https://calendo.dev/api/booking-page/nope', { method: 'GET' });
    const res = await worker.default.fetch(req, { DB: createMockDB() }, {});
    expect(res.status).toBe(404);
  });
});
