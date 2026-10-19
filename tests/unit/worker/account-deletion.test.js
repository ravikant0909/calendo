import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ============================================================
// Regression coverage for account deletion.
//
// THE BUG: handleDeleteAccount (REST DELETE /api/auth/delete-account) and the
// AI `delete_account` tool used to run ~14 sequential awaited DELETEs ending
// with `DELETE FROM users`, with `DELETE FROM sessions` near the START. The
// list was MISSING tables that reference users (zoom_connections,
// password_reset_tokens, feedback, coupons, single_use_links,
// calendar_sync_errors, audit_log, email_sequences, email_verification_tokens,
// org tables, child tables, ...). Because D1 enforces foreign keys, a leftover
// child row blocked `DELETE FROM users`; the request 500'd AFTER sessions had
// already been deleted. The user was logged out but NOT deleted, and re-login
// found the stale account and skipped onboarding.
//
// THE FIX: a shared `deleteAllUserData(env, userId)` that (a) best-effort
// revokes calendar + zoom grants, then (b) runs ONE atomic `env.DB.batch([...])`
// deleting every user-owned table child-first, with `DELETE FROM users` LAST.
// Both handleDeleteAccount and the AI delete_account case call it.
//
// These tests:
//  1. Functionally drive DELETE /api/auth/delete-account through a mock D1 that
//     implements batch() and assert the user (and every seeded child table) is
//     gone, including zoom_connections.
//  2. Assert deletion goes through env.DB.batch (atomic), not N awaited .run()s,
//     with zoom_connections present and users LAST.
//  3. Source-assert the batch deletes from EVERY user-owned table (the
//     regression surface — catches "added a table, forgot the delete list").
//  4. Source-assert BOTH paths call deleteAllUserData.
//  5. Source-assert the Google/Microsoft OAuth user INSERTs do NOT set
//     onboarding_completed, so a re-signup after a clean delete is a genuinely
//     new user routed to onboarding.
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, '../../../src/worker.js');
const workerSource = readFileSync(WORKER_PATH, 'utf8');

