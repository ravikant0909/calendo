import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mock DB for team page and audit log tests
// ============================================================

function createMockDB() {
  const tables = {
    users: [],
    sessions: [],
    booking_pages: [],
    availability_schedules: [],
    organizations: [],
    org_members: [],
    event_types: [],
    audit_log: [],
  };
  let autoIncrement = {
    users: 1,
    booking_pages: 1,
    availability_schedules: 1,
    organizations: 1,
    event_types: 1,
    audit_log: 1,
  };

  return {
    _tables: tables,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // Auth - session lookup
              if (sql.includes('SELECT s.user_id, u.*') && sql.includes('sessions')) {
                const session = tables.sessions.find(s => s.token === args[0]);
                if (!session) return null;
                const user = tables.users.find(u => u.id === session.user_id);
                return user ? { ...user, user_id: user.id } : null;
              }
              // Org by slug
              if (sql.includes('SELECT id, name, slug, logo_url FROM organizations WHERE slug')) {
                return tables.organizations.find(o => o.slug === args[0]) || null;
              }
              // Count audit log
              if (sql.includes('SELECT COUNT(*) as total FROM audit_log')) {
                let entries = [...tables.audit_log];
                if (sql.includes('user_id = ?')) {
                  entries = entries.filter(e => e.user_id === args[0]);
                  if (sql.includes('action = ?') && args[1]) {
                    entries = entries.filter(e => e.action === args[1]);
                  }
                }
                return { total: entries.length };
              }
              // API key lookup
              if (sql.includes('SELECT u.* FROM api_keys')) {
                return null;
              }
              return null;
            },
            async all() {
              // Org members with user info and booking pages
              if (sql.includes('FROM org_members om') && sql.includes('JOIN users u') && sql.includes('booking_pages')) {
                const members = tables.org_members
                  .filter(m => m.org_id === args[0])
                  .map(m => {
                    const user = tables.users.find(u => u.id === m.user_id);
                    const bp = tables.booking_pages.find(p => p.user_id === m.user_id);
                    return {
                      user_id: m.user_id,
                      name: user?.name || '',
                      avatar_url: user?.avatar_url || null,
                      booking_slug: bp?.slug || null,
                      display_name: bp?.display_name || null,
                    };
                  });
                return { results: members };
              }
              // Org event types (active, non-secret)
              if (sql.includes('FROM event_types et') && sql.includes('et.org_id = ?') && sql.includes('is_secret = 0')) {
                const ets = tables.event_types.filter(
                  et => et.org_id === args[0] && et.is_active === 1 && et.is_secret === 0
                );
                return { results: ets };
              }
              // Personal event types for members
              if (sql.includes('et.org_id IS NULL') && sql.includes('is_secret = 0')) {
                const userIds = args;
                const ets = tables.event_types.filter(
                  et => userIds.includes(et.user_id) && !et.org_id && et.is_active === 1 && et.is_secret === 0
                );
                return { results: ets };
              }
              // Audit log list
              if (sql.includes('SELECT') && sql.includes('FROM audit_log') && sql.includes('ORDER BY')) {
                let entries = [...tables.audit_log];
                if (sql.includes('user_id = ?')) {
                  const userIdIdx = 0;
                  entries = entries.filter(e => e.user_id === args[userIdIdx]);
                  // Filter by action if present
                  if (sql.includes('action = ?')) {
                    entries = entries.filter(e => e.action === args[1]);
                  }
                }
                entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                // Apply LIMIT and OFFSET (last two args)
                const limitVal = args[args.length - 2];
                const offsetVal = args[args.length - 1];
                if (typeof limitVal === 'number' && typeof offsetVal === 'number') {
                  entries = entries.slice(offsetVal, offsetVal + limitVal);
                }
                return { results: entries };
              }
              return { results: [] };
            },
            async run() {
              // Insert session
              if (sql.includes('INSERT INTO sessions')) {
                tables.sessions.push({ id: args[0], user_id: args[1], token: args[2], expires_at: args[3] });
              }
              // Insert booking page
              if (sql.includes('INSERT INTO booking_pages')) {
                tables.booking_pages.push({ id: autoIncrement.booking_pages++, user_id: args[0], slug: args[1], display_name: args[2] });
              }
              // Insert availability schedule
              if (sql.includes('INSERT INTO availability_schedules')) {
                tables.availability_schedules.push({ id: autoIncrement.availability_schedules++, user_id: args[0], name: args[1], timezone: args[2], rules: args[3], is_default: args[4] });
              }
              // Insert audit log
              if (sql.includes('INSERT INTO audit_log')) {
                tables.audit_log.push({
                  id: autoIncrement.audit_log++,
                  user_id: args[0],
                  action: args[1],
                  entity_type: args[2],
                  entity_id: args[3],
                  details: args[4],
                  ip_address: args[5],
                  created_at: new Date().toISOString(),
                });
              }
            },
          };
        },
      };
    },
  };
}

