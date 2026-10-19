import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCheckoutSession, verifyWebhookSignature, handleRefund, createStripeCustomer, createSubscriptionCheckout, createCustomerPortalSession, isPro } from '../../../src/payments.js';

// ============================================================
// Webhook Signature Verification Tests
// ============================================================

describe('verifyWebhookSignature', () => {
  async function computeHmacSha256(secret, payload) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    return Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  it('should return true for a valid signature', async () => {
    const secret = 'whsec_test_secret_123';
    const payload = '{"type":"checkout.session.completed","data":{}}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${timestamp}.${payload}`;
    const sig = await computeHmacSha256(secret, signedPayload);

    const header = `t=${timestamp},v1=${sig}`;
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(true);
  });

  it('should return false for an invalid signature', async () => {
    const secret = 'whsec_test_secret_123';
    const payload = '{"type":"checkout.session.completed"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const header = `t=${timestamp},v1=0000000000000000000000000000000000000000000000000000000000000000`;
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(false);
  });

  it('should return false for a tampered payload', async () => {
    const secret = 'whsec_test_secret_123';
    const originalPayload = '{"type":"checkout.session.completed"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${timestamp}.${originalPayload}`;
    const sig = await computeHmacSha256(secret, signedPayload);

    const tamperedPayload = '{"type":"checkout.session.completed","hacked":true}';
    const header = `t=${timestamp},v1=${sig}`;
    const result = await verifyWebhookSignature(tamperedPayload, header, secret);
    expect(result).toBe(false);
  });

  it('should return false for an expired timestamp (>5 min)', async () => {
    const secret = 'whsec_test_secret_123';
    const payload = '{"type":"test"}';
    // 10 minutes ago
    const timestamp = (Math.floor(Date.now() / 1000) - 600).toString();
    const signedPayload = `${timestamp}.${payload}`;
    const sig = await computeHmacSha256(secret, signedPayload);

    const header = `t=${timestamp},v1=${sig}`;
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(false);
  });

  it('should return false for missing payload', async () => {
    const result = await verifyWebhookSignature(null, 't=123,v1=abc', 'secret');
    expect(result).toBe(false);
  });

  it('should return false for missing signature', async () => {
    const result = await verifyWebhookSignature('payload', null, 'secret');
    expect(result).toBe(false);
  });

  it('should return false for missing secret', async () => {
    const result = await verifyWebhookSignature('payload', 't=123,v1=abc', null);
    expect(result).toBe(false);
  });

  it('should return false for malformed signature header (no timestamp)', async () => {
    const result = await verifyWebhookSignature('payload', 'v1=abc123', 'secret');
    expect(result).toBe(false);
  });

  it('should return false for malformed signature header (no v1)', async () => {
    const result = await verifyWebhookSignature('payload', 't=12345', 'secret');
    expect(result).toBe(false);
  });

  it('should handle multiple v1 signatures (Stripe key rotation)', async () => {
    const secret = 'whsec_test_secret_123';
    const payload = '{"type":"test"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${timestamp}.${payload}`;
    const validSig = await computeHmacSha256(secret, signedPayload);

    // Stripe may include old and new signature
    const header = `t=${timestamp},v1=invalid_old_signature_0000000000000000000000000000000000000000,v1=${validSig}`;
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(true);
  });
});

// ============================================================
// Checkout Session Creation Tests
// ============================================================

describe('createCheckoutSession', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_12345',
    };
    // Reset global fetch mock
    global.fetch = vi.fn();
  });

  it('should create a checkout session and return the URL', async () => {
    const checkoutUrl = 'https://checkout.stripe.com/pay/cs_test_abc123';

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: checkoutUrl }),
    });

    const result = await createCheckoutSession(mockEnv, {
      eventType: {
        name: '30 Minute Consultation',
        price_cents: 5000,
        currency: 'usd',
      },
      booking: { uid: 'booking-uid-123' },
      successUrl: 'https://calendo.dev/success',
      cancelUrl: 'https://calendo.dev/cancel',
    });

    expect(result).toBe(checkoutUrl);

    // Verify fetch was called with correct params
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer sk_test_12345');

    // Verify body params
    const body = new URLSearchParams(options.body);
    expect(body.get('payment_method_types[]')).toBe('card');
    expect(body.get('mode')).toBe('payment');
    expect(body.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('5000');
    expect(body.get('line_items[0][price_data][product_data][name]')).toBe('30 Minute Consultation');
    expect(body.get('line_items[0][quantity]')).toBe('1');
    expect(body.get('metadata[booking_uid]')).toBe('booking-uid-123');
    expect(body.get('success_url')).toBe('https://calendo.dev/success');
    expect(body.get('cancel_url')).toBe('https://calendo.dev/cancel');
  });

  it('should throw on Stripe API error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    });

    await expect(createCheckoutSession(mockEnv, {
      eventType: { name: 'Test', price_cents: 1000, currency: 'usd' },
      booking: { uid: 'test-uid' },
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    })).rejects.toThrow('Stripe error: Invalid API key');
  });

  it('should default currency to usd when not specified', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: 'https://checkout.stripe.com/test' }),
    });

    await createCheckoutSession(mockEnv, {
      eventType: { name: 'Test', price_cents: 2500 },
      booking: { uid: 'test-uid' },
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(body.get('line_items[0][price_data][currency]')).toBe('usd');
  });
});

