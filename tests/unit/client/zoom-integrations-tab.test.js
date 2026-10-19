import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Now that the Zoom app is published, Zoom is a first-class integration in
// Settings → Integrations (next to Slack/PayPal), not only under Calendar settings.
const html = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

// Extract the Settings → Integrations panel.
function integrationsPanel() {
  const start = html.indexOf('id="settingsTabIntegrations"');
  expect(start).toBeGreaterThan(-1);
  // Grab a generous slice; the Zoom card is the first card in the panel.
  return html.slice(start, start + 4000);
}

describe('Zoom in Settings → Integrations', () => {
  it('the Integrations tab has a Zoom card with a connect/status container', () => {
    const panel = integrationsPanel();
    expect(panel).toMatch(/id="zoomIntegrationSection"/);
    expect(panel).toMatch(/id="zoomIntegrationStatus"/);
    expect(panel).toMatch(/>Zoom</);
  });

  it('renderZoomConnectSection renders into BOTH the calendar-settings and integrations placements', () => {
    const start = html.indexOf('async function renderZoomConnectSection');
    const body = html.slice(start, start + 1600);
    expect(body).toMatch(/zoomConnectSection/);
    expect(body).toMatch(/zoomIntegrationSection/);
    expect(body).toMatch(/zoomIntegrationStatus/);
    // Still gated on server config + offers connect/disconnect.
    expect(body).toMatch(/\/api\/zoom\/status/);
    expect(body).toMatch(/\/api\/zoom\/connect/);
    expect(body).toMatch(/disconnectZoom\(\)/);
  });

  it('opening the Integrations settings tab renders the Zoom card', () => {
    const start = html.indexOf('function switchSettingsTab');
    const body = html.slice(start, start + 1200);
    expect(body).toMatch(/tabName === 'integrations'[\s\S]{0,40}renderZoomConnectSection\(\)/);
  });
});