function addTestUser(db, { id, email, name, avatar_url } = {}) {
  const userId = id || db._tables.users.length + 1;
  db._tables.users.push({
    id: userId,
    email: email || `user${userId}@test.com`,
    name: name || `User ${userId}`,
    avatar_url: avatar_url || null,
    password_hash: 'hash',
    timezone: 'America/Los_Angeles',
    created_at: new Date().toISOString(),
  });
  return userId;
}

function addSession(db, userId) {
  const token = `session-${userId}-${Date.now()}`;
  db._tables.sessions.push({
    id: `id-${token}`,
    user_id: userId,
    token,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  return token;
}

function addOrg(db, { name, slug, owner_id, logo_url } = {}) {
  const org = {
    id: db._tables.organizations.length + 1,
    name: name || 'Test Org',
    slug: slug || 'test-org',
    owner_id: owner_id || 1,
    logo_url: logo_url || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db._tables.organizations.push(org);
  return org;
}

function addOrgMember(db, orgId, userId, role = 'member') {
  db._tables.org_members.push({ org_id: orgId, user_id: userId, role, created_at: new Date().toISOString() });
}

function addBookingPage(db, userId, slug, displayName) {
  const bp = {
    id: db._tables.booking_pages.length + 1,
    user_id: userId,
    slug,
    display_name: displayName || `User ${userId}`,
    created_at: new Date().toISOString(),
  };
  db._tables.booking_pages.push(bp);
  return bp;
}

function addEventType(db, { user_id, org_id, name, slug, is_active, is_secret, duration_minutes, color, location_type, price_cents, currency } = {}) {
  const et = {
    id: db._tables.event_types.length + 1,
    user_id: user_id || 1,
    org_id: org_id || null,
    name: name || 'Test Event',
    slug: slug || 'test-event',
    description: null,
    duration_minutes: duration_minutes || 30,
    color: color || '#0069ff',
    location_type: location_type || 'google_meet',
    price_cents: price_cents || null,
    currency: currency || 'usd',
    is_active: is_active !== undefined ? is_active : 1,
    is_secret: is_secret !== undefined ? is_secret : 0,
    sort_order: 0,
    created_at: new Date().toISOString(),
  };
  db._tables.event_types.push(et);
  return et;
}


// ============================================================
// Tests: Team Page
// ============================================================

describe('Team Page API', () => {
  let worker;
  let db;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
    db = createMockDB();
  });

  it('should return org members and event types for a valid org slug', async () => {
    const userId1 = addTestUser(db, { name: 'Alice' });
    const userId2 = addTestUser(db, { name: 'Bob' });
    const org = addOrg(db, { name: 'Acme Corp', slug: 'acme-corp', owner_id: userId1 });
    addOrgMember(db, org.id, userId1, 'owner');
    addOrgMember(db, org.id, userId2, 'member');
    addBookingPage(db, userId1, 'alice', 'Alice');
    addBookingPage(db, userId2, 'bob', 'Bob');
    addEventType(db, { user_id: userId1, org_id: org.id, name: '30 Min Call', slug: '30-min-call' });
    addEventType(db, { user_id: userId2, org_id: null, name: 'Coffee Chat', slug: 'coffee-chat' });

    const request = new Request('https://calendo.dev/api/public/team/acme-corp', { method: 'GET' });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.org.name).toBe('Acme Corp');
    expect(data.org.slug).toBe('acme-corp');
    expect(data.members).toHaveLength(2);

    // First member (Alice) should have the org event type
    const alice = data.members.find(m => m.name === 'Alice');
    expect(alice).toBeDefined();
    expect(alice.booking_slug).toBe('alice');
    expect(alice.event_types.length).toBeGreaterThanOrEqual(1);
    expect(alice.event_types.some(et => et.name === '30 Min Call')).toBe(true);

    // Second member (Bob) should have the personal event type
    const bob = data.members.find(m => m.name === 'Bob');
    expect(bob).toBeDefined();
    expect(bob.booking_slug).toBe('bob');
    expect(bob.event_types.some(et => et.name === 'Coffee Chat')).toBe(true);
  });

  it('should return 404 for non-existent org', async () => {
    const request = new Request('https://calendo.dev/api/public/team/nonexistent', { method: 'GET' });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Team not found');
  });

  it('should exclude secret events from team page', async () => {
    const userId = addTestUser(db, { name: 'Carol' });
    const org = addOrg(db, { name: 'Secret Corp', slug: 'secret-corp', owner_id: userId });
    addOrgMember(db, org.id, userId, 'owner');
    addBookingPage(db, userId, 'carol', 'Carol');
    addEventType(db, { user_id: userId, org_id: org.id, name: 'Public Event', slug: 'public-event', is_secret: 0 });
    addEventType(db, { user_id: userId, org_id: org.id, name: 'Secret Event', slug: 'secret-event', is_secret: 1 });

    const request = new Request('https://calendo.dev/api/public/team/secret-corp', { method: 'GET' });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    const carol = data.members[0];
    expect(carol.event_types.some(et => et.name === 'Public Event')).toBe(true);
    expect(carol.event_types.some(et => et.name === 'Secret Event')).toBe(false);
  });

  it('should exclude inactive events from team page', async () => {
    const userId = addTestUser(db, { name: 'Dave' });
    const org = addOrg(db, { name: 'Inactive Corp', slug: 'inactive-corp', owner_id: userId });
    addOrgMember(db, org.id, userId, 'owner');
    addBookingPage(db, userId, 'dave', 'Dave');
    addEventType(db, { user_id: userId, org_id: org.id, name: 'Active Event', slug: 'active-event', is_active: 1 });
    addEventType(db, { user_id: userId, org_id: org.id, name: 'Inactive Event', slug: 'inactive-event', is_active: 0 });

    const request = new Request('https://calendo.dev/api/public/team/inactive-corp', { method: 'GET' });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    const dave = data.members[0];
    expect(dave.event_types.some(et => et.name === 'Active Event')).toBe(true);
    expect(dave.event_types.some(et => et.name === 'Inactive Event')).toBe(false);
  });

  it('should include org logo_url in response', async () => {
    const userId = addTestUser(db);
    const org = addOrg(db, { name: 'Logo Corp', slug: 'logo-corp', owner_id: userId, logo_url: 'https://example.com/logo.png' });
    addOrgMember(db, org.id, userId, 'owner');

    const request = new Request('https://calendo.dev/api/public/team/logo-corp', { method: 'GET' });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.org.logo_url).toBe('https://example.com/logo.png');
  });
});