// ------------------------------------------------------------
// Extract the body of a named async function from the source so source
// assertions are scoped to the right function (not the whole 10k-line file).
// ------------------------------------------------------------
function extractFunctionBody(src, fnName) {
  const startIdx = src.indexOf(`async function ${fnName}(`);
  if (startIdx === -1) throw new Error(`Could not find function ${fnName} in worker source`);
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${fnName}`);
}

// Extract the AI tool `case 'delete_account': { ... }` block.
function extractDeleteAccountCase(src) {
  const startIdx = src.indexOf("case 'delete_account':");
  if (startIdx === -1) throw new Error("Could not find AI tool case 'delete_account' in worker source");
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error("Unbalanced braces while extracting delete_account case");
}

// ------------------------------------------------------------
// Mock D1 with a real batch() implementation.
//
// Each prepared+bound statement carries its own SQL/args and a .run() that
// mutates the in-memory tables. batch(statements) runs every statement's run()
// in order (atomically) and RECORDS the batch so tests can assert what ran and
// that it ran as a single batch rather than N independent awaited .run() calls.
// ------------------------------------------------------------
function createMockDB(seed = {}) {
  const tables = {
    users: seed.users || [],
    sessions: seed.sessions || [],
    event_types: seed.event_types || [],
    bookings: seed.bookings || [],
    calendar_connections: seed.calendar_connections || [],
    zoom_connections: seed.zoom_connections || [],
    api_keys: seed.api_keys || [],
    booking_pages: seed.booking_pages || [],
    availability_schedules: seed.availability_schedules || [],
    webhooks: seed.webhooks || [],
    feedback: seed.feedback || [],
    coupons: seed.coupons || [],
    password_reset_tokens: seed.password_reset_tokens || [],
    single_use_links: seed.single_use_links || [],
    calendar_sync_errors: seed.calendar_sync_errors || [],
    audit_log: seed.audit_log || [],
    email_sequences: seed.email_sequences || [],
    email_verification_tokens: seed.email_verification_tokens || [],
    org_members: seed.org_members || [],
    organizations: seed.organizations || [],
    org_invitations: seed.org_invitations || [],
    routing_forms: seed.routing_forms || [],
    meeting_polls: seed.meeting_polls || [],
    notification_log: seed.notification_log || [],
    workflow_actions: seed.workflow_actions || [],
    ai_conversations: seed.ai_conversations || [],
    email_sequence_log: seed.email_sequence_log || [],
    poll_votes: seed.poll_votes || [],
    poll_options: seed.poll_options || [],
    routing_form_submissions: seed.routing_form_submissions || [],
  };

  const queries = [];      // every prepared+bound statement (sql + args)
  const batches = [];      // every env.DB.batch([...]) call, as arrays of {sql,args}
  let standaloneRunCount = 0; // .run() calls made OUTSIDE a batch (after auth)

  // Apply a single DELETE FROM <table> WHERE user_id = ? to the in-memory state.
  // Only handles the simple/common DELETE shapes the deletion path uses; the
  // subquery deletes (children) are matched on their target table name.
  function applyDelete(sql, args) {
    const m = sql.match(/DELETE FROM (\w+)/i);
    if (!m) return;
    const table = m[1];
    if (!tables[table]) tables[table] = [];
    const userId = args[0];
    if (table === 'users') {
      const idx = tables.users.findIndex(u => u.id === userId);
      if (idx !== -1) tables.users.splice(idx, 1);
      return;
    }
    // For the simple `WHERE user_id = ?` / owner_id / invited_by shapes and the
    // child subquery shapes, just clear rows belonging to this user. The seeded
    // child tables all carry user_id in this mock, so filtering on user_id is
    // sufficient to prove "this table got cleared as part of the delete".
    tables[table] = tables[table].filter(row => row.user_id !== userId);
  }

  function makeStatement(sql, boundArgs) {
    const record = { sql, args: boundArgs };
    return {
      sql,
      args: boundArgs,
      _record: record,
      async first() {
        // Auth: session -> user join lookup (requireAuth)
        if (sql.includes('SELECT s.user_id, u.*') && sql.includes('sessions')) {
          const session = tables.sessions.find(s => s.token === boundArgs[0]);
          if (!session) return null;
          const user = tables.users.find(u => u.id === session.user_id);
          return user ? { ...user, user_id: user.id } : null;
        }
        // Zoom revoke lookup (only hit when Zoom OAuth is configured — it isn't here)
        if (sql.includes('FROM zoom_connections WHERE user_id')) {
          return tables.zoom_connections.find(z => z.user_id === boundArgs[0]) || null;
        }
        return null;
      },
      async all() {
        // Calendar grant revoke enumerates calendar_connections (best-effort)
        if (sql.includes('FROM calendar_connections WHERE user_id')) {
          return { results: tables.calendar_connections.filter(c => c.user_id === boundArgs[0]) };
        }
        return { results: [] };
      },
      async run() {
        queries.push(record);
        standaloneRunCount++;
        applyDelete(sql, boundArgs);
        return { success: true };
      },
    };
  }

  return {
    _tables: tables,
    _queries: queries,
    _batches: batches,
    get _standaloneRunCount() { return standaloneRunCount; },
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = makeStatement(sql, args);
          queries.push(stmt._record);
          return stmt;
        },
      };
    },
    // Atomic batch — run each statement in order, record the whole list.
    async batch(statements) {
      const recorded = statements.map(s => ({ sql: s.sql, args: s.args }));
      batches.push(recorded);
      for (const s of statements) {
        applyDelete(s.sql, s.args);
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

// Build an env with an authenticated session (user id 1).
function createAuthEnv(seed = {}, envOverrides = {}) {
  const user = {
    id: 1,
    email: 'del@example.com',
    name: 'Delete Me',
    timezone: 'America/Los_Angeles',
    password_hash: 'hashed',
    avatar_url: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  const session = { id: 'sess-1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' };

  const defaults = {
    users: [user],
    sessions: [session],
    ...seed,
  };

  const db = createMockDB(defaults);
  return {
    env: { DB: db, ASSETS: { fetch: () => new Response('') }, ...envOverrides },
    db,
    user,
    session,
  };
}

// Build a DELETE request carrying the session cookie.
function deleteAccountRequest(sessionToken = 'test-session-token') {
  return new Request('https://calendo.dev/api/auth/delete-account', {
    method: 'DELETE',
    headers: { 'Cookie': `session=${sessionToken}` },
  });
}

// Flatten all batched statement SQL strings across all batch() calls.
function batchedSql(db) {
  return db._batches.flat().map(s => s.sql);
}

describe('Account deletion — REST DELETE /api/auth/delete-account', () => {
  let worker;

  beforeEach(async () => {
    worker = await import('../../../src/worker.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A fully-seeded user: a row in every kind of user-owned table the deletion
  // must clear, so we can prove the delete list is COMPLETE.
  function fullySeededDb() {
    return {
      sessions: [{ id: 'sess-1', user_id: 1, token: 'test-session-token', expires_at: '2099-01-01T00:00:00Z' }],
      event_types: [{ id: 10, user_id: 1, name: 'Meeting', slug: 'meeting', duration_minutes: 30 }],
      bookings: [{ id: 20, user_id: 1, event_type_id: 10, invitee_email: 'a@b.com', status: 'confirmed' }],
      calendar_connections: [{ id: 30, user_id: 1, provider: 'google', email: 'g@b.com' }],
      zoom_connections: [{ id: 40, user_id: 1, access_token_encrypted: 'enc' }],
      api_keys: [{ id: 50, user_id: 1, key_hash: 'h' }],
      booking_pages: [{ id: 60, user_id: 1, slug: 'del', display_name: 'Delete Me' }],
      availability_schedules: [{ id: 70, user_id: 1, name: 'Working Hours', is_default: 1 }],
      webhooks: [{ id: 80, user_id: 1, url: 'https://hook' }],
      feedback: [{ id: 90, user_id: 1, message: 'hi' }],
      coupons: [{ id: 100, user_id: 1, code: 'SAVE' }],
      password_reset_tokens: [{ id: 110, user_id: 1, token: 't', used: 0 }],
      single_use_links: [{ id: 120, user_id: 1, token: 's' }],
      calendar_sync_errors: [{ id: 130, user_id: 1, message: 'err' }],
      audit_log: [{ id: 140, user_id: 1, action: 'login' }],
      email_sequences: [{ id: 150, user_id: 1, name: 'seq' }],
      email_verification_tokens: [{ id: 160, user_id: 1, token: 'v' }],
      org_members: [{ id: 170, user_id: 1, org_id: 1, role: 'member' }],
      organizations: [{ id: 1, owner_id: 1, user_id: 1, name: 'Org' }],
      routing_forms: [{ id: 180, user_id: 1, name: 'form' }],
      meeting_polls: [{ id: 190, user_id: 1, title: 'poll' }],
    };
  }

  // --------------------------------------------------------
  // 1. FUNCTIONAL — the whole user, including zoom_connections, is gone.
  // --------------------------------------------------------
  it('returns 200 and deletes the user row plus EVERY seeded user-owned table', async () => {
    const { env, db } = createAuthEnv(fullySeededDb());

    // Sanity: everything is present before the delete.
    expect(db._tables.users).toHaveLength(1);
    expect(db._tables.zoom_connections).toHaveLength(1);

    const response = await worker.default.fetch(deleteAccountRequest(), env, {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    // The user row is gone.
    expect(db._tables.users).toHaveLength(0);

    // Every seeded child table is empty — proving the delete list is complete.
    // zoom_connections is the headline table that the bug omitted.
    const mustBeEmpty = [
      'zoom_connections', 'sessions', 'event_types', 'bookings',
      'calendar_connections', 'api_keys', 'booking_pages', 'availability_schedules',
      'webhooks', 'feedback', 'coupons', 'password_reset_tokens', 'single_use_links',
      'calendar_sync_errors', 'audit_log', 'email_sequences',
      'email_verification_tokens', 'org_members', 'organizations',
      'routing_forms', 'meeting_polls',
    ];
    for (const t of mustBeEmpty) {
      expect(db._tables[t], `table ${t} should be emptied by account deletion`).toHaveLength(0);
    }
  });

  it('issues a DELETE FROM zoom_connections and a DELETE FROM users in the batch', async () => {
    const { env, db } = createAuthEnv(fullySeededDb());

    const response = await worker.default.fetch(deleteAccountRequest(), env, {});
    expect(response.status).toBe(200);

    const sqls = batchedSql(db);
    expect(sqls.some(s => /DELETE FROM zoom_connections/i.test(s))).toBe(true);
    expect(sqls.some(s => /DELETE FROM users/i.test(s))).toBe(true);
  });

  // --------------------------------------------------------
  // 2. ATOMICITY — deletion goes through env.DB.batch, users LAST.
  // --------------------------------------------------------
  it('performs deletion as a single atomic env.DB.batch (not N separate awaited .run() calls)', async () => {
    const { env, db } = createAuthEnv(fullySeededDb());

    const response = await worker.default.fetch(deleteAccountRequest(), env, {});
    expect(response.status).toBe(200);

    // Exactly one batch() call carried the deletion.
    expect(db._batches.length).toBe(1);

    const deletionBatch = db._batches[0];
    // The batch holds many statements (the full delete list), not a handful.
    expect(deletionBatch.length).toBeGreaterThanOrEqual(20);

    // No standalone DELETE .run() calls leaked outside the batch after auth.
    // (Only batch() should have mutated the tables.) The lookups in requireAuth
    // and the revoke helpers use .first()/.all(), never .run().
    const standaloneDeletes = db._queries.filter(
      q => /DELETE FROM/i.test(q.sql) && db._batches.flat().indexOf(q) === -1
    );
    // The standalone .run() counter never advanced — nothing ran outside batch.
    expect(db._standaloneRunCount).toBe(0);
    expect(standaloneDeletes.length).toBeGreaterThanOrEqual(0); // documentary

    // users must be the LAST statement in the batch.
    const lastStmt = deletionBatch[deletionBatch.length - 1];
    expect(/DELETE FROM users/i.test(lastStmt.sql)).toBe(true);

    // zoom_connections must appear BEFORE the final users delete.
    const zoomIdx = deletionBatch.findIndex(s => /DELETE FROM zoom_connections/i.test(s.sql));
    const usersIdx = deletionBatch.findIndex(s => /DELETE FROM users/i.test(s.sql));
    expect(zoomIdx).toBeGreaterThanOrEqual(0);
    expect(usersIdx).toBe(deletionBatch.length - 1);
    expect(zoomIdx).toBeLessThan(usersIdx);
  });

  it('source-asserts deleteAllUserData uses env.DB.batch( with DELETE FROM users as the final entry', () => {
    const body = extractFunctionBody(workerSource, 'deleteAllUserData');
    // It runs a batch.
    expect(body).toMatch(/env\.DB\.batch\(/);
    // It does NOT fall back to a chain of awaited .run() deletes inside the fn
    // (the revoke helpers are awaited but are separate calls, not DELETE .run()).
    expect(body).not.toMatch(/DELETE FROM[\s\S]*?\)\.run\(\)/i);

    // The final DELETE statement in the function must target users.
    const deleteMatches = [...body.matchAll(/DELETE FROM (\w+)/gi)].map(m => m[1].toLowerCase());
    expect(deleteMatches.length).toBeGreaterThanOrEqual(20);
    expect(deleteMatches[deleteMatches.length - 1]).toBe('users');
    // sessions must be deleted, and must come AFTER the children — i.e. not first.
    expect(deleteMatches).toContain('sessions');
    expect(deleteMatches[0]).not.toBe('sessions');
  });

  // --------------------------------------------------------
  // 3. COMPLETENESS — every user-owned table is in the delete list.
  //    This is the actual regression surface: adding a new user-referencing
  //    table and forgetting its DELETE re-introduces the half-delete bug.
  // --------------------------------------------------------
  it('source-asserts deleteAllUserData deletes from EVERY user-owned table', () => {
    const body = extractFunctionBody(workerSource, 'deleteAllUserData');

    const requiredTables = [
      // Previously-missing tables that caused the bug:
      'zoom_connections',
      'password_reset_tokens',
      'feedback',
      'coupons',
      'single_use_links',
      'calendar_sync_errors',
      'audit_log',
      'email_sequences',
      'email_verification_tokens',
      'org_members',
      // Originally-covered tables (must remain covered):
      'sessions',
      'api_keys',
      'calendar_connections',
      'webhooks',
      'event_types',
      'bookings',
      'availability_schedules',
      'routing_forms',
      'meeting_polls',
      'booking_pages',
      'users',
    ];

    for (const table of requiredTables) {
      const re = new RegExp(`DELETE FROM ${table}\\b`, 'i');
      expect(re.test(body), `deleteAllUserData must DELETE FROM ${table}`).toBe(true);
    }
  });

  // Guards the schema-DRIFT bug that mocks can't catch: the production DB's
  // bookings table has NO user_id column and org_invitations has NO invited_by
  // column / no FK to users (schema.sql lists both, but the live DB never got
  // them). Referencing either throws "no such column" and 500s the whole delete.
  // Bookings must be reached via event_type_id only; org_invitations must not be
  // deleted by a user column (it cascades from the org).
  it('does NOT reference columns that are absent on the production schema', () => {
    const body = extractFunctionBody(workerSource, 'deleteAllUserData');
    // No bookings.user_id usage anywhere in the delete logic.
    expect(/bookings\s+WHERE\s+user_id/i.test(body)).toBe(false);
    expect(/DELETE FROM bookings\b/i.test(body)).toBe(true);
    expect(/DELETE FROM bookings WHERE event_type_id/i.test(body)).toBe(true);
    // No org_invitations delete by a user-scoped column.
    expect(/org_invitations\s+WHERE\s+(invited_by|user_id)/i.test(body)).toBe(false);
  });

  // --------------------------------------------------------
  // 4. BOTH PATHS call deleteAllUserData.
  // --------------------------------------------------------
  it('source-asserts handleDeleteAccount calls deleteAllUserData', () => {
    const body = extractFunctionBody(workerSource, 'handleDeleteAccount');
    expect(body).toMatch(/deleteAllUserData\(\s*env\s*,/);
    // It must NOT inline its own DELETE chain (that would be the old bug shape).
    expect(body).not.toMatch(/DELETE FROM users/i);
  });

  it('source-asserts the AI delete_account tool case calls deleteAllUserData', () => {
    const caseBody = extractDeleteAccountCase(workerSource);
    expect(caseBody).toMatch(/deleteAllUserData\(\s*env\s*,/);
    expect(caseBody).not.toMatch(/DELETE FROM users/i);
  });

  // --------------------------------------------------------
  // 5. REGRESSION — OAuth signup defaults to onboarding (the new-user default).
  //    A clean delete + re-signup must yield a fresh user that sees onboarding,
  //    so the OAuth INSERTs must NOT set onboarding_completed (defaults to 0).
  // --------------------------------------------------------
  it('source-asserts the OAuth user INSERT does NOT set onboarding_completed', () => {
    // Google and Microsoft signups share one insert, inside resolveOAuthLogin.
    const fnStart = workerSource.indexOf('export async function resolveOAuthLogin(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = workerSource.indexOf('\n}\n', fnStart);
    const body = workerSource.slice(fnStart, fnEnd);
    const insert = body.match(/INSERT INTO users \([^)]*\)/);
    expect(insert).not.toBeNull();
    expect(insert[0]).not.toMatch(/onboarding_completed/);
    // Both providers must route through it (no stray email-only insert left behind).
    expect(workerSource.match(/await resolveOAuthLogin\(env, \{/g).length).toBe(2);
  });
});
