import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Embed Widgets', () => {
  let worker;

  beforeEach(async () => {
    vi.resetModules();
    worker = await import('../../../src/worker.js');
  });

  describe('Embed script serving', () => {
    it('should serve /embed/calendo-embed.js with correct Content-Type', async () => {
      const request = new Request('https://calendo.dev/embed/calendo-embed.js', {
        method: 'GET',
      });

      const jsContent = '(function(){})();';
      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: {
          fetch: () => new Response(jsContent, {
            headers: { 'Content-Type': 'application/javascript' },
          }),
        },
      };

      const response = await worker.default.fetch(request, env, {});
      expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    });

    it('should serve /embed/calendo-embed.js with Access-Control-Allow-Origin: *', async () => {
      const request = new Request('https://calendo.dev/embed/calendo-embed.js', {
        method: 'GET',
      });

      const jsContent = '(function(){})();';
      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: {
          fetch: () => new Response(jsContent, {
            headers: { 'Content-Type': 'application/javascript' },
          }),
        },
      };

      const response = await worker.default.fetch(request, env, {});
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should serve /embed/calendo-embed.js with cache-friendly headers', async () => {
      const request = new Request('https://calendo.dev/embed/calendo-embed.js', {
        method: 'GET',
      });

      const jsContent = '(function(){})();';
      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: {
          fetch: () => new Response(jsContent, {
            headers: { 'Content-Type': 'application/javascript' },
          }),
        },
      };

      const response = await worker.default.fetch(request, env, {});
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });

    it('should return the embed script body content', async () => {
      const request = new Request('https://calendo.dev/embed/calendo-embed.js', {
        method: 'GET',
      });

      const jsContent = '(function(){console.log("calendo embed")})();';
      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: {
          fetch: () => new Response(jsContent, {
            headers: { 'Content-Type': 'application/javascript' },
          }),
        },
      };

      const response = await worker.default.fetch(request, env, {});
      const body = await response.text();
      expect(body).toBe(jsContent);
    });
  });

  describe('Booking page iframe compatibility', () => {
    it('should not send X-Frame-Options: DENY for booking pages', async () => {
      const request = new Request('https://calendo.dev/booking/', {
        method: 'GET',
      });

      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: {
          fetch: () => new Response('<html>booking page</html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
        },
      };

      const response = await worker.default.fetch(request, env, {});
      const xFrameOptions = response.headers.get('X-Frame-Options');
      // Should not have DENY - either null or SAMEORIGIN is acceptable
      expect(xFrameOptions).not.toBe('DENY');
    });

    it('should serve booking pages as HTML', async () => {
      const request = new Request('https://calendo.dev/booking/', {
        method: 'GET',
      });

      const env = {
        DB: {
          prepare: () => ({
            bind: () => ({
              first: () => null,
              all: () => ({ results: [] }),
            }),
          }),
        },
        ASSETS: {
          fetch: () => new Response('<html>booking page</html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
        },
      };

      const response = await worker.default.fetch(request, env, {});
      const contentType = response.headers.get('Content-Type') || '';
      expect(contentType).toContain('text/html');
    });
  });

  describe('Embed script content validation', () => {
    it('should be valid JavaScript', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      // Should not throw when parsed
      expect(() => new Function(content)).not.toThrow();
    });

    it('should be under 5KB', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');
      const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;

      expect(sizeKB).toBeLessThan(5);
    });

    it('should contain inline mode handling', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('inline');
      expect(content).toContain('iframe');
    });

    it('should contain popup mode handling', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('popup');
      expect(content).toContain('calendo-embed-overlay');
      expect(content).toContain('calendo-embed-modal');
    });

    it('should add embed=1 parameter to iframe src', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('embed=1');
    });

    it('should listen for booking confirmation messages from iframe', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('calendo:booking-confirmed');
      expect(content).toContain("addEventListener('message'");
    });

    it('should expose window.Calendo API', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('window.Calendo');
    });

    it('should inject styles only once', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('calendo-embed-styles');
      // Should check for existing styles before injecting
      expect(content).toContain('getElementById');
    });

    it('should support data-url, data-mode, data-text, data-color, data-width, data-height attributes', () => {
      const scriptPath = join(__dirname, '../../../public/embed/calendo-embed.js');
      const content = readFileSync(scriptPath, 'utf-8');

      expect(content).toContain('data-url');
      expect(content).toContain('data-mode');
      expect(content).toContain('data-text');
      expect(content).toContain('data-color');
      expect(content).toContain('data-width');
      expect(content).toContain('data-height');
    });
  });

  describe('Booking page postMessage integration', () => {
    it('should include postMessage code for parent notification', () => {
      const bookingPath = join(__dirname, '../../../public/booking/index.html');
      const content = readFileSync(bookingPath, 'utf-8');

      expect(content).toContain('window.parent.postMessage');
      expect(content).toContain('calendo:booking-confirmed');
    });

    it('should only send postMessage when in an iframe', () => {
      const bookingPath = join(__dirname, '../../../public/booking/index.html');
      const content = readFileSync(bookingPath, 'utf-8');

      // Should check if window.parent !== window (i.e., inside an iframe)
      expect(content).toContain('window.parent !== window');
    });
  });
});