// ============================================================
// Refund Tests
// ============================================================

describe('handleRefund', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_12345',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({}),
          }),
        }),
      },
    };
    global.fetch = vi.fn();
  });

  it('should create a refund and update the payment record', async () => {
    const refundObj = { id: 're_test_123', status: 'succeeded' };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(refundObj),
    });

    const result = await handleRefund(mockEnv, 'pi_test_payment_intent');

    expect(result).toEqual(refundObj);

    // Verify Stripe API call
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/refunds');
    expect(options.method).toBe('POST');

    const body = new URLSearchParams(options.body);
    expect(body.get('payment_intent')).toBe('pi_test_payment_intent');

    // Verify DB update
    expect(mockEnv.DB.prepare).toHaveBeenCalled();
  });

  it('should throw on Stripe refund error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Charge already refunded' } }),
    });

    await expect(handleRefund(mockEnv, 'pi_test_123')).rejects.toThrow(
      'Stripe refund error: Charge already refunded'
    );
  });
});

// ============================================================
// Stripe Customer Creation Tests
// ============================================================

describe('createStripeCustomer', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = { STRIPE_SECRET_KEY: 'sk_test_12345' };
    global.fetch = vi.fn();
  });

  it('should create a Stripe customer and return the ID', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'cus_test_123' }),
    });

    const result = await createStripeCustomer(mockEnv, {
      id: 42,
      email: 'test@example.com',
      name: 'Test User',
    });

    expect(result).toBe('cus_test_123');

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/customers');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer sk_test_12345');

    const body = new URLSearchParams(options.body);
    expect(body.get('email')).toBe('test@example.com');
    expect(body.get('name')).toBe('Test User');
    expect(body.get('metadata[calendo_user_id]')).toBe('42');
  });

  it('should handle user without name', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'cus_noname' }),
    });

    await createStripeCustomer(mockEnv, { id: 1, email: 'no-name@test.com' });

    const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
    expect(body.get('email')).toBe('no-name@test.com');
    expect(body.has('name')).toBe(false);
  });

  it('should throw on Stripe API error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    });

    await expect(createStripeCustomer(mockEnv, { id: 1, email: 'x@y.com' }))
      .rejects.toThrow('Stripe error: Invalid API key');
  });
});

// ============================================================
// Subscription Checkout Tests
// ============================================================

describe('createSubscriptionCheckout', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_12345',
      STRIPE_PRO_PRICE_ID: 'price_pro_test',
    };
    global.fetch = vi.fn();
  });

  it('should create a subscription checkout session and return the URL', async () => {
    const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_sub_test';

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: checkoutUrl }),
    });

    const result = await createSubscriptionCheckout(mockEnv, {
      customerId: 'cus_test_123',
      successUrl: 'https://calendo.dev/dashboard/?upgrade=success',
      cancelUrl: 'https://calendo.dev/dashboard/?upgrade=cancelled',
    });

    expect(result).toBe(checkoutUrl);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(options.method).toBe('POST');

    const body = new URLSearchParams(options.body);
    expect(body.get('customer')).toBe('cus_test_123');
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('line_items[0][price]')).toBe('price_pro_test');
    expect(body.get('line_items[0][quantity]')).toBe('1');
    expect(body.get('payment_method_types[]')).toBe('card');
  });

  it('should throw on Stripe API error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'No such price' } }),
    });

    await expect(createSubscriptionCheckout(mockEnv, {
      customerId: 'cus_test',
      successUrl: 'https://calendo.dev/success',
      cancelUrl: 'https://calendo.dev/cancel',
    })).rejects.toThrow('Stripe error: No such price');
  });
});

