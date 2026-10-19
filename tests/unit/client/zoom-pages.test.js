import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards the two reviewer-critical pages required for the Zoom Marketplace listing:
//   1. The Direct Landing page (/integrations/zoom): logged-in users see a Connect
//      Zoom page; logged-out users are sent to login and back.
//   2. The user documentation (/docs/zoom-integration): must cover Adding, Usage,
//      and Removing (incl. de-authorization + data deletion) — Zoom rejects apps
//      whose docs omit these. These assertions fail if a required section is dropped.

const landing = readFileSync(join(process.cwd(), 'public/integrations/zoom/index.html'), 'utf8');
const docs = readFileSync(join(process.cwd(), 'public/docs/zoom-integration.html'), 'utf8');

describe('Zoom Direct Landing page (/integrations/zoom)', () => {
  it('checks auth via /api/auth/me', () => {
    expect(landing).toMatch(/fetch\(\s*['"]\/api\/auth\/me['"]/);
  });
  it('redirects logged-out users to the login page with a redirect back here', () => {
    expect(landing).toMatch(/\/auth\/login\?redirect=/);
    expect(landing).toMatch(/window\.location\.replace/);
  });
  it('offers a Connect Zoom action that starts the OAuth flow', () => {
    expect(landing).toMatch(/href=["']\/api\/zoom\/connect["']/);
  });
  it('reflects connection state via /api/zoom/status and allows disconnect', () => {
    expect(landing).toMatch(/\/api\/zoom\/status/);
    expect(landing).toMatch(/\/api\/zoom\/disconnect/);
  });
  it('links to the user documentation', () => {
    expect(landing).toMatch(/\/docs\/zoom-integration/);
  });
  it('is mobile-friendly (viewport + media query)', () => {
    expect(landing).toMatch(/name=["']viewport["']/);
    expect(landing).toMatch(/@media\s*\(max-width:\s*768px\)/);
  });
});

describe('Zoom user documentation (/docs/zoom-integration)', () => {
  it('has an "Adding the app" section', () => {
    expect(docs).toMatch(/id=["']adding["']/i);
    expect(docs).toMatch(/Adding the app/i);
  });
  it('has a "Usage" section', () => {
    expect(docs).toMatch(/id=["']usage["']/i);
    expect(docs).toMatch(/Using the app/i);
  });
  it('has a "Removing the app" section with de-authorization + data deletion details', () => {
    expect(docs).toMatch(/id=["']removing["']/i);
    expect(docs).toMatch(/de-?authoriz/i);
    expect(docs).toMatch(/delet(e|es|ion)[^<]{0,80}(data|token)/i);
  });
  it('has a troubleshooting section', () => {
    expect(docs).toMatch(/id=["']troubleshooting["']/i);
  });
  it('uses a corporate (calendo.dev) support contact, not a personal gmail', () => {
    expect(docs).toMatch(/support@calendo\.dev/);
    expect(docs).not.toMatch(/@gmail\.com/);
  });
  it('is mobile-friendly (viewport + media query)', () => {
    expect(docs).toMatch(/name=["']viewport["']/);
    expect(docs).toMatch(/@media\s*\(max-width:\s*768px\)/);
  });
});
