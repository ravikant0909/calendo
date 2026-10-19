import { describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The dashboard JS is inline in the HTML, so we replicate the pure/rendering
// functions here for unit testing.  This keeps tests fast and avoids brittle
// eval-based extraction.
// ---------------------------------------------------------------------------

// ── escapeHtml (mirrors the dashboard implementation) ──────────────────────
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── renderOverviewEventTypes (mirrors the new compact-list implementation) ─
function renderOverviewEventTypes(eventTypes, containerId = 'overviewEventTypes', editingId = '') {
  const container = document.getElementById(containerId);
  if (eventTypes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4v16m8-8H4"/></svg>
        <p>You haven't created any meeting types yet.</p>
        <button class="btn btn-primary" onclick="openCreateModal()">Create your first meeting type</button>
      </div>`;
    return;
  }

  const locationLabels = {'google_meet':'Google Meet','zoom':'Zoom','teams':'Teams','phone':'Phone','in_person':'In person','custom':'Custom','none':'—'};

  let html = '<ul class="overview-mt-list">';
  html += eventTypes.map(et => {
    const locLabel = locationLabels[et.location_type] || '';
    const inactiveClass = !et.is_active ? ' overview-mt-inactive' : '';
    const editingClass = editingId && String(editingId) === String(et.id) ? ' is-editing' : '';

    return `<li class="overview-mt-item${inactiveClass}${editingClass}">
      <div class="overview-mt-dot" style="background:${et.color || '#2563eb'}"></div>
      <div class="overview-mt-item-info">
        <span class="overview-mt-item-name">${escapeHtml(et.name)}</span>
        <span class="overview-mt-item-dur">${et.duration_minutes}m${locLabel ? ' · ' + locLabel : ''}${et.price_cents ? ' · $' + (et.price_cents/100).toFixed(2) : ''}</span>
      </div>
      <div class="overview-mt-item-actions">
        <button class="overview-mt-mini-btn" onclick="copyEventLink(${et.id})" title="Copy link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        <button class="overview-mt-mini-btn" onclick="openEditModal(${et.id})" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <label class="toggle-switch" title="Toggle active" style="cursor:pointer">
          <input type="checkbox" ${et.is_active ? 'checked' : ''} onchange="toggleEventActive(${et.id}, this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </li>`;
  }).join('');
  html += '</ul>';
  container.innerHTML = html;
}

// ── updatePanelSummaries (mirrors the dashboard implementation) ───────────
function updatePanelSummaries() {
  const name = document.getElementById('editEtName').value || 'Untitled';
  const dur = document.getElementById('editEtDuration').value || '30';
  document.getElementById('epSummaryNameDuration').textContent = `${name} · ${dur} min`;

  const colorNames = {'#2563eb':'Blue','#16a34a':'Green','#dc2626':'Red','#f59e0b':'Amber','#7c3aed':'Purple','#ec4899':'Pink','#0d9488':'Teal','#ea580c':'Orange','#6366f1':'Indigo','#64748b':'Slate'};
  const color = document.getElementById('editEtColor').value || '#2563eb';
  document.getElementById('epSummaryColor').textContent = colorNames[color] || color;

  const desc = document.getElementById('editEtDesc').value;
  document.getElementById('epSummaryDesc').textContent = desc ? desc.slice(0, 60) + (desc.length > 60 ? '…' : '') : 'No description';

  const locationLabels = {'google_meet':'Google Meet','zoom':'Zoom','teams':'Teams','phone':'Phone','in_person':'In person','custom':'Custom','none':'No location'};
  const loc = document.getElementById('editEtLocation').value || 'google_meet';
  document.getElementById('epSummaryLocation').textContent = locationLabels[loc] || loc;

  const schedEl = document.getElementById('editEtSchedule');
  const schedText = schedEl.options[schedEl.selectedIndex]?.text || 'Default';
  document.getElementById('epSummaryAvailability').textContent = schedText;

  const bb = document.getElementById('editEtBufferBefore').value || '0';
  const ba = document.getElementById('editEtBufferAfter').value || '0';
  const notice = document.getElementById('editEtMinNotice').value || '4';
  const maxDay = document.getElementById('editEtMaxPerDay').value;
  let limitsText = `${notice}h notice`;
  if (parseInt(bb) > 0 || parseInt(ba) > 0) limitsText += ` · ±${bb}/${ba}m buffer`;
  if (maxDay) limitsText += ` · max ${maxDay}/day`;
  document.getElementById('epSummaryLimits').textContent = limitsText;

  const rrMode = document.getElementById('editEtRoundRobin')?.value;
  document.getElementById('epSummaryTeam').textContent = rrMode ? (rrMode === 'round_robin' ? 'Round Robin' : rrMode) : 'One-on-One';
}