// ============================================================
// Customer Portal Tests
// ============================================================

describe('createCustomerPortalSession', () => {
  let mockEnv;

  beforeEach(() => {
    mockEnv = { STRIPE_SECRET_KEY: 'sk_test_12345' };
    global.fetch = vi.fn();
  });

  it('should create a portal session and return the URL', async () => {
    const portalUrl = 'https://billing.stripe.com/session/test';

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ url: portalUrl }),
    });

    const result = await createCustomerPortalSession(mockEnv, {
      customerId: 'cus_test_123',
      returnUrl: 'https://calendo.dev/dashboard/',
    });

    expect(result).toBe(portalUrl);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');

    const body = new URLSearchParams(options.body);
    expect(body.get('customer')).toBe('cus_test_123');
    expect(body.get('return_url')).toBe('https://calendo.dev/dashboard/');
  });

  it('should throw on Stripe API error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'No such customer' } }),
    });

    await expect(createCustomerPortalSession(mockEnv, {
      customerId: 'cus_bad',
      returnUrl: 'https://calendo.dev/dashboard/',
    })).rejects.toThrow('Stripe error: No such customer');
  });
});

// ============================================================
// isPro Tests
// ============================================================

describe('isPro', () => {
  it('should return true for pro plan', () => {
    expect(isPro({ plan: 'pro' })).toBe(true);
  });

  it('should return false for free plan', () => {
    expect(isPro({ plan: 'free' })).toBe(false);
  });

  it('should return false for undefined plan', () => {
    expect(isPro({})).toBe(false);
  });

  it('should return false for null plan', () => {
    expect(isPro({ plan: null })).toBe(false);
  });
});

// ============================================================
// Worker Stripe Route Integration Tests
// ============================================================

describe('Stripe Routes in Worker', () => {
  it('should reject Stripe webhook without signature', async () => {
    const worker = await import('../../../src/worker.js');
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: '{}',
    });

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({}),
          }),
        }),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Missing Stripe-Signature header');
  });

  it('should require auth for create-checkout', async () => {
    const worker = await import('../../../src/worker.js');
    const request = new Request('https://calendo.dev/api/stripe/create-checkout', {
      method: 'POST',
      body: JSON.stringify({ booking_uid: 'test' }),
    });

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({}),
          }),
        }),
      },
      ASSETS: { fetch: () => new Response('') },
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });

  it('should require auth for payments list', async () => {
    const worker = await import('../../../src/worker.js');
    const request = new Request('https://calendo.dev/api/payments', {
      method: 'GET',
    });

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({}),
          }),
        }),
      },
      ASSETS: { fetch: () => new Response('') },
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });

  it('should require auth for booking refund', async () => {
    const worker = await import('../../../src/worker.js');
    const request = new Request('https://calendo.dev/api/bookings/1/refund', {
      method: 'POST',
    });

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({}),
          }),
        }),
      },
      ASSETS: { fetch: () => new Response('') },
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });

  it('should require auth for create-subscription', async () => {
    const worker = await import('../../../src/worker.js');
    const request = new Request('https://calendo.dev/api/stripe/create-subscription', {
      method: 'POST',
      body: '{}',
    });

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({}),
          }),
        }),
      },
      ASSETS: { fetch: () => new Response('') },
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });

  it('should require auth for customer-portal', async () => {
    const worker = await import('../../../src/worker.js');
    const request = new Request('https://calendo.dev/api/stripe/customer-portal', {
      method: 'POST',
      body: '{}',
    });

    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => null,
            all: () => ({ results: [] }),
            run: () => ({}),
          }),
        }),
      },
      ASSETS: { fetch: () => new Response('') },
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(401);
  });
});

// ============================================================
// Subscription Webhook Tests
// ============================================================