// ============================================================
// Tests: Audit Log
// ============================================================

describe('Audit Log API', () => {
  let worker;
  let db;
  let userId;
  let sessionToken;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
    db = createMockDB();
    userId = addTestUser(db, { name: 'Test User', email: 'test@test.com' });
    sessionToken = addSession(db, userId);

    // Seed audit log entries
    db._tables.audit_log.push(
      { id: 1, user_id: userId, action: 'user.login', entity_type: 'user', entity_id: userId, details: '{}', ip_address: '1.2.3.4', created_at: '2026-04-01T10:00:00Z' },
      { id: 2, user_id: userId, action: 'event_type.created', entity_type: 'event_type', entity_id: 1, details: '{"name":"Test"}', ip_address: '1.2.3.4', created_at: '2026-04-01T11:00:00Z' },
      { id: 3, user_id: userId, action: 'booking.created', entity_type: 'booking', entity_id: 1, details: '{"invitee_email":"guest@test.com"}', ip_address: '1.2.3.4', created_at: '2026-04-01T12:00:00Z' },
      { id: 4, user_id: userId, action: 'settings.updated', entity_type: 'booking_page', entity_id: 1, details: '{"updated_fields":["bio"]}', ip_address: '1.2.3.4', created_at: '2026-04-01T13:00:00Z' },
      { id: 5, user_id: userId, action: 'user.login', entity_type: 'user', entity_id: userId, details: '{}', ip_address: '5.6.7.8', created_at: '2026-04-02T10:00:00Z' },
    );
  });

  it('should return audit log entries for authenticated user', async () => {
    const request = new Request('https://calendo.dev/api/audit-log?page=1&limit=10', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
    });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.pagination).toBeDefined();
    expect(data.pagination.page).toBe(1);
    expect(data.pagination.total).toBe(5);
  });

  it('should filter audit log by action', async () => {
    const request = new Request('https://calendo.dev/api/audit-log?action=user.login', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
    });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.length).toBe(2);
    expect(data.data.every(e => e.action === 'user.login')).toBe(true);
  });

  it('should paginate audit log correctly', async () => {
    const request = new Request('https://calendo.dev/api/audit-log?page=1&limit=2', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
    });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.length).toBe(2);
    expect(data.pagination.page).toBe(1);
    expect(data.pagination.limit).toBe(2);
    expect(data.pagination.total).toBe(5);

    // Get page 2
    const request2 = new Request('https://calendo.dev/api/audit-log?page=2&limit=2', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
    });
    const response2 = await worker.default.fetch(request2, env, {});
    const data2 = await response2.json();
    expect(data2.data.length).toBe(2);
    expect(data2.pagination.page).toBe(2);
  });

  it('should return 401 for unauthenticated audit log request', async () => {
    const request = new Request('https://calendo.dev/api/audit-log', {
      method: 'GET',
    });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });

  it('should only return entries for the authenticated user', async () => {
    // Add another user's audit log entries
    const otherUserId = addTestUser(db, { name: 'Other User', email: 'other@test.com' });
    db._tables.audit_log.push(
      { id: 10, user_id: otherUserId, action: 'user.login', entity_type: 'user', entity_id: otherUserId, details: '{}', ip_address: '9.9.9.9', created_at: '2026-04-03T10:00:00Z' },
    );

    const request = new Request('https://calendo.dev/api/audit-log?page=1&limit=100', {
      method: 'GET',
      headers: { Cookie: `session=${sessionToken}` },
    });
    const env = { DB: db, ASSETS: { fetch: () => new Response('') } };
    const response = await worker.default.fetch(request, env, {});

    expect(response.status).toBe(200);
    const data = await response.json();
    // Should only see own entries (5), not the other user's entry
    expect(data.pagination.total).toBe(5);
    expect(data.data.every(e => e.user_id === userId)).toBe(true);
  });
});
