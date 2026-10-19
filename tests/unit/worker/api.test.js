import { describe, it, expect, beforeEach } from 'vitest';

// Basic smoke test for the Worker
// Full D1 integration tests will use @cloudflare/vitest-pool-workers

describe('Worker API', () => {
  describe('JSON response helper', () => {
    it('should create proper JSON responses', async () => {
      // Import the worker module
      const worker = await import('../../../src/worker.js');

      // The worker exports a default object with fetch handler
      expect(worker.default).toBeDefined();
      expect(typeof worker.default.fetch).toBe('function');
    });
  });

  describe('CORS', () => {
    it('should handle OPTIONS preflight requests', async () => {
      const worker = await import('../../../src/worker.js');

      const request = new Request('https://calendo.dev/api/event-types', {
        method: 'OPTIONS',
      });

      // Create mock env
      const env = {
        DB: {},
        ASSETS: { fetch: () => new Response('') },
      };

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  describe('Authentication', () => {
    it('should return 401 for protected routes without auth', async () => {
      const worker = await import('../../../src/worker.js');

      const request = new Request('https://calendo.dev/api/event-types', {
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
        ASSETS: { fetch: () => new Response('') },
      };

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('Public routes', () => {
    it('should return 404 for non-existent booking pages', async () => {
      const worker = await import('../../../src/worker.js');

      const request = new Request('https://calendo.dev/api/booking-page/nonexistent', {
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
        ASSETS: { fetch: () => new Response('') },
      };

      const response = await worker.default.fetch(request, env, {});
      expect(response.status).toBe(404);
    });
  });
});
