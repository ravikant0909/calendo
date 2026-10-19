// Calendo - Stripe & PayPal Payment Integration
// Handles checkout sessions, webhook verification, refunds, and PayPal orders

// ============================================================
// Checkout Session
// ============================================================

/**
 * Create a Stripe Checkout session for a paid booking.
 *
 * @param {Object} env - Worker env bindings (needs STRIPE_SECRET_KEY)
 * @param {Object} params
 * @param {Object} params.eventType - Event type with price_cents, currency, name
 * @param {Object} params.booking - Booking with uid
 * @param {string} params.successUrl - Redirect URL on successful payment
 * @param {string} params.cancelUrl - Redirect URL on cancelled payment
 * @returns {string} Stripe checkout session URL
 */
export async function createCheckoutSession(env, { eventType, booking, successUrl, cancelUrl }) {
  const params = new URLSearchParams();
  params.append('payment_method_types[]', 'card');
  params.append('mode', 'payment');
  params.append('line_items[0][price_data][currency]', eventType.currency || 'usd');
  params.append('line_items[0][price_data][unit_amount]', String(eventType.price_cents));
  params.append('line_items[0][price_data][product_data][name]', eventType.name);
  params.append('line_items[0][quantity]', '1');
  params.append('metadata[booking_uid]', booking.uid);
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  // Expire the checkout well before the booking's pending_payment hold is
  // released (60 min) so a payment can never land on an expired booking.
  // Stripe's minimum is 30 minutes; 31 avoids clock-skew rejections.
  params.append('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60));

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await response.json();

  if (!response.ok) {
    throw new Error(`Stripe error: ${session.error?.message || 'Unknown error'}`);
  }

  return session.url;
}

// ============================================================
// Webhook Signature Verification
// ============================================================

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Stripe signs the payload as: timestamp + "." + payload
 * The signature header format: t=TIMESTAMP,v1=SIGNATURE[,v1=SIGNATURE...]
 *
 * @param {string} payload - Raw request body
 * @param {string} signature - Stripe-Signature header value
 * @param {string} secret - Webhook endpoint secret (whsec_...)
 * @returns {boolean} Whether the signature is valid
 */
export async function verifyWebhookSignature(payload, signature, secret) {
  if (!payload || !signature || !secret) {
    return false;
  }

  // Parse the signature header
  const parts = signature.split(',');
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  // Check timestamp tolerance (5 minutes)
  const timestampAge = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (timestampAge > 300) {
    return false;
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Compare against all v1 signatures (Stripe may include multiple)
  return signatures.some(sig => timingSafeEqual(sig, expectedSignature));
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ============================================================
// Subscription Checkout
// ============================================================

/**
 * Create a Stripe Customer for a user.
 *
 * @param {Object} env - Worker env bindings (needs STRIPE_SECRET_KEY)
 * @param {Object} user - User with email, name
 * @returns {string} Stripe customer ID
 */
export async function createStripeCustomer(env, user) {
  const params = new URLSearchParams();
  params.append('email', user.email);
  if (user.name) params.append('name', user.name);
  params.append('metadata[calendo_user_id]', String(user.id));

  const response = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const customer = await response.json();

  if (!response.ok) {
    throw new Error(`Stripe error: ${customer.error?.message || 'Unknown error'}`);
  }

  return customer.id;
}

/**
 * Create a Stripe Checkout session for a Pro subscription.
 *
 * @param {Object} env - Worker env bindings (needs STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID)
 * @param {Object} params
 * @param {string} params.customerId - Stripe customer ID
 * @param {string} params.successUrl - Redirect URL on success
 * @param {string} params.cancelUrl - Redirect URL on cancel
 * @returns {string} Stripe checkout session URL
 */
export async function createSubscriptionCheckout(env, { customerId, successUrl, cancelUrl }) {
  const params = new URLSearchParams();
  params.append('customer', customerId);
  params.append('payment_method_types[]', 'card');
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', env.STRIPE_PRO_PRICE_ID);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await response.json();

  if (!response.ok) {
    throw new Error(`Stripe error: ${session.error?.message || 'Unknown error'}`);
  }

  return session.url;
}

/**
 * Create a Stripe Billing Portal session for subscription management.
 *
 * @param {Object} env - Worker env bindings (needs STRIPE_SECRET_KEY)
 * @param {Object} params
 * @param {string} params.customerId - Stripe customer ID
 * @param {string} params.returnUrl - URL to return to after portal
 * @returns {string} Stripe billing portal URL
 */
export async function createCustomerPortalSession(env, { customerId, returnUrl }) {
  const params = new URLSearchParams();
  params.append('customer', customerId);
  params.append('return_url', returnUrl);

  const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await response.json();

  if (!response.ok) {
    throw new Error(`Stripe error: ${session.error?.message || 'Unknown error'}`);
  }

  return session.url;
}

// ============================================================
// Feature Gating
// ============================================================

/**
 * Check if a user is on the Pro plan.
 * @param {Object} user - User object with plan field
 * @returns {boolean}
 */
export function isPro(user) {
  return user.plan === 'pro';
}

// ============================================================
// Refunds
// ============================================================

/**
 * Initiate a Stripe refund for a payment intent.
 *
 * @param {Object} env - Worker env bindings (needs STRIPE_SECRET_KEY, DB)
 * @param {string} paymentIntentId - Stripe payment intent ID to refund
 * @returns {Object} Stripe refund object
 */
export async function handleRefund(env, paymentIntentId) {
  const params = new URLSearchParams();
  params.append('payment_intent', paymentIntentId);

  const response = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const refund = await response.json();

  if (!response.ok) {
    throw new Error(`Stripe refund error: ${refund.error?.message || 'Unknown error'}`);
  }

  // Update payment status in database
  await env.DB.prepare(
    `UPDATE payments SET status = 'refunded', refunded_at = datetime('now') WHERE stripe_payment_intent_id = ?`
  ).bind(paymentIntentId).run();

  return refund;
}

// ============================================================
// PayPal Integration
// ============================================================

/**
 * Get the PayPal API base URL based on mode.
 * @param {string} mode - 'sandbox' or 'live'
 * @returns {string} PayPal API base URL
 */
export function getPayPalBaseUrl(mode) {
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * Obtain a PayPal OAuth2 access token using client credentials.
 *
 * @param {string} clientId - PayPal client ID
 * @param {string} clientSecret - PayPal client secret
 * @param {string} mode - 'sandbox' or 'live'
 * @returns {string} Access token
 */
export async function getPayPalAccessToken(clientId, clientSecret, mode) {
  const baseUrl = getPayPalBaseUrl(mode);
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`PayPal auth error: ${data.error_description || data.error || 'Unknown error'}`);
  }

  return data.access_token;
}

/**
 * Create a PayPal order for a paid booking.
 *
 * @param {Object} params
 * @param {string} params.accessToken - PayPal access token
 * @param {string} params.mode - 'sandbox' or 'live'
 * @param {Object} params.eventType - Event type with price_cents, currency, name
 * @param {Object} params.booking - Booking with uid
 * @param {string} params.returnUrl - URL to redirect to after PayPal approval
 * @param {string} params.cancelUrl - URL to redirect to if buyer cancels
 * @returns {Object} { orderId, approvalUrl }
 */
export async function createPayPalOrder({ accessToken, mode, eventType, booking, returnUrl, cancelUrl }) {
  const baseUrl = getPayPalBaseUrl(mode);
  const amount = (eventType.price_cents / 100).toFixed(2);
  const currency = (eventType.currency || 'usd').toUpperCase();

  const orderPayload = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: booking.uid,
      description: eventType.name,
      amount: {
        currency_code: currency,
        value: amount,
      },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          brand_name: 'Calendo',
          user_action: 'PAY_NOW',
        },
      },
    },
  };

  const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(orderPayload),
  });

  const order = await response.json();

  if (!response.ok) {
    throw new Error(`PayPal order error: ${order.message || JSON.stringify(order.details) || 'Unknown error'}`);
  }

  // Find the payer-action link (approval URL)
  const approvalLink = order.links?.find(l => l.rel === 'payer-action');
  if (!approvalLink) {
    throw new Error('PayPal order created but no approval URL returned');
  }

  return {
    orderId: order.id,
    approvalUrl: approvalLink.href,
  };
}

/**
 * Capture a PayPal order after payer approval.
 *
 * @param {Object} params
 * @param {string} params.accessToken - PayPal access token
 * @param {string} params.mode - 'sandbox' or 'live'
 * @param {string} params.orderId - PayPal order ID to capture
 * @returns {Object} Capture result with status and capture details
 */
export async function capturePayPalOrder({ accessToken, mode, orderId }) {
  const baseUrl = getPayPalBaseUrl(mode);

  const response = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const capture = await response.json();

  if (!response.ok) {
    throw new Error(`PayPal capture error: ${capture.message || JSON.stringify(capture.details) || 'Unknown error'}`);
  }

  return capture;
}
