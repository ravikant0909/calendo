import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const extensionDir = join(__dirname, '../../../extension');

describe('Chrome Extension', () => {
  describe('manifest.json', () => {
    let manifest;

    it('should exist and be valid JSON', () => {
      const path = join(extensionDir, 'manifest.json');
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf8');
      manifest = JSON.parse(content);
      expect(manifest).toBeDefined();
    });

    it('should use Manifest V3', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.manifest_version).toBe(3);
    });

    it('should have required name and description', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.name).toBe('Calendo - Schedule Meetings');
      expect(manifest.description).toBeTruthy();
      expect(typeof manifest.description).toBe('string');
    });

    it('should have a version string', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.version).toBeTruthy();
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should require activeTab and storage permissions', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.permissions).toContain('activeTab');
      expect(manifest.permissions).toContain('storage');
    });

    it('should define a popup action', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.action).toBeDefined();
      expect(manifest.action.default_popup).toBe('popup.html');
    });

    it('should define content scripts for Gmail', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.content_scripts).toBeDefined();
      expect(manifest.content_scripts.length).toBeGreaterThan(0);
      const gmailScript = manifest.content_scripts[0];
      expect(gmailScript.matches).toContain('https://mail.google.com/*');
      expect(gmailScript.js).toContain('content.js');
    });

    it('should reference icon files', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      expect(manifest.icons).toBeDefined();
      expect(manifest.icons['16']).toBeTruthy();
      expect(manifest.icons['48']).toBeTruthy();
      expect(manifest.icons['128']).toBeTruthy();
    });

    it('should reference CSS in content scripts', () => {
      const content = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(content);
      const gmailScript = manifest.content_scripts[0];
      expect(gmailScript.css).toContain('styles.css');
    });
  });

  describe('popup.html', () => {
    let popupHtml;

    it('should exist', () => {
      const path = join(extensionDir, 'popup.html');
      expect(existsSync(path)).toBe(true);
      popupHtml = readFileSync(path, 'utf8');
    });

    it('should contain a booking link input field', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('id="booking-link"');
      expect(popupHtml).toContain('type="text"');
    });

    it('should contain a save button', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('id="save-btn"');
      expect(popupHtml).toContain('Save');
    });

    it('should contain a copy link button', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('id="copy-btn"');
      expect(popupHtml).toContain('Copy Link');
    });

    it('should link to the dashboard', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('https://calendo.dev/dashboard');
    });

    it('should reference popup.js', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('popup.js');
    });

    it('should contain a status element', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('id="status"');
    });

    it('should contain a saved link display area', () => {
      popupHtml = readFileSync(join(extensionDir, 'popup.html'), 'utf8');
      expect(popupHtml).toContain('id="current-link"');
      expect(popupHtml).toContain('id="saved-url"');
    });
  });

  describe('content.js', () => {
    let contentJs;

    it('should exist', () => {
      const path = join(extensionDir, 'content.js');
      expect(existsSync(path)).toBe(true);
      contentJs = readFileSync(path, 'utf8');
    });

    it('should contain Gmail compose window detection logic', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      // Should look for Gmail compose toolbar
      expect(contentJs).toContain('.btC');
      // Should observe DOM mutations for new compose windows
      expect(contentJs).toContain('MutationObserver');
    });

    it('should create a Calendo button element', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      expect(contentJs).toContain('calendo-insert-btn');
      expect(contentJs).toContain('Calendo');
    });

    it('should use chrome.storage.sync to retrieve the booking link', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      expect(contentJs).toContain('chrome.storage.sync.get');
      expect(contentJs).toContain('calendoBookingLink');
    });

    it('should insert a formatted booking link', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      expect(contentJs).toContain('Book a time with me');
    });

    it('should handle multiple compose windows via WeakSet tracking', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      expect(contentJs).toContain('WeakSet');
      expect(contentJs).toContain('processedToolbars');
    });

    it('should escape HTML to prevent XSS', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      expect(contentJs).toContain('escapeHtml');
    });

    it('should handle insertion at cursor position', () => {
      contentJs = readFileSync(join(extensionDir, 'content.js'), 'utf8');
      expect(contentJs).toContain('getSelection');
      expect(contentJs).toContain('getRangeAt');
    });
  });

  describe('popup.js', () => {
    let popupJs;

    it('should exist', () => {
      const path = join(extensionDir, 'popup.js');
      expect(existsSync(path)).toBe(true);
      popupJs = readFileSync(path, 'utf8');
    });

    it('should validate Calendo booking links', () => {
      popupJs = readFileSync(join(extensionDir, 'popup.js'), 'utf8');
      expect(popupJs).toContain('isValidCalendoLink');
      expect(popupJs).toContain('calendo.dev');
      expect(popupJs).toContain('/booking/');
    });

    it('should use chrome.storage.sync for persistence', () => {
      popupJs = readFileSync(join(extensionDir, 'popup.js'), 'utf8');
      expect(popupJs).toContain('chrome.storage.sync.set');
      expect(popupJs).toContain('chrome.storage.sync.get');
    });

    it('should use navigator.clipboard for copy functionality', () => {
      popupJs = readFileSync(join(extensionDir, 'popup.js'), 'utf8');
      expect(popupJs).toContain('navigator.clipboard.writeText');
    });
  });

  describe('styles.css', () => {
    it('should exist', () => {
      const path = join(extensionDir, 'styles.css');
      expect(existsSync(path)).toBe(true);
    });

    it('should style the Calendo insert button', () => {
      const css = readFileSync(join(extensionDir, 'styles.css'), 'utf8');
      expect(css).toContain('.calendo-insert-btn');
    });

    it('should style the tooltip', () => {
      const css = readFileSync(join(extensionDir, 'styles.css'), 'utf8');
      expect(css).toContain('.calendo-tooltip');
    });

    it('should include hover styles', () => {
      const css = readFileSync(join(extensionDir, 'styles.css'), 'utf8');
      expect(css).toContain('.calendo-insert-btn:hover');
    });
  });

  describe('Icon files', () => {
    it('should have a 16x16 icon', () => {
      const path = join(extensionDir, 'icons/icon-16.png');
      expect(existsSync(path)).toBe(true);
      const data = readFileSync(path);
      // PNG signature: 137 80 78 71 13 10 26 10
      expect(data[0]).toBe(137);
      expect(data[1]).toBe(80);
      expect(data[2]).toBe(78);
      expect(data[3]).toBe(71);
    });

    it('should have a 48x48 icon', () => {
      const path = join(extensionDir, 'icons/icon-48.png');
      expect(existsSync(path)).toBe(true);
      const data = readFileSync(path);
      expect(data[0]).toBe(137);
    });

    it('should have a 128x128 icon', () => {
      const path = join(extensionDir, 'icons/icon-128.png');
      expect(existsSync(path)).toBe(true);
      const data = readFileSync(path);
      expect(data[0]).toBe(137);
    });
  });
});