// ── closeEditPanel (mirrors the dashboard implementation) ─────────────────
function closeEditPanel() {
  document.getElementById('editEtPanel').classList.remove('active');
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
function makeEventType(overrides = {}) {
  return {
    id: 1,
    name: 'Quick Chat',
    slug: 'quick-chat',
    duration_minutes: 30,
    description: 'A short introductory call.',
    color: '#2563eb',
    is_active: 1,
    location_type: 'google_meet',
    price_cents: null,
    group_max_attendees: null,
    ...overrides,
  };
}

function setupPanelDOM() {
  const panelHTML = `
    <aside class="edit-panel" id="editEtPanel">
      <input type="hidden" id="editEtId">
      <input type="text" id="editEtName" value="">
      <select id="editEtDuration"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="60">60 min</option></select>
      <textarea id="editEtDesc"></textarea>
      <input type="hidden" id="editEtColor" value="#2563eb">
      <select id="editEtLocation"><option value="google_meet" selected>Google Meet</option><option value="zoom">Zoom</option><option value="phone">Phone</option><option value="none">No location</option></select>
      <select id="editEtSchedule"><option value="1" selected>Working Hours (default)</option><option value="2">Evening</option></select>
      <input type="number" id="editEtBufferBefore" value="0">
      <input type="number" id="editEtBufferAfter" value="0">
      <input type="number" id="editEtMinNotice" value="4">
      <input type="text" id="editEtMaxPerDay" value="">
      <select id="editEtRoundRobin"><option value="" selected></option><option value="round_robin">Round Robin</option></select>
      <div id="epSummaryNameDuration"></div>
      <div id="epSummaryDesc"></div>
      <div id="epSummaryColor"></div>
      <div id="epSummaryLocation"></div>
      <div id="epSummaryAvailability"></div>
      <div id="epSummaryLimits"></div>
      <div id="epSummaryTeam"></div>
      <div id="epTitle"></div>
      <div id="epColorDot"></div>
      <div id="epSubtitle"></div>
      <button id="editEtSaveBtn">Save</button>
      <button id="editEtDeleteBtn">Delete</button>
    </aside>`;
  document.body.insertAdjacentHTML('beforeend', panelHTML);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Dashboard client-side rendering', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="overviewEventTypes"></div>';
  });

  // ========================================================================
  // escapeHtml
  // ========================================================================
  describe('escapeHtml', () => {
    it('returns empty string for falsy input', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml(0)).toBe('');
    });

    it('passes through safe strings unchanged', () => {
      expect(escapeHtml('hello world')).toBe('hello world');
      expect(escapeHtml('Meeting 123')).toBe('Meeting 123');
    });

    it('escapes angle brackets to prevent script injection', () => {
      const result = escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes ampersands', () => {
      expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    it('handles double quotes safely', () => {
      const input = 'He said "hello"';
      const result = escapeHtml(input);
      const el = document.createElement('span');
      el.innerHTML = result;
      expect(el.textContent).toBe(input);
    });

    it('escapes single quotes', () => {
      const input = "it's dangerous";
      const result = escapeHtml(input);
      const check = document.createElement('span');
      check.innerHTML = result;
      expect(check.textContent).toBe(input);
    });

    it('escapes a realistic XSS payload', () => {
      const xss = '"><img src=x onerror=alert(1)>';
      const escaped = escapeHtml(xss);
      expect(escaped).not.toContain('<img');
      expect(escaped).toContain('&lt;img');
    });

    it('escapes nested HTML tags', () => {
      const html = '<div onmouseover="steal()">hover me</div>';
      const escaped = escapeHtml(html);
      expect(escaped).not.toContain('<div');
      expect(escaped).toContain('&lt;div');
    });
  });

  // ========================================================================
  // renderOverviewEventTypes — empty state
  // ========================================================================
  describe('renderOverviewEventTypes — empty state', () => {
    it('renders "no meeting types" message when array is empty', () => {
      renderOverviewEventTypes([]);

      const container = document.getElementById('overviewEventTypes');
      expect(container.querySelector('.empty-state')).not.toBeNull();
      expect(container.textContent).toContain("You haven't created any meeting types yet.");
    });

    it('renders a "Create your first meeting type" button in empty state', () => {
      renderOverviewEventTypes([]);

      const btn = document.querySelector('.empty-state .btn');
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain('Create your first meeting type');
    });

    it('empty state button calls openCreateModal', () => {
      renderOverviewEventTypes([]);

      const btn = document.querySelector('.empty-state .btn');
      expect(btn.getAttribute('onclick')).toContain('openCreateModal');
    });

    it('does not render any list items when empty', () => {
      renderOverviewEventTypes([]);

      expect(document.querySelectorAll('.overview-mt-item').length).toBe(0);
    });
  });

  // ========================================================================
  // renderOverviewEventTypes — compact list rendering
  // ========================================================================
  describe('renderOverviewEventTypes — compact list', () => {
    it('renders one list item per event type', () => {
      const types = [makeEventType({ id: 1 }), makeEventType({ id: 2, name: 'Deep Dive' })];
      renderOverviewEventTypes(types);

      expect(document.querySelectorAll('.overview-mt-item').length).toBe(2);
    });

    it('renders items inside a ul.overview-mt-list', () => {
      renderOverviewEventTypes([makeEventType()]);

      const list = document.querySelector('ul.overview-mt-list');
      expect(list).not.toBeNull();
      expect(list.querySelectorAll('.overview-mt-item').length).toBe(1);
    });

    it('displays the event type name', () => {
      renderOverviewEventTypes([makeEventType({ name: 'Strategy Session' })]);

      const name = document.querySelector('.overview-mt-item-name');
      expect(name.textContent).toBe('Strategy Session');
    });

    it('displays the duration', () => {
      renderOverviewEventTypes([makeEventType({ duration_minutes: 45 })]);

      const dur = document.querySelector('.overview-mt-item-dur');
      expect(dur.textContent).toContain('45m');
    });

    it('shows location type after duration', () => {
      renderOverviewEventTypes([makeEventType({ location_type: 'zoom' })]);

      const dur = document.querySelector('.overview-mt-item-dur');
      expect(dur.textContent).toContain('Zoom');
    });

    it('shows Google Meet as default location', () => {
      renderOverviewEventTypes([makeEventType({ location_type: 'google_meet' })]);

      const dur = document.querySelector('.overview-mt-item-dur');
      expect(dur.textContent).toContain('Google Meet');
    });

    it('shows price when set', () => {
      renderOverviewEventTypes([makeEventType({ price_cents: 2500 })]);

      const dur = document.querySelector('.overview-mt-item-dur');
      expect(dur.textContent).toContain('$25.00');
    });

    it('does not show price when null', () => {
      renderOverviewEventTypes([makeEventType({ price_cents: null })]);

      const dur = document.querySelector('.overview-mt-item-dur');
      expect(dur.textContent).not.toContain('$');
    });

    it('renders the color dot with the event type color', () => {
      renderOverviewEventTypes([makeEventType({ color: '#e11d48' })]);

      const dot = document.querySelector('.overview-mt-dot');
      expect(dot.style.background).toBe('#e11d48');
    });

    it('falls back to default blue when color is null', () => {
      renderOverviewEventTypes([makeEventType({ color: null })]);

      const dot = document.querySelector('.overview-mt-dot');
      expect(dot.style.background).toBe('#2563eb');
    });

    it('renders a copy button', () => {
      renderOverviewEventTypes([makeEventType()]);

      const btns = document.querySelectorAll('.overview-mt-mini-btn');
      const copyBtn = Array.from(btns).find(b => b.getAttribute('title') === 'Copy link');
      expect(copyBtn).not.toBeNull();
    });

    it('renders an edit button', () => {
      renderOverviewEventTypes([makeEventType()]);

      const btns = document.querySelectorAll('.overview-mt-mini-btn');
      const editBtn = Array.from(btns).find(b => b.getAttribute('title') === 'Edit');
      expect(editBtn).not.toBeNull();
    });

    it('edit button calls openEditModal with correct id', () => {
      renderOverviewEventTypes([makeEventType({ id: 42 })]);

      const editBtn = Array.from(document.querySelectorAll('.overview-mt-mini-btn'))
        .find(b => b.getAttribute('title') === 'Edit');
      expect(editBtn.getAttribute('onclick')).toBe('openEditModal(42)');
    });

    it('renders the toggle switch', () => {
      renderOverviewEventTypes([makeEventType()]);

      const toggle = document.querySelector('.toggle-switch input[type="checkbox"]');
      expect(toggle).not.toBeNull();
    });

    it('sets the toggle switch to checked when active', () => {
      renderOverviewEventTypes([makeEventType({ is_active: 1 })]);

      const toggle = document.querySelector('.toggle-switch input[type="checkbox"]');
      expect(toggle.checked).toBe(true);
    });

    it('sets the toggle switch to unchecked when inactive', () => {
      renderOverviewEventTypes([makeEventType({ is_active: 0 })]);

      const toggle = document.querySelector('.toggle-switch input[type="checkbox"]');
      expect(toggle.checked).toBe(false);
    });

    it('adds overview-mt-inactive class for inactive items', () => {
      renderOverviewEventTypes([makeEventType({ is_active: 0 })]);

      const item = document.querySelector('.overview-mt-item');
      expect(item.classList.contains('overview-mt-inactive')).toBe(true);
    });

    it('does not add overview-mt-inactive class for active items', () => {
      renderOverviewEventTypes([makeEventType({ is_active: 1 })]);

      const item = document.querySelector('.overview-mt-item');
      expect(item.classList.contains('overview-mt-inactive')).toBe(false);
    });

    it('adds is-editing class when editingId matches', () => {
      renderOverviewEventTypes([makeEventType({ id: 5 })], 'overviewEventTypes', '5');

      const item = document.querySelector('.overview-mt-item');
      expect(item.classList.contains('is-editing')).toBe(true);
    });

    it('does not add is-editing class when editingId does not match', () => {
      renderOverviewEventTypes([makeEventType({ id: 5 })], 'overviewEventTypes', '99');

      const item = document.querySelector('.overview-mt-item');
      expect(item.classList.contains('is-editing')).toBe(false);
    });
  });

  // ========================================================================
  // XSS prevention in rendered list
  // ========================================================================
  describe('XSS prevention in rendered event type list', () => {
    it('escapes malicious event type names', () => {
      const malicious = makeEventType({ name: '<img src=x onerror=alert(1)>' });
      renderOverviewEventTypes([malicious]);

      const nameEl = document.querySelector('.overview-mt-item-name');
      expect(nameEl.textContent).toBe('<img src=x onerror=alert(1)>');
      expect(nameEl.innerHTML).not.toContain('<img');
    });
  });

  // ========================================================================
  // Multiple event types rendering
  // ========================================================================
  describe('rendering multiple event types', () => {
    it('renders correct number of items', () => {
      const types = [
        makeEventType({ id: 10, name: 'Intro Call' }),
        makeEventType({ id: 20, name: 'Follow-Up' }),
        makeEventType({ id: 30, name: 'Demo' }),
      ];
      renderOverviewEventTypes(types);

      expect(document.querySelectorAll('.overview-mt-item').length).toBe(3);
    });

    it('each item has its own toggle switch', () => {
      const types = [
        makeEventType({ id: 10 }),
        makeEventType({ id: 20 }),
      ];
      renderOverviewEventTypes(types);

      const toggles = document.querySelectorAll('.toggle-switch input[type="checkbox"]');
      expect(toggles.length).toBe(2);
    });

    it('items preserve order from input array', () => {
      const types = [
        makeEventType({ id: 10, name: 'Alpha' }),
        makeEventType({ id: 20, name: 'Beta' }),
        makeEventType({ id: 30, name: 'Gamma' }),
      ];
      renderOverviewEventTypes(types);

      const names = Array.from(document.querySelectorAll('.overview-mt-item-name')).map(n => n.textContent);
      expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
    });
  });

  // ========================================================================
  // Edit panel — closeEditPanel
  // ========================================================================
  describe('closeEditPanel', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="overviewEventTypes"></div>';
      setupPanelDOM();
    });

    it('removes active class from panel', () => {
      const panel = document.getElementById('editEtPanel');
      panel.classList.add('active');

      closeEditPanel();

      expect(panel.classList.contains('active')).toBe(false);
    });

    it('does nothing if panel is already closed', () => {
      const panel = document.getElementById('editEtPanel');

      closeEditPanel();

      expect(panel.classList.contains('active')).toBe(false);
    });
  });

  // ========================================================================
  // Edit panel — updatePanelSummaries
  // ========================================================================
  describe('updatePanelSummaries', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="overviewEventTypes"></div>';
      setupPanelDOM();
    });

    it('sets name and duration summary', () => {
      document.getElementById('editEtName').value = 'Strategy Call';
      document.getElementById('editEtDuration').value = '60';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryNameDuration').textContent).toBe('Strategy Call · 60 min');
    });

    it('shows "Untitled" when name is empty', () => {
      document.getElementById('editEtName').value = '';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryNameDuration').textContent).toContain('Untitled');
    });

    it('sets color summary to color name', () => {
      document.getElementById('editEtColor').value = '#dc2626';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryColor').textContent).toBe('Red');
    });

    it('falls back to hex value for unknown colors', () => {
      document.getElementById('editEtColor').value = '#123abc';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryColor').textContent).toBe('#123abc');
    });

    it('sets description summary', () => {
      document.getElementById('editEtDesc').value = 'A brief meeting.';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryDesc').textContent).toBe('A brief meeting.');
    });

    it('shows "No description" when empty', () => {
      document.getElementById('editEtDesc').value = '';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryDesc').textContent).toBe('No description');
    });

    it('truncates long descriptions', () => {
      document.getElementById('editEtDesc').value = 'A'.repeat(100);

      updatePanelSummaries();

      const summary = document.getElementById('epSummaryDesc').textContent;
      expect(summary.length).toBeLessThanOrEqual(61);
      expect(summary).toContain('…');
    });

    it('sets location summary', () => {
      document.getElementById('editEtLocation').value = 'zoom';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryLocation').textContent).toBe('Zoom');
    });

    it('sets availability summary from select', () => {
      document.getElementById('editEtSchedule').value = '2';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryAvailability').textContent).toBe('Evening');
    });

    it('sets limits summary with notice only', () => {
      document.getElementById('editEtMinNotice').value = '8';
      document.getElementById('editEtBufferBefore').value = '0';
      document.getElementById('editEtBufferAfter').value = '0';
      document.getElementById('editEtMaxPerDay').value = '';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryLimits').textContent).toBe('8h notice');
    });

    it('includes buffer in limits summary when set', () => {
      document.getElementById('editEtMinNotice').value = '4';
      document.getElementById('editEtBufferBefore').value = '10';
      document.getElementById('editEtBufferAfter').value = '5';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryLimits').textContent).toContain('±10/5m buffer');
    });

    it('includes max per day in limits summary when set', () => {
      document.getElementById('editEtMaxPerDay').value = '3';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryLimits').textContent).toContain('max 3/day');
    });

    it('sets team summary to One-on-One when no round robin', () => {
      document.getElementById('editEtRoundRobin').value = '';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryTeam').textContent).toBe('One-on-One');
    });

    it('sets team summary to Round Robin when selected', () => {
      document.getElementById('editEtRoundRobin').value = 'round_robin';

      updatePanelSummaries();

      expect(document.getElementById('epSummaryTeam').textContent).toBe('Round Robin');
    });
  });

  // ========================================================================
  // Settings tabs — switchSettingsTab
  // ========================================================================
  describe('switchSettingsTab', () => {
    function switchSettingsTab(btn, tabName) {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.remove('active'));
      const panelId = 'settingsTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.add('active');
    }

    beforeEach(() => {
      document.body.innerHTML = `
        <button class="settings-tab active" id="tabProfile">Profile</button>
        <button class="settings-tab" id="tabBranding">Branding</button>
        <button class="settings-tab" id="tabIntegrations">Integrations</button>
        <button class="settings-tab" id="tabTracking">Tracking</button>
        <button class="settings-tab" id="tabAdvanced">Advanced</button>
        <div class="settings-tab-panel active" id="settingsTabProfile">Profile content</div>
        <div class="settings-tab-panel" id="settingsTabBranding">Branding content</div>
        <div class="settings-tab-panel" id="settingsTabIntegrations">Integrations content</div>
        <div class="settings-tab-panel" id="settingsTabTracking">Tracking content</div>
        <div class="settings-tab-panel" id="settingsTabAdvanced">Advanced content</div>
      `;
    });

    it('shows Profile tab by default', () => {
      expect(document.getElementById('settingsTabProfile').classList.contains('active')).toBe(true);
      expect(document.getElementById('settingsTabBranding').classList.contains('active')).toBe(false);
    });

    it('switches to Branding tab', () => {
      const btn = document.getElementById('tabBranding');
      switchSettingsTab(btn, 'branding');

      expect(document.getElementById('settingsTabBranding').classList.contains('active')).toBe(true);
      expect(document.getElementById('settingsTabProfile').classList.contains('active')).toBe(false);
    });

    it('switches to Integrations tab', () => {
      const btn = document.getElementById('tabIntegrations');
      switchSettingsTab(btn, 'integrations');

      expect(document.getElementById('settingsTabIntegrations').classList.contains('active')).toBe(true);
    });

    it('switches to Advanced tab', () => {
      const btn = document.getElementById('tabAdvanced');
      switchSettingsTab(btn, 'advanced');

      expect(document.getElementById('settingsTabAdvanced').classList.contains('active')).toBe(true);
    });

    it('only one tab panel is active at a time', () => {
      const btn = document.getElementById('tabTracking');
      switchSettingsTab(btn, 'tracking');

      const activePanels = document.querySelectorAll('.settings-tab-panel.active');
      expect(activePanels.length).toBe(1);
      expect(activePanels[0].id).toBe('settingsTabTracking');
    });

    it('activates the clicked tab button', () => {
      const btn = document.getElementById('tabBranding');
      switchSettingsTab(btn, 'branding');

      expect(btn.classList.contains('active')).toBe(true);
      expect(document.getElementById('tabProfile').classList.contains('active')).toBe(false);
    });

    it('only one tab button is active at a time', () => {
      const btn = document.getElementById('tabAdvanced');
      switchSettingsTab(btn, 'advanced');

      const activeButtons = document.querySelectorAll('.settings-tab.active');
      expect(activeButtons.length).toBe(1);
    });
  });

  // ── parseUTC regression tests ─────────────────────────────────────────────
  describe('parseUTC timezone handling', () => {
    function parseUTC(str) {
      if (!str) return new Date(NaN);
      const normalized = str.replace(' ', 'T');
      if (/[Zz]$/.test(normalized) || /[+-]\d{2}:\d{2}$/.test(normalized)) return new Date(normalized);
      return new Date(normalized + 'Z');
    }

    it('parses Calendo internal format (no timezone)', () => {
      const d = parseUTC('2026-04-16 14:00:00');
      expect(d.getTime()).toBe(new Date('2026-04-16T14:00:00Z').getTime());
    });

    it('parses UTC Z suffix', () => {
      const d = parseUTC('2026-04-16T14:00:00Z');
      expect(d.getTime()).toBe(new Date('2026-04-16T14:00:00Z').getTime());
    });

    it('parses Google Calendar format with negative timezone offset', () => {
      const d = parseUTC('2026-04-16T10:00:00-07:00');
      expect(d.getTime()).toBe(new Date('2026-04-16T17:00:00Z').getTime());
    });

    it('parses Google Calendar format with positive timezone offset', () => {
      const d = parseUTC('2026-04-16T10:00:00+05:30');
      expect(d.getTime()).toBe(new Date('2026-04-16T04:30:00Z').getTime());
    });

    it('returns Invalid Date for null/empty', () => {
      expect(parseUTC(null).getTime()).toBeNaN();
      expect(parseUTC('').getTime()).toBeNaN();
    });

    it('does not corrupt timezone offset by appending Z', () => {
      const d = parseUTC('2026-04-18T10:00:00-07:00');
      expect(isNaN(d.getTime())).toBe(false);
    });
  });
});