describe('Subscription Webhook Handling', () => {
  async function computeHmacSha256(secret, payload) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    return Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function makeSignedRequest(secret, eventPayload) {
    const payload = JSON.stringify(eventPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    return {
      payload,
      timestamp,
      getSignatureHeader: async () => {
        const signedPayload = `${timestamp}.${payload}`;
        const sig = await computeHmacSha256(secret, signedPayload);
        return `t=${timestamp},v1=${sig}`;
      },
    };
  }

  it('should upgrade user to pro on subscription checkout.session.completed', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_sub';

    const runCalls = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          customer: 'cus_sub_test',
          subscription: 'sub_test_123',
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => ({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(
              sql.includes('FROM users') ? { id: 1, plan: 'free', stripe_customer_id: 'cus_sub_test' } : null
            ),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockImplementation(() => {
              runCalls.push(sql);
              return {};
            }),
          }),
        })),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.received).toBe(true);

    // Verify DB update was called to set plan to pro
    const updateCall = runCalls.find(sql => sql.includes("plan = 'pro'"));
    expect(updateCall).toBeTruthy();
  });

  it('should not process subscription checkout as booking payment', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_sub2';

    const bookingQueries = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          customer: 'cus_sub_test',
          subscription: 'sub_test_456',
          // No booking_uid metadata — this is a subscription, not a booking
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => {
          if (sql.includes('FROM bookings')) bookingQueries.push(sql);
          return {
            bind: vi.fn().mockReturnValue({
              first: vi.fn().mockResolvedValue(
                sql.includes('FROM users') ? { id: 1, plan: 'free', stripe_customer_id: 'cus_sub_test' } : null
              ),
              all: vi.fn().mockResolvedValue({ results: [] }),
              run: vi.fn().mockResolvedValue({}),
            }),
          };
        }),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    // Ensure no booking queries were made
    expect(bookingQueries.length).toBe(0);
  });

  it('should downgrade user on customer.subscription.deleted', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_del';

    const runCalls = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_del_test',
          id: 'sub_del_123',
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => ({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockImplementation(() => {
              runCalls.push(sql);
              return {};
            }),
          }),
        })),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const downgradeCall = runCalls.find(sql => sql.includes("plan = 'free'") && sql.includes('stripe_subscription_id = NULL'));
    expect(downgradeCall).toBeTruthy();
  });

  it('should downgrade user on customer.subscription.updated to past_due', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_upd';

    const runCalls = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'customer.subscription.updated',
      data: {
        object: {
          customer: 'cus_upd_test',
          id: 'sub_upd_123',
          status: 'past_due',
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => ({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockImplementation(() => {
              runCalls.push(sql);
              return {};
            }),
          }),
        })),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const downgradeCall = runCalls.find(sql => sql.includes("plan = 'free'"));
    expect(downgradeCall).toBeTruthy();
  });

  it('should re-activate user on customer.subscription.updated to active', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_react';

    const runCalls = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'customer.subscription.updated',
      data: {
        object: {
          customer: 'cus_react_test',
          id: 'sub_react_123',
          status: 'active',
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => ({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockImplementation(() => {
              runCalls.push(sql);
              return {};
            }),
          }),
        })),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const upgradeCall = runCalls.find(sql => sql.includes("plan = 'pro'"));
    expect(upgradeCall).toBeTruthy();
  });

  it('should downgrade user on invoice.payment_failed for subscription', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_inv';

    const runCalls = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_inv_test',
          subscription: 'sub_inv_123',
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => ({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockImplementation(() => {
              runCalls.push(sql);
              return {};
            }),
          }),
        })),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const downgradeCall = runCalls.find(sql => sql.includes("plan = 'free'"));
    expect(downgradeCall).toBeTruthy();
  });

  it('should not downgrade on invoice.payment_failed for non-subscription invoice', async () => {
    const worker = await import('../../../src/worker.js');
    const secret = 'whsec_test_inv_nosub';

    const runCalls = [];
    const { payload, getSignatureHeader } = makeSignedRequest(secret, {
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_inv_nosub',
          // No subscription field — one-time payment invoice
        },
      },
    });

    const sigHeader = await getSignatureHeader();
    const request = new Request('https://calendo.dev/api/stripe/webhook', {
      method: 'POST',
      body: payload,
      headers: { 'Stripe-Signature': sigHeader },
    });

    const env = {
      DB: {
        prepare: vi.fn().mockImplementation((sql) => ({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockImplementation(() => {
              runCalls.push(sql);
              return {};
            }),
          }),
        })),
      },
      ASSETS: { fetch: () => new Response('') },
      STRIPE_WEBHOOK_SECRET: secret,
    };

    const response = await worker.default.fetch(request, env, {});
    expect(response.status).toBe(200);

    const downgradeCall = runCalls.find(sql => sql.includes("plan = 'free'"));
    expect(downgradeCall).toBeFalsy();
  });
});
