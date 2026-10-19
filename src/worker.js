// Calendo - Scheduling Platform Worker
// Entry point for Cloudflare Workers

import { computeAvailableSlots, computeTeamAvailableSlots, pickRoundRobinMember, dateTimeInTimezoneToUtc } from './availability.js';
import { createCheckoutSession, verifyWebhookSignature, handleRefund, createStripeCustomer, createSubscriptionCheckout, createCustomerPortalSession, isPro, getPayPalAccessToken, createPayPalOrder, capturePayPalOrder } from './payments.js';
import {
  bookingConfirmationEmail,
  hostNotificationEmail,
  guestNotificationEmail,
  cancellationEmail,
  rescheduleEmail,
  reminderEmail,
  reconfirmationEmail,
  passwordResetEmail,
  verificationEmail,
  sendEmail,
} from './email.js';
import { sendSMS } from './sms.js';

// Top-level path segments reserved for the app/system. A booking-page slug can
// never be one of these, so the pretty /<username> route never shadows a real
// page and a host can never claim a system URL.
// Plain email check. Also rejects characters that are legal in exotic quoted
// addresses but have no real-world use and are classic HTML-injection payloads
// (" < > ` \ and brackets/parens/commas/semicolons/colons).
export const EMAIL_RE = /^[^\s@"<>`\\()\[\],;:]+@[^\s@"<>`\\()\[\],;:]+\.[^\s@"<>`\\()\[\],;:]+$/;

const RESERVED_PATHS = new Set([
  'api', 'auth', 'booking', 'dashboard', 'admin', 'team', 'poll', 'routing',
  'onboarding', 'docs', 'embed', 'privacy', 'terms', 'pricing', 'about', 'blog',
  'help', 'support', 'status', 'login', 'signup', 'register', 'logout',
  'settings', 'app', 'account', 's', 'www', 'assets', 'static', 'public', 'index',
]);
function isReservedSlug(s) { return RESERVED_PATHS.has(String(s || '').toLowerCase()); }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);


    // Custom domain support: if hostname is not the default domain,
    // look up booking_pages by custom_domain and rewrite to booking page
    const hostname = url.hostname;
    const isDefaultDomain = hostname.endsWith('.workers.dev') || hostname === 'localhost' || hostname === '127.0.0.1';
    if (!isDefaultDomain && !url.pathname.startsWith('/api/')) {
      try {
        const customPage = await env.DB.prepare(
          'SELECT slug FROM booking_pages WHERE custom_domain = ?'
        ).bind(hostname).first();
        if (customPage) {
          const rewrittenUrl = new URL(request.url);
          rewrittenUrl.pathname = '/booking/';
          rewrittenUrl.searchParams.set('user', customPage.slug);
          return env.ASSETS.fetch(new Request(rewrittenUrl, request));
        }
      } catch (err) {
        console.error('Custom domain lookup error:', err);
      }
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }

    // Embed script: serve with CORS headers so any website can load it
    if (url.pathname === '/embed/calendo-embed.js') {
      const assetRes = await env.ASSETS.fetch(request);
      const response = new Response(assetRes.body, assetRes);
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Content-Type', 'application/javascript; charset=utf-8');
      response.headers.set('Cache-Control', 'public, max-age=3600');
      return response;
    }

    // Payment redirect URLs: /booking/confirmed and /booking/cancelled
    // These don't have their own HTML pages — rewrite to booking page with payment status param
    // Must be checked BEFORE pretty booking URLs to avoid matching "confirmed"/"cancelled" as usernames
    if (url.pathname === '/booking/confirmed' || url.pathname === '/booking/confirmed/') {
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = '/booking/';
      rewrittenUrl.searchParams.set('payment', 'success');
      return env.ASSETS.fetch(new Request(rewrittenUrl, request));
    }
    if (url.pathname === '/booking/cancelled' || url.pathname === '/booking/cancelled/') {
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = '/booking/';
      rewrittenUrl.searchParams.set('payment', 'cancelled');
      return env.ASSETS.fetch(new Request(rewrittenUrl, request));
    }

    // Pretty booking URLs: /booking/USERNAME -> /booking/?user=USERNAME
    const bookingMatch = url.pathname.match(/^\/booking\/([a-z0-9][a-z0-9-]*[a-z0-9])\/?$/i);
    if (bookingMatch) {
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = '/booking/';
      redirectUrl.searchParams.set('user', bookingMatch[1]);
      return Response.redirect(redirectUrl.toString(), 301);
    }

    // Pretty team URLs: /team/ORG-SLUG -> /team/?org=ORG-SLUG
    const teamMatch = url.pathname.match(/^\/team\/([a-z0-9][a-z0-9-]*[a-z0-9])\/?$/i);
    if (teamMatch) {
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = '/team/';
      redirectUrl.searchParams.set('org', teamMatch[1]);
      return Response.redirect(redirectUrl.toString(), 301);
    }

    // /auth/forgot-password is a conventional URL users (and tools) guess, but
    // there is no such page — password reset lives at /auth/reset-password.html.
    // Redirect there instead of falling through to the asset handler (which 500s).
    if (url.pathname === '/auth/forgot-password' || url.pathname === '/auth/forgot-password/') {
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = '/auth/reset-password.html';
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // Pretty top-level booking links (Calendly-style): /<username> and
    // /<username>/<event-slug> serve the booking page directly, keeping the clean
    // URL in the address bar. Only resolves real, non-reserved slugs; the legacy
    // /booking/?user=..&event=.. form still works as an alias.
    const prettyMatch = url.pathname.match(/^\/([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?\/?$/i);
    if (prettyMatch && !isReservedSlug(prettyMatch[1])) {
      try {
        const bp = await env.DB.prepare('SELECT slug FROM booking_pages WHERE slug = ?').bind(prettyMatch[1]).first();
        if (bp) {
          const rewritten = new URL(request.url);
          rewritten.pathname = '/booking/';
          rewritten.searchParams.set('user', prettyMatch[1]);
          if (prettyMatch[2]) rewritten.searchParams.set('event', prettyMatch[2]);
          return env.ASSETS.fetch(new Request(rewritten, request));
        }
      } catch (err) {
        console.error('Pretty booking URL lookup error:', err);
      }
    }

    // Serve static assets with cache-busting for HTML
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('Content-Type') || '';
    if (contentType.includes('text/html')) {
      const newResponse = new Response(assetResponse.body, assetResponse);
      newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      newResponse.headers.set('Pragma', 'no-cache');
      return newResponse;
    }
    return assetResponse;
  },

  async scheduled(event, env, ctx) {
    // A single "*/5 * * * *" cron drives everything, to stay within the
    // account-wide cron-trigger limit. Hourly/daily tasks are gated by the
    // current time inside the 5-minute tick.
    const now = new Date(event.scheduledTime || Date.now());
    const minute = now.getUTCMinutes();
    const hour = now.getUTCHours();
    // Every 5 minutes: reminders, reconfirmations, and email sequences.
    await sendPendingReminders(env);
    // Every 5 minutes: release slots held by abandoned paid checkouts.
    await expireStalePendingPayments(env);
    // ~Top of the hour: sync connected calendars.
    if (minute < 5) await syncCalendars(env);
    // ~Start of the UTC day: cleanup expired sessions and tokens.
    if (hour === 0 && minute < 5) await cleanupExpired(env);
  }
};

// ============================================================
// Rate Limiter (in-memory with periodic cleanup)
// ============================================================

const rateLimitStore = new Map();
let lastRateLimitCleanup = 0;
const SLOT_HOLDING_BOOKING_STATUSES_SQL = "'confirmed', 'pending', 'pending_payment'";

function cleanupRateLimitStore() {
  const now = Date.now();
  if (now - lastRateLimitCleanup < 60000) return;
  lastRateLimitCleanup = now;
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function checkRateLimit(key, limit, windowSeconds) {
  cleanupRateLimitStore();
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt: Math.ceil(resetAt / 1000) };
  }

  entry.count++;
  if (entry.count > limit) {
    return { allowed: false, remaining: 0, resetAt: Math.ceil(entry.resetAt / 1000) };
  }

  return { allowed: true, remaining: limit - entry.count, resetAt: Math.ceil(entry.resetAt / 1000) };
}

function addRateLimitHeaders(response, limit, remaining, resetAt) {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('X-RateLimit-Limit', String(limit));
  newResponse.headers.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  newResponse.headers.set('X-RateLimit-Reset', String(resetAt));
  return newResponse;
}

function getRequestOrigin(request) {
  const originHeader = request.headers.get('Origin');
  if (originHeader) return originHeader;

  const refererHeader = request.headers.get('Referer');
  if (refererHeader) {
    try {
      return new URL(refererHeader).origin;
    } catch {}
  }

  const reqUrl = new URL(request.url);
  const host = request.headers.get('Host');
  if (host) {
    const proto = request.headers.get('X-Forwarded-Proto') || reqUrl.protocol.replace(':', '');
    return `${proto}://${host}`;
  }

  return reqUrl.origin;
}

function rateLimitError(limit, info) {
  const retryAfter = Math.max(1, info.resetAt - Math.ceil(Date.now() / 1000));
  const resp = jsonResponse({
    error: { code: 'RATE_LIMIT_EXCEEDED', message: `Too many requests. Please retry after ${retryAfter} seconds.` }
  }, 429);
  resp.headers.set('Retry-After', String(retryAfter));
  return addCorsHeaders(addRateLimitHeaders(resp, limit, info.remaining, info.resetAt), null);
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0';
}

// ============================================================
// API Router
// ============================================================

async function handleAPI(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const disableRateLimits = env.DISABLE_RATE_LIMITS === '1' || env.DISABLE_RATE_LIMITS === 'true';

  // CORS preflight
  if (method === 'OPTIONS') {
    return corsResponse(request);
  }

  try {
    let response;
    const clientIP = getClientIP(request);
    let rlLimit = 0;
    let rlInfo = null;

    // Determine if this is a public route and apply public rate limit (60/min per IP)
    const isPublicRoute =
      (path === '/api/auth/register' && method === 'POST') ||
      (path === '/api/auth/login' && method === 'POST') ||
      (path === '/api/auth/forgot-password' && method === 'POST') ||
      (path === '/api/auth/reset-password' && method === 'POST') ||
      (path.startsWith('/api/book/') && method === 'POST') ||
      (path.startsWith('/api/booking-page/') && method === 'GET') ||
      (path.startsWith('/api/availability/') && method === 'GET') ||
      (path.match(/^\/api\/bookings\/(by-token|cancel-by-token|reschedule-by-token)\//) !== null) ||
      (path === '/api/ai/chat' && method === 'POST') ||
      (path.match(/^\/api\/polls\/\d+$/) && method === 'GET') ||
      (path.match(/^\/api\/polls\/\d+\/vote$/) && method === 'POST') ||
      (path.startsWith('/api/public/routing/')) ||
      (path.match(/^\/api\/bookings\/\d+\/reconfirm$/) && method === 'GET') ||
      (path === '/api/payments/paypal/capture' && method === 'GET') ||
      (path.match(/^\/api\/link\/[A-Za-z0-9_-]+$/) && method === 'GET') ||
      (path.match(/^\/api\/public\/team\/[^/]+$/) && method === 'GET');

    if (isPublicRoute && !disableRateLimits) {
      rlLimit = 60;
      rlInfo = checkRateLimit(`pub:${clientIP}`, 60, 60);
      if (!rlInfo.allowed) {
        return rateLimitError(rlLimit, rlInfo);
      }
    }

    // Public routes (no auth required)
    if (path === '/api/config' && method === 'GET') {
      response = jsonResponse({
        oauth: {
          google: !!env.GOOGLE_CLIENT_ID,
          microsoft: !!env.MICROSOFT_CLIENT_ID,
        }
      });
    } else if (path === '/api/auth/register' && method === 'POST') {
      response = await handleRegister(request, env);
    } else if (path === '/api/auth/login' && method === 'POST') {
      response = await handleLogin(request, env);
    } else if (path === '/api/auth/forgot-password' && method === 'POST') {
      response = await handleForgotPassword(request, env, url);
    } else if (path === '/api/auth/reset-password' && method === 'POST') {
      response = await handleResetPassword(request, env);
    } else if (path.startsWith('/api/book/') && method === 'POST') {
      response = await handlePublicBooking(request, env, path);
    } else if (path.startsWith('/api/booking-page/') && method === 'GET') {
      response = await handleGetBookingPage(request, env, path);
    } else if (path.startsWith('/api/availability/') && method === 'GET') {
      response = await handleGetPublicAvailability(request, env, url, path);
    }
    // Public booking token routes (cancel/reschedule by invitee)
    else if (path.match(/^\/api\/bookings\/by-token\/[^/]+$/) && method === 'GET') {
      response = await handleGetBookingByToken(request, env, path);
    } else if (path.match(/^\/api\/bookings\/cancel-by-token\/[^/]+$/) && method === 'POST') {
      response = await handleCancelBookingByToken(request, env, path);
    } else if (path.match(/^\/api\/bookings\/reschedule-by-token\/[^/]+$/) && method === 'POST') {
      response = await handleRescheduleBookingByToken(request, env, url, path);
    }
    // Google Calendar OAuth callback (public — user redirected here by Google)
    else if (path === '/api/auth/callback/google-calendar' && method === 'GET') {
      response = await handleGoogleCalendarCallback(request, env, url);
    }
    // OAuth login routes (public — no auth required)
    else if (path === '/api/auth/oauth/google' && method === 'GET') {
      response = await handleGoogleOAuthLogin(request, env, url);
    }
    else if (path === '/api/auth/callback/google' && method === 'GET') {
      response = await handleGoogleOAuthCallback(request, env, url);
    }
    else if (path === '/api/auth/oauth/microsoft' && method === 'GET') {
      response = await handleMicrosoftOAuthLogin(request, env, url);
    }
    else if (path === '/api/auth/callback/microsoft' && method === 'GET') {
      response = await handleMicrosoftOAuthCallback(request, env, url);
    }
    // Outlook Calendar OAuth callback (public — user redirected here by Microsoft)
    else if (path === '/api/auth/callback/outlook-calendar' && method === 'GET') {
      response = await handleOutlookCalendarCallback(request, env, url);
    }
    // Zoom OAuth callback (public — user redirected here by Zoom)
    else if (path === '/api/auth/callback/zoom' && method === 'GET') {
      response = await handleZoomCallback(request, env, url);
    }
    // Zoom webhook (public — Zoom posts events here; verified via x-zm-signature)
    else if (path === '/api/zoom/webhook' && method === 'POST') {
      response = await handleZoomWebhook(request, env);
    }
    // AI chat (public, session-based)
    else if (path === '/api/ai/chat' && method === 'POST') {
      response = await handleAIChat(request, env);
    }
    // Email verification (public — clicked from email)
    else if (path === '/api/auth/verify-email' && method === 'GET') {
      response = await handleVerifyEmail(request, env, url);
    }
    // Stripe webhook (public, no auth — verified by signature)
    else if (path === '/api/stripe/webhook' && method === 'POST') {
      response = await handleStripeWebhook(request, env);
    }
    // Google Calendar push notification webhook (public, no auth — verified by channel headers)
    else if (path === '/api/calendars/webhook/google' && method === 'POST') {
      response = await handleGoogleCalendarWebhook(request, env);
    }
    // Public poll routes (view and vote)
    else if (path.match(/^\/api\/polls\/\d+$/) && method === 'GET') {
      response = await handleGetPublicPoll(request, env, path);
    } else if (path.match(/^\/api\/polls\/\d+\/vote$/) && method === 'POST') {
      response = await handlePollVote(request, env, path);
    }
    // Public routing forms
    else if (path.match(/^\/api\/public\/routing\/[^/]+\/[^/]+$/) && method === 'GET') {
      response = await handleGetPublicRoutingForm(request, env, path);
    } else if (path.match(/^\/api\/public\/routing\/[^/]+\/[^/]+$/) && method === 'POST') {
      response = await handleSubmitRoutingForm(request, env, path);
    }
    // Single-use link resolution (public)
    else if (path.match(/^\/api\/link\/[A-Za-z0-9_-]+$/) && method === 'GET') {
      response = await handleResolveSingleUseLink(request, env, path);
    }
    // Coupon validation (public)
    else if (path.match(/^\/api\/validate-coupon\/[^/]+$/) && method === 'GET') {
      response = await handleValidateCoupon(request, env, url, path);
    }
    // Public team page (org landing page)
    else if (path.match(/^\/api\/public\/team\/[^/]+$/) && method === 'GET') {
      response = await handleGetTeamPage(request, env, path);
    }
    // Booking reconfirmation (public — invitee clicks link in email)
    else if (path.match(/^\/api\/bookings\/\d+\/reconfirm$/) && method === 'GET') {
      response = await handleReconfirmBooking(request, env, url, path);
    }
    // PayPal capture return (public — invitee returns from PayPal after approval)
    else if (path === '/api/payments/paypal/capture' && method === 'GET') {
      response = await handlePayPalCapture(request, env, url);
    }
    // Protected routes (auth required)
    else {
      const user = await authenticate(request, env);
      if (!user) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // Rate limit authenticated endpoints: 300/min per user
      rlLimit = 300;
      rlInfo = checkRateLimit(`auth:${user.id}`, 300, 60);
      if (!rlInfo.allowed) {
        return rateLimitError(rlLimit, rlInfo);
      }

      // Auth
      if (path === '/api/auth/logout' && method === 'POST') {
        response = await handleLogout(request, env, user);
      } else if (path === '/api/auth/delete-account' && method === 'DELETE') {
        response = await handleDeleteAccount(request, env, user);
      } else if (path === '/api/auth/me' && method === 'GET') {
        const { password_hash, ...safeUser } = user;
        response = jsonResponse(safeUser);
      }
      // Slot debug: why is a time unavailable? Host-only — it reveals exact busy
      // windows from the host's private Google/Outlook calendars.
      else if (path.startsWith('/api/slot-debug/') && method === 'GET') {
        response = await handleSlotDebug(request, env, url, path, user);
      }
      // Event Types
      else if (path === '/api/event-types' && method === 'GET') {
        response = await handleListEventTypes(request, env, user);
      } else if (path === '/api/event-types' && method === 'POST') {
        response = await handleCreateEventType(request, env, user);
      } else if (path.match(/^\/api\/event-types\/\d+$/) && method === 'GET') {
        response = await handleGetEventType(request, env, user, path);
      } else if (path.match(/^\/api\/event-types\/\d+$/) && method === 'PUT') {
        response = await handleUpdateEventType(request, env, user, path);
      } else if (path.match(/^\/api\/event-types\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteEventType(request, env, user, path);
      }
      // Availability Schedules
      else if (path === '/api/availability-schedules' && method === 'GET') {
        response = await handleListAvailabilitySchedules(request, env, user);
      } else if (path === '/api/availability-schedules' && method === 'POST') {
        response = await handleCreateAvailabilitySchedule(request, env, user);
      } else if (path.match(/^\/api\/availability-schedules\/\d+$/) && method === 'PUT') {
        response = await handleUpdateAvailabilitySchedule(request, env, user, path);
      } else if (path.match(/^\/api\/availability-schedules\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteAvailabilitySchedule(request, env, user, path);
      }
      // Bookings
      else if (path === '/api/bookings' && method === 'GET') {
        response = await handleListBookings(request, env, user);
      } else if (path.match(/^\/api\/bookings\/\d+\/cancel$/) && method === 'POST') {
        response = await handleCancelBooking(request, env, user, path);
      } else if (path.match(/^\/api\/bookings\/\d+\/no-show$/) && method === 'POST') {
        response = await handleMarkNoShow(request, env, user, path);
      } else if (path.match(/^\/api\/bookings\/\d+\/notes$/) && method === 'PUT') {
        response = await handleUpdateBookingNotes(request, env, user, path);
      }
      // Booking Page
      else if (path === '/api/booking-page' && method === 'GET') {
        response = await handleGetMyBookingPage(request, env, user);
      } else if (path === '/api/booking-page' && method === 'PUT') {
        response = await handleUpdateBookingPage(request, env, user);
      }
      // Webhooks
      else if (path === '/api/webhooks' && method === 'GET') {
        response = await handleListWebhooks(request, env, user);
      } else if (path === '/api/webhooks' && method === 'POST') {
        response = await handleCreateWebhook(request, env, user);
      } else if (path.match(/^\/api\/webhooks\/\d+$/) && method === 'PUT') {
        response = await handleUpdateWebhook(request, env, user, path);
      } else if (path.match(/^\/api\/webhooks\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteWebhook(request, env, user, path);
      }
      // Calendar Connections
      else if (path === '/api/calendars' && method === 'GET') {
        response = await handleListCalendarConnections(request, env, user);
      } else if (path === '/api/calendars/sync' && method === 'POST') {
        response = await handleSyncUserCalendar(request, env, user);
      } else if (path === '/api/calendars/connect/google' && method === 'GET') {
        response = await handleGoogleCalendarOAuth(request, env, user);
      } else if (path === '/api/calendars/connect/outlook' && method === 'GET') {
        response = await handleOutlookCalendarOAuth(request, env, user);
      } else if (path === '/api/calendars/connect/apple' && method === 'POST') {
        response = await handleAppleCalendarConnect(request, env, user);
      } else if (path.match(/^\/api\/calendars\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteCalendarConnection(request, env, user, path);
      } else if (path.match(/^\/api\/calendars\/\d+\/primary$/) && method === 'PUT') {
        response = await handleSetPrimaryCalendar(request, env, user, path);
      } else if (path.match(/^\/api\/calendars\/\d+\/settings$/) && method === 'PUT') {
        response = await handleUpdateCalendarSettings(request, env, user, path);
      }
      // Zoom (per-user OAuth)
      else if (path === '/api/zoom/connect' && method === 'GET') {
        response = await handleZoomOAuth(request, env, user);
      } else if (path === '/api/zoom/status' && method === 'GET') {
        response = await handleZoomStatus(request, env, user);
      } else if (path === '/api/zoom/disconnect' && method === 'POST') {
        response = await handleZoomDisconnect(request, env, user);
      }
      // Stripe Payments
      else if (path === '/api/stripe/create-checkout' && method === 'POST') {
        response = await handleCreateCheckout(request, env, user);
      } else if (path === '/api/stripe/create-subscription' && method === 'POST') {
        response = await handleCreateSubscription(request, env, user);
      } else if (path === '/api/stripe/customer-portal' && method === 'POST') {
        response = await handleCustomerPortal(request, env, user);
      } else if (path === '/api/payments' && method === 'GET') {
        response = await handleListPayments(request, env, user);
      } else if (path.match(/^\/api\/bookings\/\d+\/refund$/) && method === 'POST') {
        response = await handleBookingRefund(request, env, user, path);
      }
      // API Keys
      else if (path === '/api/api-keys' && method === 'GET') {
        response = await handleListApiKeys(request, env, user);
      } else if (path === '/api/api-keys' && method === 'POST') {
        response = await handleCreateApiKey(request, env, user);
      } else if (path.match(/^\/api\/api-keys\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteApiKey(request, env, user, path);
      }
      // Organizations
      else if (path === '/api/organizations' && method === 'POST') {
        response = await handleCreateOrganization(request, env, user);
      } else if (path === '/api/organizations' && method === 'GET') {
        response = await handleListOrganizations(request, env, user);
      } else if (path.match(/^\/api\/organizations\/\d+$/) && method === 'GET') {
        response = await handleGetOrganization(request, env, user, path);
      } else if (path.match(/^\/api\/organizations\/\d+$/) && method === 'PUT') {
        response = await handleUpdateOrganization(request, env, user, path);
      } else if (path.match(/^\/api\/organizations\/\d+\/invite$/) && method === 'POST') {
        response = await handleInviteMember(request, env, user, path);
      } else if (path.match(/^\/api\/organizations\/\d+\/members\/\d+$/) && method === 'DELETE') {
        response = await handleRemoveMember(request, env, user, path);
      } else if (path.match(/^\/api\/organizations\/\d+\/members\/\d+$/) && method === 'PUT') {
        response = await handleUpdateMemberRole(request, env, user, path);
      }
      // Analytics
      else if (path === '/api/analytics' && method === 'GET') {
        response = await handleAnalytics(request, env, user);
      } else if (path === '/api/analytics/export' && method === 'GET') {
        response = await handleAnalyticsExport(request, env, user, url);
      }
      // Combined calendar view
      else if (path === '/api/calendar-view' && method === 'GET') {
        response = await handleCalendarView(request, env, user, url);
      }
      // Polls (authenticated)
      else if (path === '/api/polls' && method === 'POST') {
        response = await handleCreatePoll(request, env, user);
      } else if (path === '/api/polls' && method === 'GET') {
        response = await handleListPolls(request, env, user);
      } else if (path.match(/^\/api\/polls\/\d+\/finalize$/) && method === 'POST') {
        response = await handleFinalizePoll(request, env, user, path);
      }
      // Routing Forms
      else if (path === '/api/routing-forms' && method === 'GET') {
        response = await handleListRoutingForms(request, env, user);
      } else if (path === '/api/routing-forms' && method === 'POST') {
        response = await handleCreateRoutingForm(request, env, user);
      } else if (path.match(/^\/api\/routing-forms\/\d+$/) && method === 'GET') {
        response = await handleGetRoutingForm(request, env, user, path);
      } else if (path.match(/^\/api\/routing-forms\/\d+$/) && method === 'PUT') {
        response = await handleUpdateRoutingForm(request, env, user, path);
      } else if (path.match(/^\/api\/routing-forms\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteRoutingForm(request, env, user, path);
      }
      // Routing analytics
      else if (path === '/api/routing-analytics' && method === 'GET') {
        response = await handleRoutingAnalytics(request, env, user);
      }
      // Contacts
      else if (path === '/api/contacts' && method === 'GET') {
        response = await handleListContacts(request, env, user);
      }
      // Dashboard AI Assistant
      else if (path === '/api/ai/dashboard' && method === 'POST') {
        response = await handleDashboardAI(request, env, user);
      }
      // Feedback
      else if (path === '/api/feedback' && method === 'POST') {
        response = await handleSubmitFeedback(request, env, user);
      } else if (path === '/api/feedback' && method === 'GET') {
        response = await handleListFeedback(request, env, user);
      }
      // Admin
      else if (path === '/api/admin/stats' && method === 'GET') {
        response = await handleAdminStats(request, env, user);
      } else if (path === '/api/admin/users' && method === 'GET') {
        response = await handleAdminUsers(request, env, user, url);
      } else if (path === '/api/admin/audit-log' && method === 'GET') {
        response = await handleAdminAuditLog(request, env, user, url);
      }
      // Audit log
      else if (path === '/api/audit-log' && method === 'GET') {
        response = await handleGetAuditLog(request, env, user, url);
      }
      // Book on behalf
      else if (path === '/api/book-on-behalf' && method === 'POST') {
        response = await handleBookOnBehalf(request, env, user);
      }
      // Email sequences
      else if (path === '/api/email-sequences' && method === 'GET') {
        response = await handleListEmailSequences(request, env, user);
      } else if (path === '/api/email-sequences' && method === 'POST') {
        response = await handleCreateEmailSequence(request, env, user);
      } else if (path.match(/^\/api\/email-sequences\/\d+$/) && method === 'PUT') {
        response = await handleUpdateEmailSequence(request, env, user, path);
      } else if (path.match(/^\/api\/email-sequences\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteEmailSequence(request, env, user, path);
      }
      // BYOK (Bring Your Own API Key)
      else if (path === '/api/settings/ai-key' && method === 'PUT') {
        response = await handleUpdateAIKey(request, env, user);
      } else if (path === '/api/settings/ai-key' && method === 'DELETE') {
        response = await handleDeleteAIKey(request, env, user);
      }
      // Holiday presets
      else if (path === '/api/holidays/presets' && method === 'GET') {
        response = await handleGetHolidayPresets(url);
      }
      // Single-use links
      else if (path === '/api/single-use-links' && method === 'POST') {
        response = await handleCreateSingleUseLink(request, env, user);
      } else if (path === '/api/single-use-links' && method === 'GET') {
        response = await handleListSingleUseLinks(request, env, user);
      } else if (path.match(/^\/api\/single-use-links\/\d+$/) && method === 'DELETE') {
        response = await handleRevokeSingleUseLink(request, env, user, path);
      }
      // Coupons
      else if (path === '/api/coupons' && method === 'POST') {
        response = await handleCreateCoupon(request, env, user);
      } else if (path === '/api/coupons' && method === 'GET') {
        response = await handleListCoupons(request, env, user);
      } else if (path.match(/^\/api\/coupons\/\d+$/) && method === 'PUT') {
        response = await handleUpdateCoupon(request, env, user, path);
      } else if (path.match(/^\/api\/coupons\/\d+$/) && method === 'DELETE') {
        response = await handleDeleteCoupon(request, env, user, path);
      }
      // Slack webhook settings
      else if (path === '/api/settings/slack-webhook' && method === 'PUT') {
        response = await handleUpdateSlackWebhook(request, env, user);
      } else if (path === '/api/settings/slack-webhook/test' && method === 'POST') {
        response = await handleTestSlackWebhook(request, env, user);
      }
      // PayPal credentials settings
      else if (path === '/api/settings/paypal' && method === 'PUT') {
        response = await handleUpdatePayPalSettings(request, env, user);
      } else if (path === '/api/settings/paypal' && method === 'DELETE') {
        response = await handleDeletePayPalSettings(request, env, user);
      }
      // Onboarding
      else if (path === '/api/onboarding/complete' && method === 'POST') {
        await env.DB.prepare("UPDATE users SET onboarding_completed = 1, updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
        response = jsonResponse({ ok: true });
      }
      // Schedule setup dismissed
      else if (path === '/api/schedule-setup/dismiss' && method === 'POST') {
        await env.DB.prepare("UPDATE users SET schedule_setup_dismissed = 1, updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
        response = jsonResponse({ ok: true });
      }
      // Product tour completed (first-login guided walkthrough seen)
      else if (path === '/api/product-tour/complete' && method === 'POST') {
        await env.DB.prepare("UPDATE users SET product_tour_completed = 1, updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
        response = jsonResponse({ ok: true });
      }
      // AI chat state (persist across browsers)
      else if (path === '/api/ai/chat-state' && method === 'GET') {
        const row = await env.DB.prepare('SELECT ai_session_id, ai_chat_history FROM users WHERE id = ?').bind(user.id).first();
        response = jsonResponse({
          session_id: row?.ai_session_id || null,
          chat_history: row?.ai_chat_history ? JSON.parse(row.ai_chat_history) : [],
        });
      } else if (path === '/api/ai/chat-state' && method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!body) { response = jsonResponse({ error: 'Invalid JSON' }, 400); }
        else {
          await env.DB.prepare("UPDATE users SET ai_session_id = ?, ai_chat_history = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(body.session_id || null, JSON.stringify((body.chat_history || []).slice(-30)), user.id).run();
          response = jsonResponse({ ok: true });
        }
      }
      else if (path === '/api/checklist-state' && method === 'GET') {
        const row = await env.DB.prepare('SELECT checklist_state FROM users WHERE id = ?').bind(user.id).first();
        response = jsonResponse({ state: row?.checklist_state ? JSON.parse(row.checklist_state) : {} });
      } else if (path === '/api/checklist-state' && method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!body) { response = jsonResponse({ error: 'Invalid JSON' }, 400); }
        else {
          await env.DB.prepare("UPDATE users SET checklist_state = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(JSON.stringify(body.state || {}), user.id).run();
          response = jsonResponse({ ok: true });
        }
      }
      // Email verification (resend — authenticated)
      else if (path === '/api/auth/resend-verification' && method === 'POST') {
        response = await handleResendVerification(request, env, user, url);
      }
      else {
        response = jsonResponse({ error: 'Not found' }, 404);
      }
    }

    // Add rate limit headers to all responses
    if (rlInfo) {
      addRateLimitHeaders(response, rlLimit, rlInfo.remaining, rlInfo.resetAt);
    }

    return addCorsHeaders(response, request);
  } catch (err) {
    console.error('API error:', err);
    return addCorsHeaders(jsonResponse({ error: 'Internal server error' }, 500), request);
  }
}

// ============================================================
// Auth Handlers
// ============================================================

async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { email, password, name, timezone } = body;
  if (!email || !password || !name) {
    return jsonResponse({ error: 'Email, password, and name are required' }, 400);
  }

  // Validate email format
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400);
  }

  // Validate password strength
  if (password.length < 8) {
    return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
  }

  // Check if email already exists
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
  if (existing) {
    return jsonResponse({ error: 'Email already registered' }, 409);
  }

  // Hash password with PBKDF2
  const passwordHash = await hashPassword(password);

  // Test/CI only: auto-confirm the account (verified + onboarded) so the headless
  // e2e — which cannot receive a verification email — can reach the dashboard.
  // Gated strictly on AUTH_AUTOCONFIRM, which is set only in scripts/local-test.env;
  // it is NEVER set in production, so real signups stay unverified + un-onboarded.
  const autoConfirm = env.AUTH_AUTOCONFIRM === '1';

  // Create user
  const userResult = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, name, timezone, email_verified, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, email, name, timezone, avatar_url, created_at, email_verified'
  ).bind(email.toLowerCase(), passwordHash, name.trim(), timezone || 'America/Los_Angeles', autoConfirm ? 1 : 0, autoConfirm ? 1 : 0).first();

  // Set up booking page, availability, and default event type
  const uniqueSlug = await setupNewUserDefaults(env, userResult.id, name);

  // Create session
  const session = await createSession(env, userResult.id);

  // Send verification email (skipped when auto-confirmed) — non-blocking
  if (!autoConfirm) try {
    const verifyToken = crypto.randomUUID();
    const verifyExpiresAt = formatDbTimestamp(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Ensure email_verification_tokens table exists
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`).run();

    await env.DB.prepare(
      'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).bind(userResult.id, verifyToken, verifyExpiresAt).run();

    const origin = new URL(request.url).origin;
    const verifyUrl = `${origin}/api/auth/verify-email?token=${verifyToken}`;

    const emailData = verificationEmail(verifyUrl);
    await sendEmail(env, {
      to: email.toLowerCase(),
      subject: emailData.subject,
      html: emailData.html,
      text: emailData.text,
      type: 'verification',
    });
  } catch (verifyErr) {
    console.error('Failed to send verification email:', verifyErr);
  }

  const response = jsonResponse({ user: userResult, bookingSlug: uniqueSlug }, 201);
  response.headers.set('Set-Cookie', sessionCookie(session.token, session.expires_at, request));
  return response;
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { email, password } = body;
  if (!email || !password) {
    return jsonResponse({ error: 'Email and password are required' }, 400);
  }

  // Find user
  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, name, timezone, avatar_url, created_at FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first();

  if (!user) {
    return jsonResponse({ error: 'Invalid email or password' }, 401);
  }

  // Verify password
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return jsonResponse({ error: 'Invalid email or password' }, 401);
  }

  // Create session
  const session = await createSession(env, user.id);

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'user.login', 'user', user.id, { email: user.email }, clientIP);

  const { password_hash, ...safeUser } = user;
  const response = jsonResponse({ user: safeUser });
  response.headers.set('Set-Cookie', sessionCookie(session.token, session.expires_at, request));
  return response;
}

async function handleForgotPassword(request, env, url) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { email } = body;
  if (!email) {
    return jsonResponse({ error: 'Email is required' }, 400);
  }

  // Always return 200 to prevent email enumeration
  const successMsg = { ok: true, message: 'If an account exists with this email, a reset link has been sent.' };

  // Look up user
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email.toLowerCase()).first();
  if (!user) {
    return jsonResponse(successMsg);
  }

  // Ensure password_reset_tokens table exists
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`).run();

  // Invalidate any existing unused tokens for this user
  await env.DB.prepare(
    'UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0'
  ).bind(user.id).run();

  // Generate reset token
  const token = crypto.randomUUID();
  const expiresAt = formatDbTimestamp(Date.now() + 60 * 60 * 1000); // 1 hour

  await env.DB.prepare(
    'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).bind(user.id, token, expiresAt).run();

  // Build reset URL
  const origin = url.origin || 'https://calendo.dev';
  const resetUrl = `${origin}/auth/reset-password.html?token=${token}`;

  // Send reset email
  const emailData = passwordResetEmail(resetUrl);
  await sendEmail(env, {
    to: user.email,
    subject: emailData.subject,
    html: emailData.html,
    text: emailData.text,
    type: 'password_reset',
  });

  return jsonResponse(successMsg);
}

async function handleResetPassword(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { token, password } = body;
  if (!token || !password) {
    return jsonResponse({ error: 'Token and password are required' }, 400);
  }

  if (password.length < 8) {
    return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
  }

  // Look up token
  const resetToken = await env.DB.prepare(
    'SELECT id, user_id, token, expires_at, used FROM password_reset_tokens WHERE token = ?'
  ).bind(token).first();

  if (!resetToken) {
    return jsonResponse({ error: 'Invalid or expired reset token' }, 400);
  }

  if (resetToken.used) {
    return jsonResponse({ error: 'This reset token has already been used' }, 400);
  }

  // Check expiry
  const now = new Date();
  const expiresAt = new Date(resetToken.expires_at);
  if (now > expiresAt) {
    return jsonResponse({ error: 'This reset token has expired' }, 400);
  }

  // Hash new password
  const passwordHash = await hashPassword(password);

  // Update user's password
  await env.DB.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
  ).bind(passwordHash, formatDbTimestamp(), resetToken.user_id).run();

  // Mark token as used
  await env.DB.prepare(
    'UPDATE password_reset_tokens SET used = 1 WHERE id = ?'
  ).bind(resetToken.id).run();

  // Invalidate all sessions for the user (security: force re-login)
  await env.DB.prepare(
    'DELETE FROM sessions WHERE user_id = ?'
  ).bind(resetToken.user_id).run();

  // A Microsoft identity never proved it owns this email (see resolveOAuthLogin),
  // so after the real owner proves it via reset, drop any such link. This closes
  // "pre-registration" hijacks where someone created the account first.
  await env.DB.prepare(
    "DELETE FROM oauth_identities WHERE user_id = ? AND provider = 'microsoft'"
  ).bind(resetToken.user_id).run();

  return jsonResponse({ ok: true, message: 'Password has been reset successfully. Please log in with your new password.' });
}

async function handleLogout(request, env, user) {
  const cookie = request.headers.get('Cookie') || '';
  const sessionMatch = cookie.match(/session=([^;]+)/);
  if (sessionMatch) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(sessionMatch[1]).run();
  }
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'user.logout', 'user', user.id, {}, clientIP);
  const response = jsonResponse({ ok: true });
  response.headers.set('Set-Cookie', clearSessionCookie(request));
  return response;
}

// Best-effort revoke of a user's Zoom OAuth grant (so the app is removed from
// their Zoom connected apps, not just forgotten locally). Never throws.
async function revokeZoomGrant(env, userId) {
  if (!isZoomOAuthConfigured(env)) return;
  const conn = await env.DB.prepare('SELECT access_token_encrypted FROM zoom_connections WHERE user_id = ?').bind(userId).first();
  if (!conn) return;
  const accessToken = await decryptToken(conn.access_token_encrypted, env.ENCRYPTION_KEY);
  const credentials = btoa(`${env.ZOOM_OAUTH_CLIENT_ID}:${env.ZOOM_OAUTH_CLIENT_SECRET}`);
  await fetch('https://zoom.us/oauth/revoke', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: accessToken }),
  });
}

// Permanently delete a user and ALL of their data. Runs as a SINGLE atomic D1
// batch (a transaction) so a partial failure can never again strand a user in a
// "logged out but not deleted" state — previously, sessions were deleted first
// and a later failing delete (e.g. a table missing from the list, like the new
// zoom_connections) left the account intact but signed out, so re-login found the
// old account and skipped onboarding. Children are deleted before their parents
// so no foreign key blocks the final user-row delete. External OAuth grants are
// revoked first, best-effort, so a revoke failure never aborts the deletion.
async function deleteAllUserData(env, userId) {
  try { await revokeAllCalendarGrants(env, userId); } catch (e) { console.error('Calendar grant revoke failed (continuing):', e); }
  try { await revokeZoomGrant(env, userId); } catch (e) { console.error('Zoom grant revoke failed (continuing):', e); }

  const stmt = (sql) => env.DB.prepare(sql).bind(userId);
  await env.DB.batch([
    // Rows tied to the user's bookings/event types first (child-first order).
    // NOTE: bookings are reached via event_type_id only — the bookings table has
    // no user_id column on production (schema.sql lists one but the live DB never
    // got it), so referencing bookings.user_id throws "no such column" and 500s
    // the whole delete. Every host booking is reachable through its event type.
    stmt('DELETE FROM notification_log WHERE booking_id IN (SELECT id FROM bookings WHERE event_type_id IN (SELECT id FROM event_types WHERE user_id = ?))'),
    stmt('DELETE FROM bookings WHERE event_type_id IN (SELECT id FROM event_types WHERE user_id = ?)'),
    stmt('DELETE FROM workflow_actions WHERE event_type_id IN (SELECT id FROM event_types WHERE user_id = ?)'),
    stmt('DELETE FROM event_types WHERE user_id = ?'),
    stmt('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM meeting_polls WHERE user_id = ?)'),
    stmt('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM meeting_polls WHERE user_id = ?)'),
    stmt('DELETE FROM meeting_polls WHERE user_id = ?'),
    stmt('DELETE FROM routing_form_submissions WHERE routing_form_id IN (SELECT id FROM routing_forms WHERE user_id = ?)'),
    stmt('DELETE FROM routing_forms WHERE user_id = ?'),
    stmt('DELETE FROM email_sequence_log WHERE sequence_id IN (SELECT id FROM email_sequences WHERE user_id = ?)'),
    stmt('DELETE FROM email_sequences WHERE user_id = ?'),
    stmt('DELETE FROM ai_conversations WHERE booking_page_id IN (SELECT id FROM booking_pages WHERE user_id = ?)'),
    stmt('DELETE FROM booking_pages WHERE user_id = ?'),
    stmt('DELETE FROM availability_schedules WHERE user_id = ?'),
    stmt('DELETE FROM calendar_connections WHERE user_id = ?'),
    stmt('DELETE FROM zoom_connections WHERE user_id = ?'),
    stmt('DELETE FROM oauth_identities WHERE user_id = ?'),
    stmt('DELETE FROM webhooks WHERE user_id = ?'),
    stmt('DELETE FROM api_keys WHERE user_id = ?'),
    stmt('DELETE FROM coupons WHERE user_id = ?'),
    stmt('DELETE FROM single_use_links WHERE user_id = ?'),
    stmt('DELETE FROM feedback WHERE user_id = ?'),
    stmt('DELETE FROM calendar_sync_errors WHERE user_id = ?'),
    stmt('DELETE FROM email_verification_tokens WHERE user_id = ?'),
    stmt('DELETE FROM password_reset_tokens WHERE user_id = ?'),
    stmt('DELETE FROM audit_log WHERE user_id = ?'),
    // Orgs: drop orgs the user owns (cascades that org's members + invitations),
    // plus this user's own membership. (org_invitations has no FK to users — it's
    // org-scoped and cascades from the org via org_id — so nothing to delete here.)
    stmt('DELETE FROM organizations WHERE owner_id = ?'),
    stmt('DELETE FROM org_members WHERE user_id = ?'),
    // Sessions, then the user row — last.
    stmt('DELETE FROM sessions WHERE user_id = ?'),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

async function handleDeleteAccount(request, env, user) {
  await deleteAllUserData(env, user.id);
  const response = jsonResponse({ ok: true, message: 'Account deleted' });
  response.headers.set('Set-Cookie', clearSessionCookie(request));
  return response;
}

// ============================================================
// OAuth Login Handlers
// ============================================================

async function handleGoogleOAuthLogin(request, env, url) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return jsonResponse({ error: 'Google OAuth is not configured' }, 500);

  const origin = env.APP_ORIGIN || url.origin;
  const redirectUri = origin + '/api/auth/callback/google';
  // ALWAYS request Google Calendar access in the same sign-in consent (Calendly-
  // style), for both the "Sign up" and "Sign in" buttons. This way a first-time
  // Google user grants calendar once during sign-in — the callback connects it and
  // drops them onto onboarding step 2, instead of landing on step 1 and being made
  // to pick their Google account a second time. Google shows calendar as an
  // optional checkbox, so declining still completes sign-in (then they get the
  // in-app "Connect your calendar" step); and returning users who already granted
  // it are not re-prompted.
  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    // offline so we receive a refresh token for ongoing calendar sync.
    access_type: 'offline',
    prompt: 'select_account',
    state: await generateOAuthState(env, 'login'),
  });

  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(), 302);
}

// Map an OAuth login to a Calendo account.
//  1. Known identity (provider + stable subject id) -> that account.
//  2. Unknown identity, email belongs to an existing account -> link ONLY when the
//     provider verified the email; otherwise refuse (the person signs in the way
//     they originally signed up, or resets their password).
//  3. Unknown identity, unknown email -> new account bound to this identity.
// Matching on email alone let anyone who could make a provider assert a victim's
// address log in as the victim.
export async function resolveOAuthLogin(env, { provider, subject, email, emailVerified, name, avatarUrl }) {
  if (!subject) return { error: 'userinfo_failed' };
  subject = String(subject);

  const linked = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.timezone FROM oauth_identities oi
     JOIN users u ON u.id = oi.user_id WHERE oi.provider = ? AND oi.subject = ?`
  ).bind(provider, subject).first();
  if (linked) return { user: linked, isNewUser: false };

  const existing = await env.DB.prepare('SELECT id, email, name, timezone FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    if (!emailVerified) return { error: 'account_exists' };
    await env.DB.prepare(
      'INSERT OR IGNORE INTO oauth_identities (user_id, provider, subject, email) VALUES (?, ?, ?, ?)'
    ).bind(existing.id, provider, subject, email).run();
    return { user: existing, isNewUser: false };
  }

  const dummyHash = `oauth:${provider}:` + crypto.randomUUID();
  const user = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, name, timezone, avatar_url, email_verified) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, email, name, timezone'
  ).bind(email, dummyHash, name, 'America/Los_Angeles', avatarUrl, emailVerified ? 1 : 0).first();
  await env.DB.prepare(
    'INSERT INTO oauth_identities (user_id, provider, subject, email) VALUES (?, ?, ?, ?)'
  ).bind(user.id, provider, subject, email).run();
  await setupNewUserDefaults(env, user.id, name);
  return { user, isNewUser: true };
}

async function handleGoogleOAuthCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const origin = env.APP_ORIGIN || url.origin;

  if (error || !code) {
    return Response.redirect(origin + '/auth/login.html?error=oauth_failed', 302);
  }

  // Verify OAuth state
  const statePayload = await verifyOAuthState(env, state);
  if (!statePayload || statePayload !== 'login') {
    return Response.redirect(origin + '/auth/login.html?error=invalid_state', 302);
  }

  const redirectUri = origin + '/api/auth/callback/google';
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Google OAuth token exchange failed:', await tokenResponse.text());
    return Response.redirect(origin + '/auth/login.html?error=token_exchange_failed', 302);
  }

  const tokens = await tokenResponse.json();

  const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
  });

  if (!userinfoResponse.ok) {
    return Response.redirect(origin + '/auth/login.html?error=userinfo_failed', 302);
  }

  const userinfo = await userinfoResponse.json();
  const email = userinfo.email?.toLowerCase();
  const name = userinfo.name || email.split('@')[0];

  if (!email) {
    return Response.redirect(origin + '/auth/login.html?error=no_email', 302);
  }

  const resolved = await resolveOAuthLogin(env, {
    provider: 'google',
    subject: userinfo.id,
    email,
    // Google sets verified_email=false for addresses it has not confirmed.
    emailVerified: userinfo.verified_email === true,
    name,
    avatarUrl: userinfo.picture || null,
  });
  if (resolved.error) {
    return Response.redirect(origin + '/auth/login.html?error=' + resolved.error, 302);
  }
  const { user, isNewUser } = resolved;

  // If calendar access was granted in the same consent (combined signup),
  // connect Google Calendar now so the user skips the separate "Connect your
  // calendar" onboarding step. Calendar is an optional checkbox on Google's
  // consent screen, so this only runs when the scope was actually granted.
  let calendarConnected = false;
  const grantedScopes = (tokens.scope || '').split(/\s+/);
  const hasCalendarScope =
    grantedScopes.includes('https://www.googleapis.com/auth/calendar.readonly') ||
    grantedScopes.includes('https://www.googleapis.com/auth/calendar.events');
  if (hasCalendarScope && tokens.access_token) {
    try {
      const existingConn = await env.DB.prepare(
        'SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND email = ?'
      ).bind(user.id, 'google', email).first();
      if (existingConn) {
        // Already connected for this account — nothing to do. Do NOT set the
        // connected flag: it would flash a misleading "Calendar connected!" toast
        // on every Google login for returning users now that login requests the
        // calendar scope.
      } else {
        const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
        const refreshTokenEncrypted = tokens.refresh_token
          ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY) : null;
        const expiresAt = tokens.expires_in
          ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000) : null;
        const existingPrimary = await env.DB.prepare(
          'SELECT id FROM calendar_connections WHERE user_id = ? AND is_primary = 1'
        ).bind(user.id).first();
        const isPrimary = existingPrimary ? 0 : 1;
        await env.DB.prepare(
          'INSERT INTO calendar_connections (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, email, calendar_id, is_primary, check_conflicts, write_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(user.id, 'google', accessTokenEncrypted, refreshTokenEncrypted, expiresAt, email, 'primary', isPrimary, 1, isPrimary).run();
        calendarConnected = true;
        try {
          const savedConnection = await env.DB.prepare(
            'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? ORDER BY id DESC LIMIT 1'
          ).bind(user.id, 'google').first();
          if (savedConnection) await setupGoogleCalendarWatch(env, savedConnection, tokens.access_token);
        } catch (watchErr) {
          console.error('Failed to setup Google Calendar watch after signup connect:', watchErr);
        }
        await logAuditEvent(env.DB, user.id, 'calendar.connected', 'calendar_connection', null, { provider: 'google', email, via: 'oauth_signup' }, null);
      }
    } catch (connErr) {
      console.error('Auto-connect Google Calendar at signup failed:', connErr);
    }
  }

  const session = await createSession(env, user.id);
  let redirectTo = isNewUser ? '/dashboard/?welcome=1' : '/dashboard/';
  if (calendarConnected) {
    redirectTo += redirectTo.includes('?') ? '&calendar=connected' : '?calendar=connected';
  }
  const response = Response.redirect(origin + redirectTo, 302);
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Set-Cookie', sessionCookie(session.token, session.expires_at, request));
  return newResponse;
}

async function handleMicrosoftOAuthLogin(request, env, url) {
  const clientId = env.MICROSOFT_CLIENT_ID;
  if (!clientId) return jsonResponse({ error: 'Microsoft OAuth is not configured' }, 500);

  const origin = env.APP_ORIGIN || url.origin;
  const redirectUri = origin + '/api/auth/callback/microsoft';
  // At signup, request Outlook calendar access in the SAME Microsoft consent
  // (parity with the Google combined signup). Unlike Google's optional
  // checkbox, Microsoft consent is all-or-nothing — declining cancels sign-in.
  // Plain login stays identity-only so returning users aren't re-prompted.
  const isSignup = url.searchParams.get('intent') === 'signup';
  const scopes = [
    'openid', 'email', 'profile', 'User.Read',
    ...(isSignup ? ['offline_access', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'] : []),
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    response_mode: 'query',
    state: await generateOAuthState(env, isSignup ? 'msignup' : 'login'),
  });

  return Response.redirect('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + params.toString(), 302);
}

async function handleMicrosoftOAuthCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const origin = env.APP_ORIGIN || url.origin;

  if (error || !code) {
    return Response.redirect(origin + '/auth/login.html?error=oauth_failed', 302);
  }

  const statePayload = await verifyOAuthState(env, state);
  if (!statePayload || (statePayload !== 'login' && statePayload !== 'msignup')) {
    return Response.redirect(origin + '/auth/login.html?error=invalid_state', 302);
  }
  const isSignup = statePayload === 'msignup';

  const redirectUri = origin + '/api/auth/callback/microsoft';
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      // Match the authorized scopes so the signup token also carries calendar access.
      scope: isSignup
        ? 'openid email profile User.Read offline_access Calendars.ReadWrite OnlineMeetings.ReadWrite'
        : 'openid email profile User.Read',
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Microsoft OAuth token exchange failed:', await tokenResponse.text());
    return Response.redirect(origin + '/auth/login.html?error=token_exchange_failed', 302);
  }

  const tokens = await tokenResponse.json();

  const meResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
  });

  if (!meResponse.ok) {
    return Response.redirect(origin + '/auth/login.html?error=userinfo_failed', 302);
  }

  const profile = await meResponse.json();
  const email = (profile.mail || profile.userPrincipalName)?.toLowerCase();
  const name = profile.displayName || email?.split('@')[0] || 'User';

  if (!email) {
    return Response.redirect(origin + '/auth/login.html?error=no_email', 302);
  }

  const resolved = await resolveOAuthLogin(env, {
    provider: 'microsoft',
    subject: profile.id,
    email,
    // The app accepts any Entra tenant (/common/), and a tenant admin can set a
    // user's mail/UPN to any address without proving ownership. So a Microsoft
    // email is never treated as verified: it can't claim an existing account.
    emailVerified: false,
    name,
    avatarUrl: null,
  });
  if (resolved.error) {
    return Response.redirect(origin + '/auth/login.html?error=' + resolved.error, 302);
  }
  const { user, isNewUser } = resolved;

  // Combined signup: if Outlook calendar access was granted in the same consent,
  // connect the calendar now so the user skips the separate "Connect your
  // calendar" onboarding step (parity with Google signup).
  let calendarConnected = false;
  if (isSignup) {
    const grantedScopes = (tokens.scope || '').toLowerCase();
    const hasCalendarScope = grantedScopes.includes('calendars.read'); // matches Calendars.Read / Calendars.ReadWrite
    if (hasCalendarScope && tokens.access_token) {
      try {
        const existingConn = await env.DB.prepare(
          'SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND email = ?'
        ).bind(user.id, 'outlook', email).first();
        if (existingConn) {
          calendarConnected = true;
        } else {
          const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
          const refreshTokenEncrypted = tokens.refresh_token
            ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY) : null;
          const expiresAt = tokens.expires_in
            ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000) : null;
          const existingPrimary = await env.DB.prepare(
            'SELECT id FROM calendar_connections WHERE user_id = ? AND is_primary = 1'
          ).bind(user.id).first();
          const isPrimary = existingPrimary ? 0 : 1;
          await env.DB.prepare(
            'INSERT INTO calendar_connections (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, email, calendar_id, is_primary, check_conflicts, write_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(user.id, 'outlook', accessTokenEncrypted, refreshTokenEncrypted, expiresAt, email, 'primary', isPrimary, 1, isPrimary).run();
          calendarConnected = true;
          await logAuditEvent(env.DB, user.id, 'calendar.connected', 'calendar_connection', null, { provider: 'outlook', email, via: 'oauth_signup' }, null);
        }
      } catch (connErr) {
        console.error('Auto-connect Outlook Calendar at signup failed:', connErr);
      }
    }
  }

  const session = await createSession(env, user.id);
  let redirectTo = isNewUser ? '/dashboard/?welcome=1' : '/dashboard/';
  if (calendarConnected) {
    redirectTo += redirectTo.includes('?') ? '&calendar=connected' : '?calendar=connected';
  }
  const response = Response.redirect(origin + redirectTo, 302);
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Set-Cookie', sessionCookie(session.token, session.expires_at, request));
  return newResponse;
}

// ============================================================
// Outlook Calendar Connection Handlers
// ============================================================

async function handleOutlookCalendarOAuth(request, env, user) {
  const clientId = env.MICROSOFT_CLIENT_ID;
  if (!clientId) return jsonResponse({ error: 'Microsoft OAuth is not configured' }, 500);

  const origin = env.APP_ORIGIN || new URL(request.url).origin;
  const redirectUri = origin + '/api/auth/callback/outlook-calendar';
  const scopes = ['openid', 'email', 'profile', 'offline_access', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    response_mode: 'query',
    state: await generateOAuthState(env, 'cal_' + user.id),
  });

  return Response.redirect('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + params.toString(), 302);
}

async function handleOutlookCalendarCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const origin = env.APP_ORIGIN || url.origin;

  if (error) {
    return Response.redirect(origin + '/dashboard/?tab=settings&calendar=error&reason=' + encodeURIComponent(error), 302);
  }

  if (!code || !state) {
    return Response.redirect(origin + '/dashboard/?tab=settings&calendar=error&reason=missing_params', 302);
  }

  const statePayload = await verifyOAuthState(env, state);
  if (!statePayload || !statePayload.startsWith('cal_')) {
    return Response.redirect(origin + '/dashboard/?tab=settings&calendar=error&reason=invalid_state', 302);
  }

  const userId = parseInt(statePayload.replace('cal_', ''), 10);
  if (isNaN(userId)) {
    return Response.redirect(origin + '/dashboard/?tab=settings&calendar=error&reason=invalid_state', 302);
  }

  const redirectUri = origin + '/api/auth/callback/outlook-calendar';
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.MICROSOFT_CLIENT_ID,
      client_secret: env.MICROSOFT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: 'openid email profile offline_access Calendars.ReadWrite OnlineMeetings.ReadWrite',
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Outlook calendar token exchange failed:', await tokenResponse.text());
    return Response.redirect(origin + '/dashboard/?tab=settings&calendar=error&reason=token_exchange_failed', 302);
  }

  const tokens = await tokenResponse.json();

  let outlookEmail = null;
  try {
    const meResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    if (meResponse.ok) {
      const profile = await meResponse.json();
      outlookEmail = profile.mail || profile.userPrincipalName;
    }
  } catch { }

  const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
  const refreshTokenEncrypted = tokens.refresh_token
    ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY) : null;
  const expiresAt = tokens.expires_in
    ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000) : null;

  const existing = await env.DB.prepare(
    'SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND email = ?'
  ).bind(userId, 'outlook', outlookEmail).first();

  if (existing) {
    await env.DB.prepare(
      "UPDATE calendar_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(accessTokenEncrypted, refreshTokenEncrypted, expiresAt, existing.id).run();
  } else {
    // Check if user already has a primary calendar
    const existingPrimary = await env.DB.prepare('SELECT id FROM calendar_connections WHERE user_id = ? AND is_primary = 1').bind(userId).first();
    const isPrimary = existingPrimary ? 0 : 1;
    const writeEvents = existingPrimary ? 0 : 1;
    await env.DB.prepare(
      'INSERT INTO calendar_connections (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, email, calendar_id, is_primary, check_conflicts, write_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, 'outlook', accessTokenEncrypted, refreshTokenEncrypted, expiresAt, outlookEmail, 'primary', isPrimary, 1, writeEvents).run();
  }

  return Response.redirect(origin + '/dashboard/?calendar=connected', 302);
}

// ============================================================
// Event Type Handlers
// ============================================================

async function handleListEventTypes(request, env, user) {
  // Get own event types
  const own = await env.DB.prepare(
    'SELECT * FROM event_types WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();

  // Also get org event types where user is a member
  const orgEts = await env.DB.prepare(
    `SELECT et.* FROM event_types et
     JOIN org_members om ON et.org_id = om.org_id
     WHERE om.user_id = ? AND et.user_id != ?
     ORDER BY et.created_at DESC`
  ).bind(user.id, user.id).all();

  const ownIds = new Set((own.results || []).map(e => e.id));
  const merged = [...(own.results || []), ...(orgEts.results || []).filter(e => !ownIds.has(e.id))];
  return jsonResponse(merged);
}

async function handleCreateEventType(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name, duration_minutes, description, color, location_type, location_config, questions, is_secret, requires_confirmation, max_bookings_per_day, buffer_before, buffer_after, min_notice_hours, max_future_days, org_id, round_robin_mode, price_cents, currency, payment_method, group_max_attendees, sort_order, slot_interval, locked_timezone, redirect_url, allow_guests, reconfirmation_hours } = body;

  if (!name || name.trim().length < 2) return jsonResponse({ error: 'Name must be at least 2 characters' }, 400);
  const duration = duration_minutes || 30;
  if (duration < 5 || duration > 720) return jsonResponse({ error: 'Duration must be between 5 and 720 minutes' }, 400);

  // Validate custom questions with conditional logic
  if (questions && Array.isArray(questions)) {
    const validationError = validateCustomQuestions(questions);
    if (validationError) return jsonResponse({ error: validationError }, 400);
  }

  // Validate redirect_url if provided
  if (redirect_url !== undefined && redirect_url !== null && redirect_url !== '') {
    try {
      const parsed = new URL(redirect_url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return jsonResponse({ error: 'redirect_url must use http or https protocol' }, 400);
      }
    } catch {
      return jsonResponse({ error: 'redirect_url must be a valid URL' }, 400);
    }
  }

  // Validate round_robin_mode
  if (round_robin_mode && !['round-robin', 'collective'].includes(round_robin_mode)) {
    return jsonResponse({ error: 'round_robin_mode must be "round-robin" or "collective"' }, 400);
  }

  // If org_id is set, validate user is admin/owner
  if (org_id) {
    const membership = await env.DB.prepare(
      'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
    ).bind(org_id, user.id).first();
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return jsonResponse({ error: 'Only org admins and owners can create team event types' }, 403);
    }
  }

  // round_robin_mode only valid with org_id
  if (round_robin_mode && !org_id) {
    return jsonResponse({ error: 'round_robin_mode requires an org_id' }, 400);
  }

  // Use an explicit slug when provided, otherwise derive it from the name.
  const slug = body.slug ? generateSlug(body.slug) : generateSlug(name);
  if (!slug) return jsonResponse({ error: 'Slug cannot be empty' }, 400);

  // Check slug uniqueness for this user
  const existingSlug = await env.DB.prepare(
    'SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1'
  ).bind(user.id, slug).first();
  if (existingSlug) {
    return jsonResponse({ error: body.slug ? `The slug "${slug}" is already in use. Choose a different one.` : 'An event type with a similar name already exists' }, 409);
  }

  // Get default availability schedule
  const defaultSchedule = await env.DB.prepare(
    'SELECT id FROM availability_schedules WHERE user_id = ? AND is_default = 1'
  ).bind(user.id).first();

  const result = await env.DB.prepare(
    `INSERT INTO event_types (user_id, name, slug, description, duration_minutes, color, location_type, location_config, questions, is_secret, requires_confirmation, max_bookings_per_day, slot_interval, buffer_before, buffer_after, min_notice_hours, max_future_days, availability_schedule_id, org_id, round_robin_mode, price_cents, currency, payment_method, group_max_attendees, sort_order, locked_timezone, redirect_url, allow_guests, reconfirmation_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  ).bind(
    user.id, name.trim(), slug,
    description || null, duration,
    color || '#0069ff',
    location_type || 'google_meet',
    JSON.stringify(location_config || {}),
    JSON.stringify(questions || []),
    is_secret ? 1 : 0,
    requires_confirmation ? 1 : 0,
    max_bookings_per_day || null,
    slot_interval || (duration > 15 ? 30 : 15),
    buffer_before || 0, buffer_after || 0,
    min_notice_hours ?? 4, max_future_days ?? 60,
    defaultSchedule?.id || null,
    org_id || null,
    round_robin_mode || null,
    price_cents || null,
    currency || null,
    payment_method || 'stripe',
    group_max_attendees || null,
    sort_order || 0,
    locked_timezone || null,
    redirect_url || null,
    allow_guests === false ? 0 : 1,
    reconfirmation_hours || null
  ).first();

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'event_type.created', 'event_type', result.id, { name: result.name, slug: result.slug }, clientIP);

  return jsonResponse(result, 201);
}

async function handleGetEventType(request, env, user, path) {
  const id = path.split('/').pop();
  const result = await env.DB.prepare(
    'SELECT * FROM event_types WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!result) return jsonResponse({ error: 'Not found' }, 404);
  return jsonResponse(result);
}

async function handleUpdateEventType(request, env, user, path) {
  const id = path.split('/').pop();
  let existing = await env.DB.prepare('SELECT * FROM event_types WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  // Also allow org members with edit permission
  if (!existing) {
    existing = await env.DB.prepare('SELECT * FROM event_types WHERE id = ?').bind(id).first();
    if (existing?.org_id) {
      const hasPermission = await checkTeamPermission(env, user.id, existing.org_id, 'edit_event_types');
      if (!hasPermission) existing = null;
    } else {
      existing = null;
    }
  }
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  // Renaming does NOT change the public URL — that would break existing booking
  // links. The slug only changes when the caller explicitly passes a new one.
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.slug !== undefined) fields.slug = generateSlug(body.slug);
  if (body.description !== undefined) fields.description = body.description;
  if (body.duration_minutes !== undefined) {
    const d = body.duration_minutes;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 5 || d > 720) {
      return jsonResponse({ error: 'Duration must be between 5 and 720 minutes' }, 400);
    }
    fields.duration_minutes = d;
  }
  if (body.color !== undefined) fields.color = body.color;
  if (body.location_type !== undefined) fields.location_type = body.location_type;
  if (body.location_config !== undefined) fields.location_config = JSON.stringify(body.location_config);
  if (body.questions !== undefined) {
    if (Array.isArray(body.questions)) {
      const validationError = validateCustomQuestions(body.questions);
      if (validationError) return jsonResponse({ error: validationError }, 400);
    }
    fields.questions = JSON.stringify(body.questions);
  }
  if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0;
  if (body.is_secret !== undefined) fields.is_secret = body.is_secret ? 1 : 0;
  if (body.requires_confirmation !== undefined) fields.requires_confirmation = body.requires_confirmation ? 1 : 0;
  if (body.max_bookings_per_day !== undefined) fields.max_bookings_per_day = body.max_bookings_per_day;
  if (body.slot_interval !== undefined) fields.slot_interval = body.slot_interval;
  if (body.buffer_before !== undefined) fields.buffer_before = body.buffer_before;
  if (body.buffer_after !== undefined) fields.buffer_after = body.buffer_after;
  if (body.min_notice_hours !== undefined) fields.min_notice_hours = body.min_notice_hours;
  if (body.max_future_days !== undefined) fields.max_future_days = body.max_future_days;
  if (body.availability_schedule_id !== undefined) fields.availability_schedule_id = body.availability_schedule_id;
  if (body.price_cents !== undefined) fields.price_cents = body.price_cents;
  if (body.currency !== undefined) fields.currency = body.currency;
  if (body.payment_method !== undefined) {
    if (!['stripe', 'paypal'].includes(body.payment_method)) {
      return jsonResponse({ error: 'payment_method must be "stripe" or "paypal"' }, 400);
    }
    fields.payment_method = body.payment_method;
  }
  if (body.group_max_attendees !== undefined) fields.group_max_attendees = body.group_max_attendees || null;
  if (body.sort_order !== undefined) fields.sort_order = body.sort_order;
  if (body.locked_timezone !== undefined) fields.locked_timezone = body.locked_timezone || null;
  if (body.reminder_settings !== undefined) fields.reminder_settings = JSON.stringify(body.reminder_settings);
  if (body.redirect_url !== undefined) {
    if (body.redirect_url === '' || body.redirect_url === null) {
      fields.redirect_url = null;
    } else {
      try {
        const parsed = new URL(body.redirect_url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return jsonResponse({ error: 'redirect_url must use http or https protocol' }, 400);
        }
        fields.redirect_url = body.redirect_url;
      } catch {
        return jsonResponse({ error: 'redirect_url must be a valid URL' }, 400);
      }
    }
  }
  if (body.allow_guests !== undefined) fields.allow_guests = body.allow_guests ? 1 : 0;
  if (body.reconfirmation_hours !== undefined) fields.reconfirmation_hours = body.reconfirmation_hours || null;

  if (Object.keys(fields).length === 0) return jsonResponse({ error: 'No fields to update' }, 400);

  // Slug must be non-empty and unique within this user's event types.
  if (fields.slug !== undefined) {
    if (!fields.slug) return jsonResponse({ error: 'Slug cannot be empty' }, 400);
    const clash = await env.DB.prepare('SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND id != ?').bind(user.id, fields.slug, id).first();
    if (clash) return jsonResponse({ error: 'That slug is already used by another of your event types' }, 409);
  }

  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  const result = await env.DB.prepare(
    `UPDATE event_types SET ${setClauses} WHERE id = ? RETURNING *`
  ).bind(...values, id).first();

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'event_type.updated', 'event_type', parseInt(id), { updated_fields: Object.keys(fields).filter(k => k !== 'updated_at') }, clientIP);

  return jsonResponse(result);
}

async function handleDeleteEventType(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT id FROM event_types WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  // Unlink from bookings' foreign key by nullifying (bookings store event_type_name separately)
  // Actually, just delete — the FK has no ON DELETE CASCADE, so check for active bookings first
  const activeBookings = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM bookings WHERE event_type_id = ? AND status IN ('confirmed', 'pending')"
  ).bind(id).first();

  if (activeBookings.count > 0) {
    // Soft delete if there are active bookings (to preserve booking references)
    await env.DB.prepare(
      "UPDATE event_types SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).bind(id, user.id).run();
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
    await logAuditEvent(env.DB, user.id, 'event_type.deleted', 'event_type', parseInt(id), { soft_deleted: true }, clientIP);
    return jsonResponse({ ok: true, soft_deleted: true, message: `Deactivated (${activeBookings.count} active bookings reference this event type)` });
  }

  // Hard delete if no active bookings
  await env.DB.prepare('DELETE FROM workflow_actions WHERE event_type_id = ?').bind(id).run();
  await env.DB.prepare("DELETE FROM bookings WHERE event_type_id = ? AND status NOT IN ('confirmed', 'pending')").bind(id).run();
  await env.DB.prepare('DELETE FROM event_types WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'event_type.deleted', 'event_type', parseInt(id), { hard_deleted: true }, clientIP);
  return jsonResponse({ ok: true });
}

// ============================================================
// Availability Schedule Handlers
// ============================================================

async function handleListAvailabilitySchedules(request, env, user) {
  const result = await env.DB.prepare(
    'SELECT * FROM availability_schedules WHERE user_id = ? ORDER BY is_default DESC, created_at DESC'
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleCreateAvailabilitySchedule(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name, timezone, rules, overrides, holidays, meeting_limits, is_default } = body;
  if (!name) return jsonResponse({ error: 'Name is required' }, 400);

  // If setting as default, unset other defaults
  if (is_default) {
    await env.DB.prepare('UPDATE availability_schedules SET is_default = 0 WHERE user_id = ?').bind(user.id).run();
  }

  const result = await env.DB.prepare(
    'INSERT INTO availability_schedules (user_id, name, timezone, rules, overrides, holidays, meeting_limits, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(
    user.id, name.trim(),
    timezone || 'America/Los_Angeles',
    JSON.stringify(rules || []),
    JSON.stringify(overrides || []),
    JSON.stringify(holidays || []),
    JSON.stringify(meeting_limits || []),
    is_default ? 1 : 0
  ).first();

  return jsonResponse(result, 201);
}

async function handleUpdateAvailabilitySchedule(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};

  if (body.name !== undefined) {
    if (!body.name || !body.name.trim()) return jsonResponse({ error: 'Name is required' }, 400);
    fields.name = body.name.trim();
  }
  if (body.timezone !== undefined) fields.timezone = body.timezone;

  if (body.rules !== undefined) {
    if (!Array.isArray(body.rules)) return jsonResponse({ error: 'Rules must be an array' }, 400);
    for (const rule of body.rules) {
      if (rule.day === undefined || rule.day < 0 || rule.day > 6) {
        return jsonResponse({ error: 'Each rule must have a day between 0-6' }, 400);
      }
      if (!rule.start || !/^\d{2}:\d{2}$/.test(rule.start)) {
        return jsonResponse({ error: 'Each rule must have start in HH:MM format' }, 400);
      }
      if (!rule.end || !/^\d{2}:\d{2}$/.test(rule.end)) {
        return jsonResponse({ error: 'Each rule must have end in HH:MM format' }, 400);
      }
      if (rule.start >= rule.end) {
        return jsonResponse({ error: 'Rule start must be before end' }, 400);
      }
    }
    fields.rules = JSON.stringify(body.rules);
  }

  if (body.overrides !== undefined) {
    if (!Array.isArray(body.overrides)) return jsonResponse({ error: 'Overrides must be an array' }, 400);
    for (const override of body.overrides) {
      if (!override.date || !/^\d{4}-\d{2}-\d{2}$/.test(override.date)) {
        return jsonResponse({ error: 'Each override must have a date in YYYY-MM-DD format' }, 400);
      }
      if (override.available === false) {
        // Blocking the day - valid
      } else if (override.start && override.end) {
        if (!/^\d{2}:\d{2}$/.test(override.start) || !/^\d{2}:\d{2}$/.test(override.end)) {
          return jsonResponse({ error: 'Override start/end must be in HH:MM format' }, 400);
        }
        if (override.start >= override.end) {
          return jsonResponse({ error: 'Override start must be before end' }, 400);
        }
      } else {
        return jsonResponse({ error: 'Each override must have either available:false or start+end times' }, 400);
      }
    }
    fields.overrides = JSON.stringify(body.overrides);
  }

  if (body.holidays !== undefined) {
    if (!Array.isArray(body.holidays)) return jsonResponse({ error: 'Holidays must be an array' }, 400);
    for (const h of body.holidays) {
      if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
        return jsonResponse({ error: 'Each holiday must have a date in YYYY-MM-DD format' }, 400);
      }
      if (h.enabled !== undefined && typeof h.enabled !== 'boolean') {
        return jsonResponse({ error: 'Holiday enabled field must be a boolean' }, 400);
      }
    }
    fields.holidays = JSON.stringify(body.holidays);
  }

  if (body.meeting_limits !== undefined) {
    if (!Array.isArray(body.meeting_limits)) return jsonResponse({ error: 'Meeting limits must be an array' }, 400);
    for (const limit of body.meeting_limits) {
      if (!limit.type || !['daily', 'weekly'].includes(limit.type)) {
        return jsonResponse({ error: 'Each meeting limit must have type "daily" or "weekly"' }, 400);
      }
      if (!Number.isInteger(limit.max) || limit.max < 1) {
        return jsonResponse({ error: 'Each meeting limit must have a positive integer max' }, 400);
      }
    }
    fields.meeting_limits = JSON.stringify(body.meeting_limits);
  }

  if (Object.keys(fields).length === 0) return jsonResponse({ error: 'No fields to update' }, 400);

  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  const result = await env.DB.prepare(
    `UPDATE availability_schedules SET ${setClauses} WHERE id = ? AND user_id = ? RETURNING *`
  ).bind(...values, id, user.id).first();

  return jsonResponse(result);
}

async function handleDeleteAvailabilitySchedule(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  if (existing.is_default) {
    return jsonResponse({ error: 'Cannot delete the default schedule' }, 400);
  }

  // Unlink any event types using this schedule
  await env.DB.prepare(
    'UPDATE event_types SET availability_schedule_id = NULL WHERE availability_schedule_id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  await env.DB.prepare(
    'DELETE FROM availability_schedules WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  return jsonResponse({ ok: true });
}

// ============================================================
// Booking Handlers
// ============================================================

async function handleListBookings(request, env, user) {
  const result = await env.DB.prepare(
    `SELECT b.*, et.name as event_type_name, et.duration_minutes, et.location_type as et_location_type
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE et.user_id = ? OR b.assigned_user_id = ?
       OR et.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?)
     ORDER BY b.start_time DESC`
  ).bind(user.id, user.id, user.id).all();
  return jsonResponse(result.results);
}

async function handleBookOnBehalf(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { event_type_id, invitee_name, invitee_email, start_time, timezone, notes } = body;
  if (!event_type_id) return jsonResponse({ error: 'event_type_id is required' }, 400);
  if (!invitee_name || !invitee_name.trim()) return jsonResponse({ error: 'invitee_name is required' }, 400);
  if (!invitee_email || !invitee_email.trim()) return jsonResponse({ error: 'invitee_email is required' }, 400);
  if (!start_time) return jsonResponse({ error: 'start_time is required' }, 400);

  // Verify event type belongs to user
  const eventType = await env.DB.prepare(
    'SELECT * FROM event_types WHERE id = ? AND user_id = ?'
  ).bind(event_type_id, user.id).first();
  if (!eventType) return jsonResponse({ error: 'Event type not found' }, 404);

  const inviteeTz = timezone || user.timezone || 'UTC';
  // Interpret start_time in the host's timezone if no Z/offset suffix
  let startDate;
  if (start_time.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(start_time)) {
    startDate = new Date(start_time);
  } else {
    // datetime-local format like "2026-04-10T14:00" — interpret in host's timezone
    const hostTz = user.timezone || 'UTC';
    const [datePart, timePart] = start_time.split('T');
    // Use Intl to find the UTC offset at this local time
    const roughUtc = new Date(start_time + 'Z');
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: hostTz, hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
    const utcParts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(roughUtc);
    const tzParts = new Intl.DateTimeFormat('en-US', { timeZone: hostTz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(roughUtc);
    const utcH = parseInt(utcParts.find(p => p.type === 'hour').value);
    const utcM = parseInt(utcParts.find(p => p.type === 'minute').value);
    const tzH = parseInt(tzParts.find(p => p.type === 'hour').value === '24' ? '0' : tzParts.find(p => p.type === 'hour').value);
    const tzM = parseInt(tzParts.find(p => p.type === 'minute').value);
    const offsetMs = ((tzH * 60 + tzM) - (utcH * 60 + utcM)) * 60000;
    startDate = new Date(roughUtc.getTime() - offsetMs);
  }
  if (isNaN(startDate.getTime())) return jsonResponse({ error: 'Invalid start_time format' }, 400);

  const endDate = new Date(startDate.getTime() + eventType.duration_minutes * 60000);
  const startTimeISO = startDate.toISOString().replace('.000Z', 'Z');
  const endTimeISO = endDate.toISOString().replace('.000Z', 'Z');
  const uid = crypto.randomUUID();
  const cancelToken = crypto.randomUUID();

  const booking = await env.DB.prepare(
    `INSERT INTO bookings (event_type_id, uid, invitee_email, invitee_name, invitee_timezone, start_time, end_time, status, answers, cancel_token, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', '{}', ?, ?)
     RETURNING id, uid, invitee_email, invitee_name, invitee_timezone, start_time, end_time, status, cancel_token, notes, created_at`
  ).bind(
    eventType.id, uid, invitee_email.trim().toLowerCase(), invitee_name.trim(),
    inviteeTz, startTimeISO, endTimeISO, cancelToken,
    notes || null
  ).first();

  // Run side effects (email, calendar) in background
  try {
    await runBookingCreatedSideEffects(env, {
      booking,
      eventType,
      hostUserId: user.id,
      appOrigin: new URL(request.url).origin,
      clientIP: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null,
    });
  } catch (err) {
    console.error('Book on behalf side effects error:', err);
  }

  return jsonResponse(booking, 201);
}

async function handleCancelBooking(request, env, user, path) {
  const id = path.split('/')[3]; // /api/bookings/123/cancel
  let booking = await env.DB.prepare(
    `SELECT b.* FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?`
  ).bind(id, user.id).first();
  // Also allow org members with manage_bookings permission
  if (!booking) {
    const b = await env.DB.prepare(
      `SELECT b.*, et.org_id FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ?`
    ).bind(id).first();
    if (b?.org_id) {
      const hasPermission = await checkTeamPermission(env, user.id, b.org_id, 'manage_bookings');
      if (hasPermission) booking = b;
    }
  }
  if (!booking) return jsonResponse({ error: 'Not found' }, 404);
  if (booking.status === 'cancelled') return jsonResponse({ error: 'Already cancelled' }, 400);

  // Parse cancel_scope for recurring bookings
  const body = await request.json().catch(() => ({}));
  const cancelScope = body.cancel_scope || 'this';

  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = 'host', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  // Handle recurring cancellation
  if (cancelScope === 'all_future') {
    const parentId = booking.recurrence_parent_id || booking.id;
    // Cancel all future bookings in this series
    await env.DB.prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = 'host', updated_at = datetime('now')
       WHERE (recurrence_parent_id = ? OR id = ?)
       AND ${sqlUnixEpoch('start_time')} >= ${sqlUnixEpoch('?')}
       AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
       AND id != ?`
    ).bind(parentId, parentId, booking.start_time, booking.id).run();
  }

  // Send cancellation emails
  try {
    const eventType = await env.DB.prepare(
      'SELECT * FROM event_types WHERE id = ?'
    ).bind(booking.event_type_id).first();

    if (eventType) {
      // Email to invitee
      const inviteeData = cancellationEmail(booking, eventType, 'host', booking.invitee_name);
      await sendEmail(env, {
        to: booking.invitee_email,
        subject: inviteeData.subject,
        html: inviteeData.html,
        text: inviteeData.text,
        bookingId: booking.id,
        type: 'cancellation',
      });

      // Email to host (in the host's own timezone)
      const hostTz = await resolveHostTimezone(env, user.id, eventType, user.timezone);
      const hostCancelData = cancellationEmail(booking, eventType, 'host', user.name, hostTz);
      await sendEmail(env, {
        to: user.email,
        subject: hostCancelData.subject,
        html: hostCancelData.html,
        text: hostCancelData.text,
        bookingId: booking.id,
        type: 'cancellation',
      });
    }
  } catch (emailErr) {
    console.error('Failed to send cancellation emails:', emailErr);
  }

  // Fire webhooks for booking.cancelled
  try {
    await fireWebhooks(env, user.id, 'booking.cancelled', {
      booking: {
        id: booking.id,
        uid: booking.uid,
        invitee_name: booking.invitee_name,
        invitee_email: booking.invitee_email,
        start_time: booking.start_time,
        end_time: booking.end_time,
        status: 'cancelled',
        cancelled_by: 'host',
      }
    });
  } catch (webhookErr) {
    console.error('Failed to fire webhooks:', webhookErr);
  }

  // Send Slack notification (fire and forget)
  try {
    await sendSlackNotification(env, user.id, 'booking.cancelled', {
      booking: {
        event_type: eventType ? eventType.name : 'Meeting',
        invitee_name: booking.invitee_name,
        invitee_email: booking.invitee_email,
        start_time: booking.start_time,
        cancelled_by: 'host',
      }
    });
  } catch (slackErr) {
    console.error('Slack notification error:', slackErr);
  }

  // Delete from Google Calendar
  if (booking.calendar_event_id) {
    try {
      await deleteGoogleCalendarEvent(env, user.id, booking.calendar_event_id);
    } catch (calErr) {
      console.error('Failed to delete Google Calendar event:', calErr);
    }
  }

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'booking.cancelled', 'booking', parseInt(id), {
    invitee_email: booking.invitee_email,
    cancelled_by: 'host',
  }, clientIP);

  return jsonResponse({ ok: true });
}

async function handleMarkNoShow(request, env, user, path) {
  const id = path.split('/')[3]; // /api/bookings/123/no-show
  let booking = await env.DB.prepare(
    `SELECT b.* FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?`
  ).bind(id, user.id).first();
  if (!booking) {
    const b = await env.DB.prepare(
      `SELECT b.*, et.org_id FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ?`
    ).bind(id).first();
    if (b?.org_id && await checkTeamPermission(env, user.id, b.org_id, 'manage_bookings')) booking = b;
  }
  if (!booking) return jsonResponse({ error: 'Not found' }, 404);
  if (booking.status === 'cancelled') return jsonResponse({ error: 'Cannot mark a cancelled booking as no-show' }, 400);
  if (booking.status === 'no_show') return jsonResponse({ error: 'Already marked as no-show' }, 400);

  // Only allow marking past bookings as no-show
  const startTime = parseStoredUtcDate(booking.start_time);
  if (startTime > new Date()) {
    return jsonResponse({ error: 'Cannot mark a future booking as no-show' }, 400);
  }

  await env.DB.prepare(
    `UPDATE bookings SET status = 'no_show', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  return jsonResponse({ ok: true });
}

async function handleUpdateBookingNotes(request, env, user, path) {
  const id = path.split('/')[3]; // /api/bookings/123/notes
  let booking = await env.DB.prepare(
    `SELECT b.id FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?`
  ).bind(id, user.id).first();
  if (!booking) {
    const b = await env.DB.prepare(
      `SELECT b.id, et.org_id FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ?`
    ).bind(id).first();
    if (b?.org_id && await checkTeamPermission(env, user.id, b.org_id, 'manage_bookings')) booking = b;
  }
  if (!booking) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body.notes !== 'string') {
    return jsonResponse({ error: 'notes field is required (string)' }, 400);
  }

  const notes = body.notes.trim() || null;
  await env.DB.prepare(
    `UPDATE bookings SET notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(notes, id).run();

  return jsonResponse({ ok: true, notes });
}

// ============================================================
// Public Token-Based Booking Handlers (invitee self-service)
// ============================================================

async function handleGetBookingByToken(request, env, path) {
  const token = path.split('/').pop();
  if (!token) return jsonResponse({ error: 'Token is required' }, 400);

  const booking = await env.DB.prepare(
    `SELECT b.uid, b.invitee_name, b.invitee_email, b.invitee_timezone,
            b.start_time, b.end_time, b.status, b.created_at,
            et.name as event_type_name, et.slug as event_type_slug,
            et.duration_minutes,
            u.name as host_name,
            bp.slug as booking_page_slug,
            bp.cancellation_policy
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     JOIN users u ON et.user_id = u.id
     LEFT JOIN booking_pages bp ON bp.user_id = u.id
     WHERE b.cancel_token = ?`
  ).bind(token).first();

  if (!booking) {
    return jsonResponse({ error: 'Invalid or expired token' }, 404);
  }

  return jsonResponse({
    uid: booking.uid,
    invitee_name: booking.invitee_name,
    invitee_email: booking.invitee_email,
    invitee_timezone: booking.invitee_timezone,
    start_time: booking.start_time,
    end_time: booking.end_time,
    status: booking.status,
    event_type_name: booking.event_type_name,
    event_type_slug: booking.event_type_slug,
    duration_minutes: booking.duration_minutes,
    host_name: booking.host_name,
    booking_page_slug: booking.booking_page_slug,
    cancellation_policy: booking.cancellation_policy || null,
    created_at: booking.created_at,
  });
}

async function handleReconfirmBooking(request, env, url, path) {
  const bookingId = path.match(/\/api\/bookings\/(\d+)\/reconfirm/)?.[1];
  const token = url.searchParams.get('token');
  if (!bookingId || !token) {
    return jsonResponse({ error: 'Booking ID and token are required' }, 400);
  }

  const booking = await env.DB.prepare(
    'SELECT * FROM bookings WHERE id = ? AND cancel_token = ?'
  ).bind(bookingId, token).first();
  if (!booking) {
    return jsonResponse({ error: 'Booking not found or invalid token' }, 404);
  }
  if (booking.status === 'cancelled') {
    return jsonResponse({ error: 'Booking has been cancelled' }, 400);
  }
  if (booking.reconfirmed === 1) {
    return jsonResponse({ message: 'Attendance already confirmed' });
  }

  await env.DB.prepare(
    "UPDATE bookings SET reconfirmed = 1, updated_at = datetime('now') WHERE id = ?"
  ).bind(bookingId).run();

  return jsonResponse({ message: 'Attendance confirmed. Thank you!' });
}

async function handleCancelBookingByToken(request, env, path) {
  const token = path.split('/').pop();
  if (!token) return jsonResponse({ error: 'Token is required' }, 400);

  const booking = await env.DB.prepare(
    'SELECT b.id, b.uid, b.status, b.start_time FROM bookings b WHERE b.cancel_token = ?'
  ).bind(token).first();

  if (!booking) {
    return jsonResponse({ error: 'Invalid or expired token' }, 404);
  }

  if (booking.status === 'cancelled') {
    return jsonResponse({ error: 'This booking has already been cancelled' }, 400);
  }

  if (booking.status === 'rescheduled') {
    return jsonResponse({ error: 'This booking has been rescheduled. Use the new booking link instead.' }, 400);
  }

  // Check if booking is in the past
  const startTime = parseStoredUtcDate(booking.start_time);
  if (startTime <= new Date()) {
    return jsonResponse({ error: 'Cannot cancel a booking that has already started or passed' }, 400);
  }

  // Parse optional reason
  const body = await request.json().catch(() => ({}));
  const reason = body.reason || null;

  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = 'invitee', cancellation_reason = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(reason, booking.id).run();

  // Notify host about cancellation (non-blocking)
  try {
    const fullBooking = await env.DB.prepare(
      `SELECT b.*, et.name as event_type_name, et.user_id, u.name as host_name, u.email as host_email
       FROM bookings b JOIN event_types et ON b.event_type_id = et.id
       JOIN users u ON et.user_id = u.id WHERE b.id = ?`
    ).bind(booking.id).first();

    if (fullBooking) {
      // This notification goes only to the host → use the host's timezone.
      const hostTz = await resolveHostTimezone(env, fullBooking.user_id, null, null);
      const cancelData = cancellationEmail(
        fullBooking,
        { name: fullBooking.event_type_name },
        'invitee',
        fullBooking.host_name,
        hostTz
      );
      await sendEmail(env, { to: fullBooking.host_email, subject: cancelData.subject, html: cancelData.html, text: cancelData.text, bookingId: booking.id, type: 'cancellation' });

      // Fire webhooks
      await fireWebhooks(env, fullBooking.user_id, 'booking.cancelled', {
        booking: { uid: booking.uid, event_type: fullBooking.event_type_name, invitee_name: fullBooking.invitee_name, invitee_email: fullBooking.invitee_email, start_time: fullBooking.start_time, end_time: fullBooking.end_time, cancelled_by: 'invitee', cancellation_reason: reason }
      });

      // Send Slack notification (fire and forget)
      try {
        await sendSlackNotification(env, fullBooking.user_id, 'booking.cancelled', {
          booking: {
            event_type: fullBooking.event_type_name,
            invitee_name: fullBooking.invitee_name,
            invitee_email: fullBooking.invitee_email,
            start_time: fullBooking.start_time,
            cancelled_by: 'invitee',
          }
        });
      } catch (slackErr) {
        console.error('Slack notification error:', slackErr);
      }
    }
  } catch (notifyErr) {
    console.error('Failed to notify host of invitee cancellation:', notifyErr);
  }

  // Delete from Google Calendar
  try {
    const bookingWithCal = await env.DB.prepare(
      'SELECT b.calendar_event_id, et.user_id FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ?'
    ).bind(booking.id).first();
    if (bookingWithCal?.calendar_event_id) {
      await deleteGoogleCalendarEvent(env, bookingWithCal.user_id, bookingWithCal.calendar_event_id);
    }
  } catch (calErr) {
    console.error('Failed to delete Google Calendar event:', calErr);
  }

  return jsonResponse({ ok: true, message: 'Booking cancelled successfully' });
}

async function handleRescheduleBookingByToken(request, env, url, path) {
  const token = path.split('/').pop();
  if (!token) return jsonResponse({ error: 'Token is required' }, 400);

  const booking = await env.DB.prepare(
    `SELECT b.*, et.name as event_type_name, et.slug as event_type_slug,
            et.duration_minutes, et.user_id, et.availability_schedule_id,
            et.buffer_before, et.buffer_after, et.min_notice_hours,
            et.max_future_days, et.max_bookings_per_day, et.slot_interval,
            et.requires_confirmation, et.id as et_id,
            u.name as host_name,
            bp.slug as booking_page_slug
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     JOIN users u ON et.user_id = u.id
     LEFT JOIN booking_pages bp ON bp.user_id = u.id
     WHERE b.cancel_token = ?`
  ).bind(token).first();

  if (!booking) {
    return jsonResponse({ error: 'Invalid or expired token' }, 404);
  }

  if (booking.status === 'cancelled') {
    return jsonResponse({ error: 'Cannot reschedule a cancelled booking' }, 400);
  }

  if (booking.status === 'rescheduled') {
    return jsonResponse({ error: 'This booking has already been rescheduled. Use the new booking link instead.' }, 400);
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { new_start_time, timezone } = body;
  if (!new_start_time) {
    return jsonResponse({ error: 'new_start_time is required' }, 400);
  }

  const newStartDate = new Date(new_start_time);
  if (isNaN(newStartDate.getTime())) {
    return jsonResponse({ error: 'Invalid new_start_time format' }, 400);
  }

  if (newStartDate <= new Date()) {
    return jsonResponse({ error: 'Cannot reschedule to a time in the past' }, 400);
  }

  const newEndDate = new Date(newStartDate.getTime() + booking.duration_minutes * 60000);
  const inviteeTz = timezone || booking.invitee_timezone || 'UTC';

  // Verify new time is available
  const scheduleId = booking.availability_schedule_id;
  let schedule;
  if (scheduleId) {
    schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
    ).bind(scheduleId, booking.user_id).first();
  }
  if (!schedule) {
    schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1'
    ).bind(booking.user_id).first();
  }
  if (!schedule) {
    return jsonResponse({ error: 'No availability schedule configured' }, 404);
  }

  // Use the invitee's local date for slot validation, with +/-1 day padding
  // to handle timezone boundary crossings (e.g. late evening in West = next day in UTC)
  const reqDateInTz = new Intl.DateTimeFormat('en-CA', {
    timeZone: inviteeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(newStartDate);

  const rangeStart = padDateStr(reqDateInTz, -1);
  const rangeEnd = padDateStr(reqDateInTz, 1);

  // Get existing bookings (excluding the current one being rescheduled)
  const bookingsResult = await env.DB.prepare(
    `SELECT start_time, end_time, status FROM bookings
     WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
     AND id != ?
     AND ${sqlUnixEpoch('start_time')} <= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('end_time')} >= ${sqlUnixEpoch('?')}`
  ).bind(booking.et_id, booking.id, rangeEnd + 'T23:59:59Z', rangeStart + 'T00:00:00Z').all();

  const parsedSchedule = {
    rules: JSON.parse(schedule.rules || '[]'),
    overrides: JSON.parse(schedule.overrides || '[]'),
    holidays: JSON.parse(schedule.holidays || '[]'),
    timezone: schedule.timezone,
  };

  const eventType = {
    duration_minutes: booking.duration_minutes,
    buffer_before: booking.buffer_before || 0,
    buffer_after: booking.buffer_after || 0,
    min_notice_hours: booking.min_notice_hours ?? 4,
    max_future_days: booking.max_future_days ?? 60,
    max_bookings_per_day: booking.max_bookings_per_day,
    slot_interval: booking.slot_interval || 15,
  };

  const availableSlots = computeAvailableSlots({
    schedule: parsedSchedule,
    eventType,
    existingBookings: bookingsResult.results,
    dateRange: { start: rangeStart, end: rangeEnd },
    inviteeTimezone: inviteeTz,
  });

  // Check if the requested time is in the available slots
  const requestedTimeInTz = new Intl.DateTimeFormat('en-US', {
    timeZone: inviteeTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(newStartDate);

  const reqParts = {};
  for (const { type, value } of requestedTimeInTz) {
    reqParts[type] = value;
  }
  const reqHour = reqParts.hour === '24' ? '00' : reqParts.hour;
  const reqTimeStr = `${reqHour}:${reqParts.minute}`;

  const daySlots = availableSlots[reqDateInTz] || [];
  if (!daySlots.includes(reqTimeStr)) {
    return jsonResponse({ error: 'This time slot is not available' }, 409);
  }

  // Re-check external calendar busy times, same as the create-booking path.
  const busyConflict = await findCalendarBusyConflict(
    env, booking.user_id, newStartDate, newEndDate,
    booking.buffer_before || 0, booking.buffer_after || 0
  );
  if (busyConflict) {
    return jsonResponse({ error: 'This time slot is not available' }, 409);
  }

  // Create new booking. Carry over invitee/assignment details from the old
  // booking — dropping them loses the assigned team member, guests, and the
  // phone number used for SMS reminders.
  const newUid = crypto.randomUUID();
  const newCancelToken = crypto.randomUUID();
  const startTimeISO = formatDbTimestamp(newStartDate);
  const endTimeISO = formatDbTimestamp(newEndDate);
  const status = booking.requires_confirmation ? 'pending' : 'confirmed';

  const newBooking = await env.DB.prepare(
    `INSERT INTO bookings (event_type_id, uid, invitee_email, invitee_name, invitee_timezone, invitee_phone, start_time, end_time, status, answers, cancel_token, assigned_user_id, guest_emails, recurrence_parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, uid, invitee_email, invitee_name, invitee_timezone, invitee_phone, start_time, end_time, status, cancel_token, assigned_user_id, guest_emails, created_at`
  ).bind(
    booking.et_id, newUid, booking.invitee_email, booking.invitee_name,
    inviteeTz, booking.invitee_phone || null, startTimeISO, endTimeISO, status,
    booking.answers || '{}', newCancelToken,
    booking.assigned_user_id || null,
    booking.guest_emails || '[]',
    booking.recurrence_parent_id || null
  ).first();

  // Mark old booking as rescheduled
  await env.DB.prepare(
    `UPDATE bookings SET status = 'rescheduled', reschedule_uid = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(newUid, booking.id).run();

  // Side effects (emails, calendar, webhooks) — non-blocking
  const appOrigin = new URL(request.url).origin;
  try {
    const host = await env.DB.prepare(
      'SELECT id, name, email, timezone FROM users WHERE id = ?'
    ).bind(booking.user_id).first();

    if (host) {
      const oldBookingData = {
        start_time: booking.start_time,
        invitee_timezone: booking.invitee_timezone,
      };
      const newBookingData = {
        invitee_name: newBooking.invitee_name,
        invitee_email: newBooking.invitee_email,
        invitee_timezone: newBooking.invitee_timezone,
        start_time: newBooking.start_time,
        cancel_token: newBooking.cancel_token,
      };
      const eventTypeData = { name: booking.event_type_name };

      // Notify host (in the host's own timezone)
      const hostTz = await resolveHostTimezone(env, host.id, null, host.timezone);
      const hostEmail = rescheduleEmail(newBookingData, oldBookingData, eventTypeData, host.name, appOrigin, hostTz);
      await sendEmail(env, { to: host.email, subject: hostEmail.subject, html: hostEmail.html, text: hostEmail.text, bookingId: newBooking.id, type: 'reschedule' });

      // Notify invitee
      const inviteeEmail = rescheduleEmail(newBookingData, oldBookingData, eventTypeData, newBooking.invitee_name, appOrigin);
      await sendEmail(env, { to: newBooking.invitee_email, subject: inviteeEmail.subject, html: inviteeEmail.html, text: inviteeEmail.text, bookingId: newBooking.id, type: 'reschedule' });
    }
  } catch (emailErr) {
    console.error('Failed to send reschedule emails:', emailErr);
  }

  // Delete old Google Calendar event, create new one
  try {
    if (booking.calendar_event_id) {
      await deleteGoogleCalendarEvent(env, booking.user_id, booking.calendar_event_id);
    }
    const host = await env.DB.prepare(
      'SELECT email FROM users WHERE id = ?'
    ).bind(booking.user_id).first();
    if (host?.email) {
      const calEventId = await createGoogleCalendarEvent(env, booking.user_id, newBooking, { name: booking.event_type_name, duration_minutes: booking.duration_minutes }, host.email);
      if (calEventId) {
        await env.DB.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').bind(calEventId, newBooking.id).run();
      }
    }
  } catch (calErr) {
    console.error('Failed to update Google Calendar for reschedule:', calErr);
  }

  // Fire webhooks
  try {
    await fireWebhooks(env, booking.user_id, 'booking.rescheduled', {
      booking: {
        uid: newBooking.uid,
        previous_uid: booking.uid,
        event_type: booking.event_type_name,
        invitee_name: newBooking.invitee_name,
        invitee_email: newBooking.invitee_email,
        start_time: newBooking.start_time,
        end_time: newBooking.end_time,
        previous_start_time: booking.start_time,
        previous_end_time: booking.end_time,
        status: newBooking.status,
        timezone: newBooking.invitee_timezone,
      }
    });
  } catch (webhookErr) {
    console.error('Failed to fire reschedule webhooks:', webhookErr);
  }

  // Send Slack notification (fire and forget)
  try {
    await sendSlackNotification(env, booking.user_id, 'booking.rescheduled', {
      booking: {
        event_type: booking.event_type_name,
        invitee_name: newBooking.invitee_name,
        invitee_email: newBooking.invitee_email,
        start_time: newBooking.start_time,
        previous_start_time: booking.start_time,
      }
    });
  } catch (slackErr) {
    console.error('Slack notification error:', slackErr);
  }

  // Audit log for reschedule
  try {
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
    await logAuditEvent(env.DB, booking.user_id, 'booking.rescheduled', 'booking', newBooking.id, {
      previous_booking_id: booking.id,
      invitee_email: newBooking.invitee_email,
      new_start_time: newBooking.start_time,
      old_start_time: booking.start_time,
    }, clientIP);
  } catch (auditErr) {
    console.error('Audit log error:', auditErr);
  }

  return jsonResponse({
    ok: true,
    message: 'Booking rescheduled successfully',
    booking: {
      uid: newBooking.uid,
      event_name: booking.event_type_name,
      invitee_name: newBooking.invitee_name,
      invitee_email: newBooking.invitee_email,
      start_time: newBooking.start_time,
      end_time: newBooking.end_time,
      status: newBooking.status,
      timezone: newBooking.invitee_timezone,
      cancel_token: newBooking.cancel_token,
    },
  }, 201);
}

// ============================================================
// Public Booking Handlers
// ============================================================

async function handlePublicBooking(request, env, path) {
  // Path: /api/book/USERNAME/EVENT-SLUG
  const segments = path.replace('/api/book/', '').split('/');
  if (segments.length < 2) {
    return jsonResponse({ error: 'Invalid path. Expected /api/book/USERNAME/EVENT-SLUG' }, 400);
  }
  const username = segments[0];
  const eventSlug = segments[1];

  // Parse body
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name, email, timezone, start_time, answers, recurrence_rule, recurrence_end_date, phone, invitee_phone, link_token, coupon_code, guests, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = body;
  const phoneNumber = invitee_phone || phone || null;

  // Validate required fields
  if (!name || !name.trim()) {
    return jsonResponse({ error: 'Name is required' }, 400);
  }
  if (!email || !email.trim()) {
    return jsonResponse({ error: 'Email is required' }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400);
  }
  if (!start_time) {
    return jsonResponse({ error: 'start_time is required' }, 400);
  }

  // Look up booking page by username slug
  const page = await env.DB.prepare(
    'SELECT bp.user_id, bp.blocked_emails FROM booking_pages bp WHERE bp.slug = ?'
  ).bind(username).first();
  if (!page) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  // Check email blocklist
  if (page.blocked_emails) {
    const normalizedEmail = email.trim().toLowerCase();
    const patterns = page.blocked_emails.split('\n').map(p => p.trim().toLowerCase()).filter(Boolean);
    for (const pattern of patterns) {
      if (pattern.startsWith('@')) {
        // Domain pattern: block all emails from this domain
        if (normalizedEmail.endsWith(pattern)) {
          return jsonResponse({ error: 'This email is not allowed to book' }, 403);
        }
      } else {
        // Exact email match
        if (normalizedEmail === pattern) {
          return jsonResponse({ error: 'This email is not allowed to book' }, 403);
        }
      }
    }
  }

  // Look up event type
  const eventType = await env.DB.prepare(
    'SELECT * FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1'
  ).bind(page.user_id, eventSlug).first();
  if (!eventType) {
    return jsonResponse({ error: 'Event type not found' }, 404);
  }

  // Validate guest emails
  let guestEmails = [];
  if (guests && Array.isArray(guests) && guests.length > 0) {
    if (eventType.allow_guests === 0) {
      return jsonResponse({ error: 'This event type does not allow additional guests' }, 400);
    }
    if (guests.length > 10) {
      return jsonResponse({ error: 'Maximum 10 guests allowed' }, 400);
    }
    const emailRegex = EMAIL_RE;
    for (const g of guests) {
      if (typeof g !== 'string' || !emailRegex.test(g.trim())) {
        return jsonResponse({ error: `Invalid guest email: ${g}` }, 400);
      }
    }
    guestEmails = guests.map(g => g.trim().toLowerCase());
  }

  // Compute end_time
  const startDate = new Date(start_time);
  if (isNaN(startDate.getTime())) {
    return jsonResponse({ error: 'Invalid start_time format' }, 400);
  }
  const endDate = new Date(startDate.getTime() + eventType.duration_minutes * 60000);

  // Get availability schedule to verify the slot
  const scheduleId = eventType.availability_schedule_id;
  let schedule;
  if (scheduleId) {
    schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
    ).bind(scheduleId, page.user_id).first();
  }
  if (!schedule) {
    schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1'
    ).bind(page.user_id).first();
  }
  if (!schedule) {
    return jsonResponse({ error: 'No availability schedule configured' }, 404);
  }

  // Verify the slot is still available.
  // Validate against a ±1 day window around the invitee's local date: the
  // availability engine interprets range dates in the HOST's schedule
  // timezone, so a single day derived from the UTC timestamp misses slots
  // whose host-local date differs from their UTC date (e.g. a US host's
  // evening slots land on the next UTC day). Same fix as the reschedule path.
  const inviteeTz = timezone || 'UTC';
  const reqDateInTz = new Intl.DateTimeFormat('en-CA', {
    timeZone: inviteeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(startDate);
  const rangeStart = padDateStr(reqDateInTz, -1);
  const rangeEnd = padDateStr(reqDateInTz, 1);

  let availableSlots;
  let teamMembers = null;

  if (eventType.org_id && eventType.round_robin_mode) {
    const orgMembers = await env.DB.prepare(
      'SELECT om.user_id, om.round_robin_weight, om.round_robin_skip, om.round_robin_max_daily FROM org_members om WHERE om.org_id = ?'
    ).bind(eventType.org_id).all();

    teamMembers = [];
    for (const member of orgMembers.results) {
      let memberSchedule = null;
      if (eventType.availability_schedule_id) {
        memberSchedule = await env.DB.prepare(
          'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
        ).bind(eventType.availability_schedule_id, member.user_id).first();
      }
      if (!memberSchedule) {
        memberSchedule = await env.DB.prepare(
          'SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1'
        ).bind(member.user_id).first();
      }
      if (!memberSchedule) continue;

      const memberBookings = await env.DB.prepare(
        `SELECT b.start_time, b.end_time, b.status FROM bookings b
         JOIN event_types et ON b.event_type_id = et.id
         WHERE (et.user_id = ? OR b.assigned_user_id = ?) AND b.status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
         AND ${sqlUnixEpoch('b.start_time')} <= ${sqlUnixEpoch('?')}
         AND ${sqlUnixEpoch('b.end_time')} >= ${sqlUnixEpoch('?')}`
      ).bind(member.user_id, member.user_id, rangeEnd + 'T23:59:59Z', rangeStart + 'T00:00:00Z').all();

      const thirtyDaysAgo = formatDbTimestamp(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentCount = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM bookings
         WHERE assigned_user_id = ? AND status IN ('confirmed', 'pending')
         AND ${sqlUnixEpoch('created_at')} >= ${sqlUnixEpoch('?')}`
      ).bind(member.user_id, thirtyDaysAgo).first();

      teamMembers.push({
        userId: member.user_id,
        schedule: {
          rules: JSON.parse(memberSchedule.rules || '[]'),
          overrides: JSON.parse(memberSchedule.overrides || '[]'),
          holidays: JSON.parse(memberSchedule.holidays || '[]'),
          timezone: memberSchedule.timezone,
        },
        existingBookings: memberBookings.results,
        recentBookingCount: recentCount?.cnt || 0,
        weight: member.round_robin_weight || 1,
        skip: !!member.round_robin_skip,
        maxDaily: member.round_robin_max_daily || null,
        todayBookingCount: memberBookings.results.filter(b => b.status === 'confirmed').length,
      });
    }

    availableSlots = computeTeamAvailableSlots({
      members: teamMembers,
      eventType,
      dateRange: { start: rangeStart, end: rangeEnd },
      inviteeTimezone: inviteeTz,
    });
  } else {
    const bookingsResult = await env.DB.prepare(
      `SELECT start_time, end_time, status FROM bookings
       WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
       AND ${sqlUnixEpoch('start_time')} <= ${sqlUnixEpoch('?')}
       AND ${sqlUnixEpoch('end_time')} >= ${sqlUnixEpoch('?')}`
    ).bind(eventType.id, rangeEnd + 'T23:59:59Z', rangeStart + 'T00:00:00Z').all();

    const parsedSchedule = {
      rules: JSON.parse(schedule.rules || '[]'),
      overrides: JSON.parse(schedule.overrides || '[]'),
      holidays: JSON.parse(schedule.holidays || '[]'),
      timezone: schedule.timezone,
    };

    // For group events, only treat slots as blocked when group_max_attendees is reached
    let effectiveBookings = bookingsResult.results;
    if (eventType.group_max_attendees && eventType.group_max_attendees > 1) {
      const countByStart = {};
      for (const b of bookingsResult.results) {
        countByStart[b.start_time] = (countByStart[b.start_time] || 0) + 1;
      }
      effectiveBookings = [];
      for (const [startTime, count] of Object.entries(countByStart)) {
        if (count >= eventType.group_max_attendees) {
          effectiveBookings.push(bookingsResult.results.find(b => b.start_time === startTime));
        }
      }
    }

    availableSlots = computeAvailableSlots({
      schedule: parsedSchedule,
      eventType,
      existingBookings: effectiveBookings,
      dateRange: { start: rangeStart, end: rangeEnd },
      inviteeTimezone: inviteeTz,
    });
  }

  // Check if the requested time is in the available slots
  const requestedTimeInTz = new Intl.DateTimeFormat('en-US', {
    timeZone: inviteeTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(startDate);

  const reqParts = {};
  for (const { type, value } of requestedTimeInTz) {
    reqParts[type] = value;
  }
  const reqHour = reqParts.hour === '24' ? '00' : reqParts.hour;
  const reqTimeStr = `${reqHour}:${reqParts.minute}`;

  const daySlots = availableSlots[reqDateInTz] || [];
  if (!daySlots.includes(reqTimeStr)) {
    return jsonResponse({ error: 'This time slot is no longer available' }, 409);
  }

  // Re-check external calendar busy times at booking time. The availability
  // listing filters these, but the listing is only advisory — a calendar event
  // created after the invitee loaded the slots (or a direct API call) must not
  // double-book the host. Team events skip this, matching the listing.
  if (!(eventType.org_id && eventType.round_robin_mode)) {
    const busyConflict = await findCalendarBusyConflict(
      env, page.user_id, startDate, endDate,
      eventType.buffer_before || 0, eventType.buffer_after || 0
    );
    if (busyConflict) {
      return jsonResponse({ error: 'This time slot is no longer available' }, 409);
    }
  }

  // Enforce max_bookings_per_day at booking time (UTC day of the slot)
  const slotUtcDateStr = startDate.toISOString().slice(0, 10);
  if (eventType.max_bookings_per_day) {
    const dayBookingsCount = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM bookings
       WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
       AND start_time >= ? AND start_time < ?`
    ).bind(eventType.id, slotUtcDateStr + 'T00:00:00Z', slotUtcDateStr + 'T23:59:59Z').first();
    if (dayBookingsCount.cnt >= eventType.max_bookings_per_day) {
      return jsonResponse({ error: `Maximum ${eventType.max_bookings_per_day} bookings per day reached for this event type` }, 409);
    }
  }

  // Create booking
  const uid = crypto.randomUUID();
  const cancelToken = crypto.randomUUID();
  const startTimeISO = formatDbTimestamp(startDate);
  const endTimeISO = formatDbTimestamp(endDate);

  const status = (eventType.price_cents && eventType.price_cents > 0)
    ? 'pending_payment'
    : (eventType.requires_confirmation ? 'pending' : 'confirmed');

  // For team event types, determine the assigned member
  let assignedUserId = null;
  if (eventType.org_id && eventType.round_robin_mode && teamMembers) {
    if (eventType.round_robin_mode === 'round-robin') {
      assignedUserId = pickRoundRobinMember({
        members: teamMembers,
        slotStartTime: startDate.toISOString(),
        eventType,
      });
      if (assignedUserId === null) {
        return jsonResponse({ error: 'No team member is available for this time slot' }, 409);
      }
    }
    // For collective mode, no single assignment -- all members participate
  }

  // Validate recurrence fields
  const validRecurrenceRules = ['weekly', 'biweekly', 'monthly'];
  if (recurrence_rule && !validRecurrenceRules.includes(recurrence_rule)) {
    return jsonResponse({ error: 'Invalid recurrence_rule. Must be weekly, biweekly, or monthly' }, 400);
  }
  if (recurrence_rule && !recurrence_end_date) {
    return jsonResponse({ error: 'recurrence_end_date is required when recurrence_rule is set' }, 400);
  }

  // Validate single-use link if provided
  let singleUseLink = null;
  if (link_token) {
    singleUseLink = await env.DB.prepare(
      'SELECT * FROM single_use_links WHERE token = ? AND event_type_id = ?'
    ).bind(link_token, eventType.id).first();
    if (!singleUseLink) return jsonResponse({ error: 'Invalid booking link' }, 400);
    if (!singleUseLink.is_active) return jsonResponse({ error: 'This booking link has been revoked' }, 410);
    if (singleUseLink.use_count >= singleUseLink.max_uses) return jsonResponse({ error: 'This booking link has already been used' }, 410);
    if (singleUseLink.expires_at) {
      const exp = new Date(singleUseLink.expires_at.includes('T') ? singleUseLink.expires_at : singleUseLink.expires_at.replace(' ', 'T') + 'Z');
      if (exp < new Date()) return jsonResponse({ error: 'This booking link has expired' }, 410);
    }
  }

  const booking = await env.DB.prepare(
    `INSERT INTO bookings (event_type_id, uid, invitee_email, invitee_name, invitee_timezone, invitee_phone, start_time, end_time, status, answers, cancel_token, assigned_user_id, recurrence_rule, recurrence_end_date, guest_emails, utm_source, utm_medium, utm_campaign, utm_term, utm_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, uid, invitee_email, invitee_name, invitee_timezone, invitee_phone, start_time, end_time, status, cancel_token, assigned_user_id, answers, guest_emails, utm_source, utm_medium, utm_campaign, utm_term, utm_content, created_at`
  ).bind(
    eventType.id, uid, email.trim().toLowerCase(), name.trim(),
    inviteeTz, phoneNumber ? formatPhoneNumber(phoneNumber.trim()) : null, startTimeISO, endTimeISO, status,
    JSON.stringify(answers || {}), cancelToken,
    assignedUserId,
    recurrence_rule || null,
    recurrence_end_date || null,
    JSON.stringify(guestEmails),
    utm_source || null,
    utm_medium || null,
    utm_campaign || null,
    utm_term || null,
    utm_content || null
  ).first();

  // Optimistic double-booking guard: the availability check and the INSERT
  // above are not atomic, so two simultaneous requests for the same slot can
  // both pass verification. After inserting, the request whose row is not the
  // earliest overlapping one backs out. Group events allow up to
  // group_max_attendees rows per start time.
  if (!(eventType.org_id && eventType.round_robin_mode)) {
    const groupCapacity = (eventType.group_max_attendees && eventType.group_max_attendees > 1)
      ? eventType.group_max_attendees : 1;
    let lostRace = false;
    if (groupCapacity === 1) {
      const earlier = await env.DB.prepare(
        `SELECT id FROM bookings
         WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL}) AND id < ?
         AND ${sqlUnixEpoch('start_time')} < ${sqlUnixEpoch('?')}
         AND ${sqlUnixEpoch('end_time')} > ${sqlUnixEpoch('?')}`
      ).bind(eventType.id, booking.id, endTimeISO, startTimeISO).first();
      lostRace = !!earlier;
    } else {
      const seated = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM bookings
         WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL}) AND id < ? AND start_time = ?`
      ).bind(eventType.id, booking.id, startTimeISO).first();
      lostRace = (seated?.cnt || 0) >= groupCapacity;
    }
    if (lostRace) {
      await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(booking.id).run();
      return jsonResponse({ error: 'This time slot is no longer available' }, 409);
    }
  }

  // Mark single-use link as used
  if (singleUseLink) {
    await env.DB.prepare(
      "UPDATE single_use_links SET use_count = use_count + 1, used_at = COALESCE(used_at, datetime('now')), booking_id = ? WHERE id = ?"
    ).bind(booking.id, singleUseLink.id).run();
  }

  // Generate recurring bookings if recurrence_rule is set
  let recurringBookings = [];
  if (recurrence_rule && recurrence_end_date) {
    const endDateLimit = new Date(recurrence_end_date + 'T23:59:59Z');
    const maxRecurrences = 52;
    let currentDate = new Date(startDate.getTime());
    let count = 0;

    while (count < maxRecurrences) {
      if (recurrence_rule === 'weekly') {
        currentDate.setDate(currentDate.getDate() + 7);
      } else if (recurrence_rule === 'biweekly') {
        currentDate.setDate(currentDate.getDate() + 14);
      } else if (recurrence_rule === 'monthly') {
        currentDate.setMonth(currentDate.getMonth() + 1);
      }

      if (currentDate > endDateLimit) break;

      const recEndDate = new Date(currentDate.getTime() + eventType.duration_minutes * 60000);
      const recStartISO = formatDbTimestamp(currentDate);
      const recEndISO = formatDbTimestamp(recEndDate);

      const conflicts = await env.DB.prepare(
        `SELECT id FROM bookings
         WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
         AND ${sqlUnixEpoch('start_time')} < ${sqlUnixEpoch('?')}
         AND ${sqlUnixEpoch('end_time')} > ${sqlUnixEpoch('?')}`
      ).bind(eventType.id, recEndISO, recStartISO).first();

      if (conflicts) {
        count++;
        continue;
      }

      const recUid = crypto.randomUUID();
      const recCancelToken = crypto.randomUUID();

      const recBooking = await env.DB.prepare(
        `INSERT INTO bookings (event_type_id, uid, invitee_email, invitee_name, invitee_timezone, start_time, end_time, status, answers, cancel_token, recurrence_parent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, uid, start_time, end_time, status`
      ).bind(
        eventType.id, recUid, email.trim().toLowerCase(), name.trim(),
        inviteeTz, recStartISO, recEndISO, status,
        JSON.stringify(answers || {}), recCancelToken, booking.id
      ).first();

      if (recBooking) recurringBookings.push(recBooking);
      count++;
    }
  }

  // Skip side effects for paid bookings (emails, calendar, webhooks happen after payment)
  if (status === 'pending_payment') {
    // Validate and apply coupon if provided
    let finalPriceCents = eventType.price_cents;
    let appliedCoupon = null;
    if (coupon_code) {
      const normalizedCode = coupon_code.trim().toUpperCase();
      const coupon = await env.DB.prepare(
        'SELECT * FROM coupons WHERE user_id = ? AND code = ? AND is_active = 1'
      ).bind(page.user_id, normalizedCode).first();
      if (coupon) {
        const isExpired = coupon.expires_at && new Date((coupon.expires_at.includes('T') ? coupon.expires_at : coupon.expires_at.replace(' ', 'T') + 'Z')) < new Date();
        const isMaxed = coupon.max_uses && coupon.use_count >= coupon.max_uses;
        // Check event type applicability
        let appliesToParsed = coupon.applies_to;
        try { appliesToParsed = JSON.parse(coupon.applies_to); } catch {}
        const appliesToThisEvent = appliesToParsed === 'all' || (Array.isArray(appliesToParsed) && appliesToParsed.includes(eventType.id));

        if (!isExpired && !isMaxed && appliesToThisEvent) {
          appliedCoupon = coupon;
          if (coupon.discount_type === 'percent') {
            finalPriceCents = Math.max(0, Math.round(finalPriceCents * (1 - coupon.discount_value / 100)));
          } else {
            finalPriceCents = Math.max(0, finalPriceCents - coupon.discount_value);
          }
          // Record the coupon on the booking. use_count is incremented only
          // when the booking actually confirms (free path below, Stripe
          // webhook, PayPal capture) — incrementing at checkout creation let
          // abandoned checkouts burn limited-use coupons.
          await env.DB.prepare('UPDATE bookings SET coupon_id = ? WHERE id = ?').bind(coupon.id, booking.id).run();
        }
      }
    }

    // If coupon made it free, skip payment. The booking still goes through
    // host confirmation when the event type requires it — a 100% coupon must
    // not bypass approval.
    if (finalPriceCents <= 0) {
      const freeStatus = eventType.requires_confirmation ? 'pending' : 'confirmed';
      await env.DB.prepare('UPDATE bookings SET status = ? WHERE id = ?').bind(freeStatus, booking.id).run();
      booking.status = freeStatus;
      if (appliedCoupon) {
        await env.DB.prepare('UPDATE coupons SET use_count = use_count + 1 WHERE id = ?').bind(appliedCoupon.id).run();
      }
      await runBookingCreatedSideEffects(env, {
        booking,
        eventType,
        hostUserId: page.user_id,
        appOrigin: new URL(request.url).origin,
        clientIP: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null,
      });
      return jsonResponse({
        booking: { uid: booking.uid, event_name: eventType.name, invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, start_time: booking.start_time, end_time: booking.end_time, status: booking.status, timezone: booking.invitee_timezone, location: null, cancel_token: cancelToken, guest_emails: guestEmails },
        redirect_url: eventType.redirect_url || null,
        coupon_applied: appliedCoupon ? { code: appliedCoupon.code, discount: appliedCoupon.discount_type === 'percent' ? `${appliedCoupon.discount_value}%` : `$${(appliedCoupon.discount_value / 100).toFixed(2)}` } : null,
      }, 201);
    }

    const appOrigin = new URL(request.url).origin;
    const paymentMethodType = eventType.payment_method || 'stripe';

    // PayPal payment flow
    if (paymentMethodType === 'paypal') {
      try {
        // Get the host user's PayPal credentials
        const hostUser = await env.DB.prepare('SELECT paypal_client_id_encrypted, paypal_client_secret_encrypted, paypal_mode FROM users WHERE id = ?').bind(page.user_id).first();
        if (!hostUser?.paypal_client_id_encrypted || !hostUser?.paypal_client_secret_encrypted) {
          console.error('PayPal credentials not configured for user', page.user_id);
          return jsonResponse({
            booking: { uid: booking.uid, event_name: eventType.name, invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, start_time: booking.start_time, end_time: booking.end_time, status: booking.status, timezone: booking.invitee_timezone, location: null, cancel_token: cancelToken, guest_emails: guestEmails },
            redirect_url: eventType.redirect_url || null,
            error: 'PayPal is not configured. Please contact the host.',
          }, 201);
        }

        const paypalClientId = await decryptToken(hostUser.paypal_client_id_encrypted, env.ENCRYPTION_KEY);
        const paypalClientSecret = await decryptToken(hostUser.paypal_client_secret_encrypted, env.ENCRYPTION_KEY);
        const paypalMode = hostUser.paypal_mode || 'sandbox';

        const accessToken = await getPayPalAccessToken(paypalClientId, paypalClientSecret, paypalMode);
        const { orderId, approvalUrl } = await createPayPalOrder({
          accessToken,
          mode: paypalMode,
          eventType: { ...eventType, price_cents: finalPriceCents },
          booking,
          returnUrl: `${appOrigin}/api/payments/paypal/capture?token=${booking.uid}`,
          cancelUrl: `${appOrigin}/booking/cancelled?uid=${booking.uid}`,
        });

        // Store the PayPal order ID in payments table
        await env.DB.prepare(
          `INSERT INTO payments (booking_id, amount_cents, currency, paypal_order_id, status) VALUES (?, ?, ?, ?, 'pending')`
        ).bind(booking.id, finalPriceCents, eventType.currency || 'usd', orderId).run();

        return jsonResponse({
          booking: { uid: booking.uid, event_name: eventType.name, invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, start_time: booking.start_time, end_time: booking.end_time, status: booking.status, timezone: booking.invitee_timezone, location: null, cancel_token: cancelToken, guest_emails: guestEmails },
          checkout_url: approvalUrl,
          payment_method: 'paypal',
          redirect_url: eventType.redirect_url || null,
          coupon_applied: appliedCoupon ? { code: appliedCoupon.code, discount: appliedCoupon.discount_type === 'percent' ? `${appliedCoupon.discount_value}%` : `$${(appliedCoupon.discount_value / 100).toFixed(2)}` } : null,
        }, 201);
      } catch (paypalErr) {
        console.error('PayPal checkout error:', paypalErr);
      }
    }

    // Stripe payment flow (default)
    if (paymentMethodType === 'stripe' && env.STRIPE_SECRET_KEY) {
      try {
        const checkoutUrl = await createCheckoutSession(env, {
          eventType: { ...eventType, price_cents: finalPriceCents },
          booking,
          successUrl: `${appOrigin}/booking/confirmed?uid=${booking.uid}`,
          cancelUrl: `${appOrigin}/booking/cancelled?uid=${booking.uid}`,
        });
        return jsonResponse({
          booking: { uid: booking.uid, event_name: eventType.name, invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, start_time: booking.start_time, end_time: booking.end_time, status: booking.status, timezone: booking.invitee_timezone, location: null, cancel_token: cancelToken, guest_emails: guestEmails },
          checkout_url: checkoutUrl,
          redirect_url: eventType.redirect_url || null,
          coupon_applied: appliedCoupon ? { code: appliedCoupon.code, discount: appliedCoupon.discount_type === 'percent' ? `${appliedCoupon.discount_value}%` : `$${(appliedCoupon.discount_value / 100).toFixed(2)}` } : null,
        }, 201);
      } catch (stripeErr) {
        console.error('Stripe checkout error:', stripeErr);
      }
    }
    return jsonResponse({
      booking: { uid: booking.uid, event_name: eventType.name, invitee_name: booking.invitee_name, invitee_email: booking.invitee_email, start_time: booking.start_time, end_time: booking.end_time, status: booking.status, timezone: booking.invitee_timezone, location: null, cancel_token: cancelToken, guest_emails: guestEmails },
      redirect_url: eventType.redirect_url || null,
    }, 201);
  }

  await runBookingCreatedSideEffects(env, {
    booking,
    eventType,
    hostUserId: page.user_id,
    appOrigin: new URL(request.url).origin,
    clientIP: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null,
  });

  return jsonResponse({
    booking: {
      uid: booking.uid,
      event_name: eventType.name,
      invitee_name: booking.invitee_name,
      invitee_email: booking.invitee_email,
      start_time: booking.start_time,
      end_time: booking.end_time,
      status: booking.status,
      timezone: booking.invitee_timezone,
      location: booking.location || null,
      cancel_token: cancelToken,
      recurrence_rule: recurrence_rule || null,
      recurring_count: recurringBookings.length,
      guest_emails: guestEmails,
      utm_source: booking.utm_source || null,
      utm_medium: booking.utm_medium || null,
      utm_campaign: booking.utm_campaign || null,
      utm_term: booking.utm_term || null,
      utm_content: booking.utm_content || null,
    },
    redirect_url: eventType.redirect_url || null,
  }, 201);
}

// The host's effective timezone for emails is the timezone of the availability
// schedule the booking used (what the host actually set — e.g. IST), falling back
// to the event type's default schedule, then the user's profile timezone. The
// profile timezone (users.timezone) is historically just the signup default and
// is never updated, so it can't be trusted on its own.
export async function resolveHostTimezone(env, hostUserId, eventType, profileTz) {
  try {
    if (eventType && eventType.availability_schedule_id) {
      const s = await env.DB.prepare(
        'SELECT timezone FROM availability_schedules WHERE id = ? AND user_id = ?'
      ).bind(eventType.availability_schedule_id, hostUserId).first();
      if (s && s.timezone) return s.timezone;
    }
    const def = await env.DB.prepare(
      'SELECT timezone FROM availability_schedules WHERE user_id = ? AND is_default = 1'
    ).bind(hostUserId).first();
    if (def && def.timezone) return def.timezone;
  } catch (err) {
    console.error('resolveHostTimezone failed:', err);
  }
  return profileTz || 'UTC';
}

async function runBookingCreatedSideEffects(env, { booking, eventType, hostUserId, appOrigin, clientIP }) {
  let host = null;

  try {
    host = await env.DB.prepare(
      'SELECT id, name, email, timezone FROM users WHERE id = ?'
    ).bind(hostUserId).first();

    if (host) {
      // Format host-facing emails in the host's real (schedule) timezone.
      host.timezone = await resolveHostTimezone(env, hostUserId, eventType, host.timezone);

      const confirmData = bookingConfirmationEmail(booking, eventType, host, appOrigin);
      await sendEmail(env, {
        to: booking.invitee_email,
        subject: confirmData.subject,
        html: confirmData.html,
        text: confirmData.text,
        bookingId: booking.id,
        type: 'confirmation',
      });

      const hostNotifData = hostNotificationEmail(booking, eventType, host);
      await sendEmail(env, {
        to: host.email,
        subject: hostNotifData.subject,
        html: hostNotifData.html,
        text: hostNotifData.text,
        bookingId: booking.id,
        type: 'confirmation',
      });

      // Send notification emails to guests
      if (booking.guest_emails) {
        try {
          const guestList = typeof booking.guest_emails === 'string' ? JSON.parse(booking.guest_emails) : booking.guest_emails;
          if (Array.isArray(guestList)) {
            for (const guestEmail of guestList) {
              if (guestEmail && guestEmail.trim()) {
                const guestData = guestNotificationEmail(booking, eventType, host);
                await sendEmail(env, {
                  to: guestEmail.trim(),
                  subject: guestData.subject,
                  html: guestData.html,
                  text: guestData.text,
                  bookingId: booking.id,
                  type: 'confirmation',
                });
              }
            }
          }
        } catch (guestEmailErr) {
          console.error('Failed to send guest notification emails:', guestEmailErr);
        }
      }
    }
  } catch (emailErr) {
    console.error('Failed to send booking emails:', emailErr);
  }

  if (booking.invitee_phone) {
    try {
      const dateStr = parseStoredUtcDate(booking.start_time).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      await sendSMS(env, {
        to: booking.invitee_phone,
        body: `Calendo: Your ${eventType.name} booking is confirmed for ${dateStr}.`,
        bookingId: booking.id,
        type: 'confirmation',
      });
    } catch (smsErr) {
      console.error('Failed to send booking SMS:', smsErr);
    }
  }

  try {
    const locType = eventType.location_type;
    let meetingUrl = null;

    if (locType === 'zoom') {
      meetingUrl = await createZoomMeeting(env, hostUserId, booking, eventType);
    } else if (locType === 'google_meet') {
      const meetResult = await createGoogleMeetLink(env, hostUserId, booking, eventType);
      if (meetResult) {
        meetingUrl = meetResult.meetLink;
        if (meetResult.calendarEventId) {
          await env.DB.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').bind(meetResult.calendarEventId, booking.id).run();
          booking.calendar_event_id = meetResult.calendarEventId;
        }
      }
    } else if (locType === 'teams') {
      meetingUrl = await createTeamsMeeting(env, hostUserId, booking, eventType);
    }

    if (meetingUrl) {
      await env.DB.prepare('UPDATE bookings SET location = ? WHERE id = ?').bind(meetingUrl, booking.id).run();
      booking.location = meetingUrl;
    }
  } catch (videoErr) {
    console.error('Failed to create video conferencing link:', videoErr);
  }

  if (!booking.calendar_event_id && host?.email) {
    try {
      const calEventId = await createGoogleCalendarEvent(env, hostUserId, booking, eventType, host.email);
      if (calEventId) {
        await env.DB.prepare(
          'UPDATE bookings SET calendar_event_id = ? WHERE id = ?'
        ).bind(calEventId, booking.id).run();
        booking.calendar_event_id = calEventId;
      }
    } catch (calErr) {
      console.error('Failed to create Google Calendar event:', calErr);
    }
  }

  try {
    const outlookConnections = await env.DB.prepare(
      'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1'
    ).bind(hostUserId, 'outlook').all();

    if (outlookConnections.results && outlookConnections.results.length > 0) {
      const outlookConn = outlookConnections.results[0];
      const outlookEventId = await createOutlookCalendarEvent(env, outlookConn, booking, eventType);
      if (outlookEventId && !booking.calendar_event_id) {
        await env.DB.prepare('UPDATE bookings SET calendar_event_id = ? WHERE id = ?').bind(outlookEventId, booking.id).run();
        booking.calendar_event_id = outlookEventId;
      }
    }
  } catch (outlookErr) {
    console.error('Failed to create Outlook Calendar event:', outlookErr);
  }

  try {
    const webhookPayload = {
      booking: {
        uid: booking.uid,
        event_type: eventType.name,
        invitee_name: booking.invitee_name,
        invitee_email: booking.invitee_email,
        start_time: booking.start_time,
        end_time: booking.end_time,
        status: booking.status,
        timezone: booking.invitee_timezone,
      }
    };
    // Include UTM params if any are present
    if (booking.utm_source || booking.utm_medium || booking.utm_campaign || booking.utm_term || booking.utm_content) {
      webhookPayload.booking.utm = {};
      if (booking.utm_source) webhookPayload.booking.utm.source = booking.utm_source;
      if (booking.utm_medium) webhookPayload.booking.utm.medium = booking.utm_medium;
      if (booking.utm_campaign) webhookPayload.booking.utm.campaign = booking.utm_campaign;
      if (booking.utm_term) webhookPayload.booking.utm.term = booking.utm_term;
      if (booking.utm_content) webhookPayload.booking.utm.content = booking.utm_content;
    }
    await fireWebhooks(env, hostUserId, 'booking.created', webhookPayload);
  } catch (webhookErr) {
    console.error('Failed to fire webhooks:', webhookErr);
  }

  // Send Slack notification (fire and forget)
  try {
    await sendSlackNotification(env, hostUserId, 'booking.created', {
      booking: {
        event_type: eventType.name,
        invitee_name: booking.invitee_name,
        invitee_email: booking.invitee_email,
        start_time: booking.start_time,
        end_time: booking.end_time,
      }
    });
  } catch (slackErr) {
    console.error('Slack notification error:', slackErr);
  }

  // Audit log for booking creation
  try {
    await logAuditEvent(env.DB, hostUserId, 'booking.created', 'booking', booking.id, {
      invitee_email: booking.invitee_email,
      invitee_name: booking.invitee_name,
      event_type: eventType.name,
      start_time: booking.start_time,
    }, clientIP);
  } catch (auditErr) {
    console.error('Audit log error:', auditErr);
  }
}

// ============================================================
// Slot Debug - Why is a time unavailable?
// ============================================================

async function handleSlotDebug(request, env, url, path, user) {
  // Path: /api/slot-debug/USERNAME/EVENT-SLUG
  const segments = path.replace('/api/slot-debug/', '').split('/');
  if (segments.length < 2) return jsonResponse({ error: 'Expected /api/slot-debug/USERNAME/EVENT-SLUG' }, 400);

  const username = segments[0];
  const eventSlug = segments[1];
  const slotTime = url.searchParams.get('time'); // ISO 8601 e.g. 2026-04-10T14:00:00
  const timezone = url.searchParams.get('timezone') || 'UTC';

  if (!slotTime) return jsonResponse({ error: 'time query parameter is required (ISO 8601)' }, 400);

  const page = await env.DB.prepare('SELECT user_id FROM booking_pages WHERE slug = ?').bind(username).first();
  // Same 404 for "no such page" and "not your page" so the endpoint can't be used
  // to probe other hosts.
  if (!page || !user || page.user_id !== user.id) return jsonResponse({ error: 'User not found' }, 404);

  const eventType = await env.DB.prepare(
    'SELECT * FROM event_types WHERE user_id = ? AND slug = ?'
  ).bind(page.user_id, eventSlug).first();
  if (!eventType) return jsonResponse({ error: 'Event type not found' }, 404);

  const schedule = eventType.availability_schedule_id
    ? await env.DB.prepare('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?').bind(eventType.availability_schedule_id, page.user_id).first()
    : await env.DB.prepare('SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1').bind(page.user_id).first();
  if (!schedule) return jsonResponse({ error: 'No availability schedule' }, 404);

  const reasons = [];

  // Parse the requested slot time — interpret in caller's timezone if no Z/offset
  let slotDate;
  if (slotTime.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(slotTime)) {
    slotDate = new Date(slotTime);
  } else {
    // Interpret slotTime in the caller's timezone
    const roughUtc = new Date(slotTime + 'Z');
    const utcParts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(roughUtc);
    const tzParts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(roughUtc);
    const utcH = parseInt(utcParts.find(p => p.type === 'hour').value);
    const utcM = parseInt(utcParts.find(p => p.type === 'minute').value);
    const tzH = parseInt(tzParts.find(p => p.type === 'hour').value === '24' ? '0' : tzParts.find(p => p.type === 'hour').value);
    const tzM = parseInt(tzParts.find(p => p.type === 'minute').value);
    const offsetMs = ((tzH * 60 + tzM) - (utcH * 60 + utcM)) * 60000;
    slotDate = new Date(roughUtc.getTime() - offsetMs);
  }
  if (isNaN(slotDate.getTime())) return jsonResponse({ error: 'Invalid time format' }, 400);

  const rules = JSON.parse(schedule.rules || '[]');
  const overrides = JSON.parse(schedule.overrides || '[]');
  const holidays = JSON.parse(schedule.holidays || '[]');
  const scheduleTz = schedule.timezone;

  // Which date is this in the schedule timezone?
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: scheduleTz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const parts = {};
  for (const { type, value } of tzFormatter.formatToParts(slotDate)) parts[type] = value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[parts.weekday];
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const timeStr = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;

  // Check 1: Holiday
  const holiday = holidays.find(h => h.date === dateStr);
  if (holiday) reasons.push({ reason: 'holiday', detail: `Blocked by holiday: ${holiday.name}` });

  // Check 2: Override
  const override = overrides.find(o => o.date === dateStr);
  if (override) {
    if (override.available === false) {
      reasons.push({ reason: 'date_override', detail: `Date ${dateStr} is blocked by a date override` });
    } else if (override.start && override.end) {
      if (timeStr < override.start || timeStr >= override.end) {
        reasons.push({ reason: 'date_override', detail: `Override hours are ${override.start}-${override.end}, requested ${timeStr}` });
      }
    }
  }

  // Check 3: Weekly schedule
  if (!override) {
    const dayRules = rules.filter(r => r.day === dayOfWeek);
    if (dayRules.length === 0) {
      reasons.push({ reason: 'no_schedule', detail: `No availability rules for ${parts.weekday} (day ${dayOfWeek})` });
    } else {
      const inWindow = dayRules.some(r => timeStr >= r.start && timeStr < r.end);
      if (!inWindow) {
        const windows = dayRules.map(r => `${r.start}-${r.end}`).join(', ');
        reasons.push({ reason: 'outside_hours', detail: `Time ${timeStr} is outside scheduled hours: ${windows}` });
      }
    }
  }

  // Check 4: Min notice
  const minNoticeMs = (eventType.min_notice_hours || 4) * 60 * 60 * 1000;
  if (slotDate.getTime() - Date.now() < minNoticeMs) {
    reasons.push({ reason: 'min_notice', detail: `Requires ${eventType.min_notice_hours || 4}h notice, slot is too soon` });
  }

  // Check 5: Max future days
  const maxFutureDays = eventType.max_future_days || 60;
  if (slotDate.getTime() - Date.now() > maxFutureDays * 24 * 60 * 60 * 1000) {
    reasons.push({ reason: 'max_future', detail: `Slot is more than ${maxFutureDays} days in the future` });
  }

  // Check 6: Existing booking conflict
  const slotEnd = new Date(slotDate.getTime() + eventType.duration_minutes * 60000);
  const bufferBefore = eventType.buffer_before || 0;
  const bufferAfter = eventType.buffer_after || 0;
  const bufferedStart = new Date(slotDate.getTime() - bufferBefore * 60000);
  const bufferedEnd = new Date(slotEnd.getTime() + bufferAfter * 60000);

  const conflicts = await env.DB.prepare(
    `SELECT b.start_time, b.end_time, b.invitee_name, b.status FROM bookings b
     WHERE b.event_type_id = ? AND b.status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
     AND ${sqlUnixEpoch('b.start_time')} < ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('b.end_time')} > ${sqlUnixEpoch('?')}`
  ).bind(eventType.id, bufferedEnd.toISOString(), bufferedStart.toISOString()).all();

  if (conflicts.results.length > 0) {
    for (const c of conflicts.results) {
      reasons.push({ reason: 'booking_conflict', detail: `Conflicts with booking ${c.start_time} - ${c.end_time} (${c.status})` });
    }
  }

  // Check 7: Daily booking cap
  if (eventType.max_bookings_per_day) {
    const dayStart = dateStr + 'T00:00:00Z';
    const dayEnd = dateStr + 'T23:59:59Z';
    const dayCount = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM bookings WHERE event_type_id = ? AND status = 'confirmed'
       AND ${sqlUnixEpoch('start_time')} >= ${sqlUnixEpoch('?')} AND ${sqlUnixEpoch('start_time')} <= ${sqlUnixEpoch('?')}`
    ).bind(eventType.id, dayStart, dayEnd).first();
    if (dayCount.cnt >= eventType.max_bookings_per_day) {
      reasons.push({ reason: 'daily_cap', detail: `Daily cap of ${eventType.max_bookings_per_day} bookings reached (${dayCount.cnt} booked)` });
    }
  }

  // Check 8: Google Calendar conflict
  try {
    const busyTimes = await getGoogleBusyTimes(env, page.user_id, bufferedStart.toISOString(), bufferedEnd.toISOString());
    for (const bt of busyTimes) {
      const bStart = new Date(bt.start).getTime();
      const bEnd = new Date(bt.end).getTime();
      if (bufferedStart.getTime() < bEnd && bufferedEnd.getTime() > bStart) {
        reasons.push({ reason: 'google_calendar', detail: `Conflict with Google Calendar event ${bt.start} - ${bt.end}` });
      }
    }
  } catch {}

  // Check 9: Outlook Calendar conflict
  try {
    const outlookConns = await env.DB.prepare(
      'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
    ).bind(page.user_id, 'outlook').all();
    for (const conn of outlookConns.results) {
      try {
        const busyTimes = await getOutlookBusyTimes(env, conn, bufferedStart.toISOString(), bufferedEnd.toISOString());
        for (const bt of busyTimes) {
          const bStart = new Date(bt.start).getTime();
          const bEnd = new Date(bt.end).getTime();
          if (bufferedStart.getTime() < bEnd && bufferedEnd.getTime() > bStart) {
            reasons.push({ reason: 'outlook_calendar', detail: `Conflict with Outlook event ${bt.start} - ${bt.end}` });
          }
        }
      } catch {}
    }
  } catch {}

  return jsonResponse({
    slot: slotTime,
    date: dateStr,
    time: timeStr,
    timezone: scheduleTz,
    available: reasons.length === 0,
    reasons,
  });
}

async function handleGetBookingPage(request, env, path) {
  const username = path.replace('/api/booking-page/', '');
  const page = await env.DB.prepare(
    `SELECT bp.*, u.name, u.avatar_url
     FROM booking_pages bp
     JOIN users u ON bp.user_id = u.id
     WHERE bp.slug = ?`
  ).bind(username).first();
  if (!page) return jsonResponse({ error: 'Not found' }, 404);

  const eventTypes = await env.DB.prepare(
    `SELECT id, name, slug, description, duration_minutes, color, location_type, location_config, questions, locked_timezone, price_cents, currency, payment_method, redirect_url, allow_guests, group_max_attendees, reminder_settings
     FROM event_types
     WHERE user_id = ? AND is_active = 1 AND is_secret = 0
     ORDER BY sort_order ASC, created_at ASC`
  ).bind(page.user_id).all();

  const results = eventTypes.results || [];

  // If an event slug is provided (direct link), include that event type even if secret
  const reqUrl = new URL(request.url);
  const eventSlug = reqUrl.searchParams.get('event');
  if (eventSlug && !results.find(e => e.slug === eventSlug)) {
    const secretEvent = await env.DB.prepare(
      `SELECT id, name, slug, description, duration_minutes, color, location_type, location_config, questions, locked_timezone, price_cents, currency, payment_method, redirect_url, allow_guests, group_max_attendees, reminder_settings
       FROM event_types
       WHERE user_id = ? AND slug = ? AND is_active = 1 AND is_secret = 1`
    ).bind(page.user_id, eventSlug).first();
    if (secretEvent) {
      results.push(secretEvent);
    }
  }

  return jsonResponse({ page, eventTypes: results });
}

async function handleGetPublicAvailability(request, env, url, path) {
  // Path: /api/availability/USERNAME/EVENT-SLUG
  const segments = path.replace('/api/availability/', '').split('/');
  if (segments.length < 2) {
    return jsonResponse({ error: 'Invalid path. Expected /api/availability/USERNAME/EVENT-SLUG' }, 400);
  }
  const username = segments[0];
  const eventSlug = segments[1];

  // Look up booking page by username slug
  const page = await env.DB.prepare(
    'SELECT bp.user_id FROM booking_pages bp WHERE bp.slug = ?'
  ).bind(username).first();
  if (!page) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  // Look up event type by slug and user_id
  const eventType = await env.DB.prepare(
    'SELECT * FROM event_types WHERE user_id = ? AND slug = ? AND is_active = 1'
  ).bind(page.user_id, eventSlug).first();
  if (!eventType) {
    return jsonResponse({ error: 'Event type not found' }, 404);
  }

  // Get availability schedule
  const scheduleId = eventType.availability_schedule_id;
  let schedule;
  if (scheduleId) {
    schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
    ).bind(scheduleId, page.user_id).first();
  }
  if (!schedule) {
    // Fall back to default schedule
    schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1'
    ).bind(page.user_id).first();
  }
  if (!schedule) {
    return jsonResponse({ error: 'No availability schedule configured' }, 404);
  }

  // Parse query params
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const timezone = url.searchParams.get('timezone') || 'UTC';

  if (!start || !end) {
    return jsonResponse({ error: 'start and end query parameters are required (YYYY-MM-DD)' }, 400);
  }

  // Get existing bookings for this event type in the date range
  const bookingsResult = await env.DB.prepare(
    `SELECT start_time, end_time, status FROM bookings
     WHERE event_type_id = ? AND status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
     AND ${sqlUnixEpoch('start_time')} <= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('end_time')} >= ${sqlUnixEpoch('?')}`
  ).bind(eventType.id, end + 'T23:59:59Z', start + 'T00:00:00Z').all();

  // Check if this is a team event type
  if (eventType.org_id && eventType.round_robin_mode) {
    // Fetch all org members' schedules and bookings
    const orgMembers = await env.DB.prepare(
      'SELECT om.user_id FROM org_members om WHERE om.org_id = ?'
    ).bind(eventType.org_id).all();

    const members = [];
    for (const member of orgMembers.results) {
      // Get member's availability schedule
      let memberSchedule = null;
      if (eventType.availability_schedule_id) {
        memberSchedule = await env.DB.prepare(
          'SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?'
        ).bind(eventType.availability_schedule_id, member.user_id).first();
      }
      if (!memberSchedule) {
        memberSchedule = await env.DB.prepare(
          'SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1'
        ).bind(member.user_id).first();
      }
      if (!memberSchedule) continue;

      // Get member's existing bookings (all their event types)
      const memberBookings = await env.DB.prepare(
        `SELECT b.start_time, b.end_time, b.status FROM bookings b
         JOIN event_types et ON b.event_type_id = et.id
         WHERE (et.user_id = ? OR b.assigned_user_id = ?) AND b.status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})
         AND ${sqlUnixEpoch('b.start_time')} <= ${sqlUnixEpoch('?')}
         AND ${sqlUnixEpoch('b.end_time')} >= ${sqlUnixEpoch('?')}`
      ).bind(member.user_id, member.user_id, end + 'T23:59:59Z', start + 'T00:00:00Z').all();

      members.push({
        userId: member.user_id,
        schedule: {
          rules: JSON.parse(memberSchedule.rules || '[]'),
          overrides: JSON.parse(memberSchedule.overrides || '[]'),
          holidays: JSON.parse(memberSchedule.holidays || '[]'),
          timezone: memberSchedule.timezone,
        },
        existingBookings: memberBookings.results,
      });
    }

    const slots = computeTeamAvailableSlots({
      members,
      eventType,
      dateRange: { start, end },
      inviteeTimezone: timezone,
    });

    return jsonResponse({ slots });
  }

  // Parse schedule JSON fields
  const parsedSchedule = {
    rules: JSON.parse(schedule.rules || '[]'),
    overrides: JSON.parse(schedule.overrides || '[]'),
    holidays: JSON.parse(schedule.holidays || '[]'),
    timezone: schedule.timezone,
  };

  // For group events, don't treat individual bookings as blocking
  const groupMax = eventType.group_max_attendees;
  let effectiveBookings = bookingsResult.results;
  let spotsInfo = null;

  if (groupMax && groupMax > 1) {
    const countByStart = {};
    for (const b of bookingsResult.results) {
      countByStart[b.start_time] = (countByStart[b.start_time] || 0) + 1;
    }
    effectiveBookings = [];
    spotsInfo = {};
    for (const [startTime, count] of Object.entries(countByStart)) {
      if (count >= groupMax) {
        effectiveBookings.push(bookingsResult.results.find(b => b.start_time === startTime));
      } else {
        spotsInfo[startTime] = groupMax - count;
      }
    }
  }

  // Compute available slots
  const slots = computeAvailableSlots({
    schedule: parsedSchedule,
    eventType,
    existingBookings: effectiveBookings,
    dateRange: { start, end },
    inviteeTimezone: timezone,
  });

  // Filter out slots that conflict with Google Calendar busy times
  try {
    const busyTimes = await getGoogleBusyTimes(env, page.user_id, start + 'T00:00:00Z', end + 'T23:59:59Z');
    if (busyTimes.length > 0) {
      const busyRanges = busyTimes.map(bt => ({
        start: new Date(bt.start).getTime(),
        end: new Date(bt.end).getTime(),
      }));
      removeSlotsOverlappingBusyRanges(slots, busyRanges, eventType, timezone);
    }
  } catch (err) {
    console.error('Failed to fetch Google busy times for availability:', err);
    // Non-fatal — return slots without Google filtering
  }

  // Filter out slots that conflict with Outlook Calendar busy times
  try {
    const outlookConnections = await env.DB.prepare(
      'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
    ).bind(page.user_id, 'outlook').all();

    if (outlookConnections.results && outlookConnections.results.length > 0) {
      for (const outlookConn of outlookConnections.results) {
        const outlookBusy = await getOutlookBusyTimes(env, outlookConn, start + 'T00:00:00Z', end + 'T23:59:59Z');
        if (outlookBusy.length > 0) {
          const busyRanges = outlookBusy.map(bt => ({ start: new Date(bt.start).getTime(), end: new Date(bt.end).getTime() }));
          removeSlotsOverlappingBusyRanges(slots, busyRanges, eventType, timezone);
        }
      }
    }
  } catch (err) {
    console.error('Failed to fetch Outlook busy times for availability:', err);
  }

  const availResponse = { slots };
  if (groupMax && groupMax > 1) {
    availResponse.group_max_attendees = groupMax;
    availResponse.spots_left = spotsInfo || {};
  }
  return jsonResponse(availResponse);
}

// ============================================================
// Booking Page Handlers
// ============================================================

async function handleGetMyBookingPage(request, env, user) {
  const page = await env.DB.prepare(
    'SELECT * FROM booking_pages WHERE user_id = ?'
  ).bind(user.id).first();
  if (!page) return jsonResponse({ error: 'Not found' }, 404);
  return jsonResponse(page);
}

async function handleUpdateBookingPage(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  if (body.display_name !== undefined) fields.display_name = body.display_name.trim();
  if (body.bio !== undefined) fields.bio = body.bio;
  if (body.brand_color !== undefined) fields.brand_color = body.brand_color;
  if (body.welcome_message !== undefined) fields.welcome_message = body.welcome_message;
  if (body.logo_url !== undefined) fields.logo_url = body.logo_url || null;
  if (body.hide_branding !== undefined) fields.hide_branding = body.hide_branding ? 1 : 0;
  if (body.cancellation_policy !== undefined) fields.cancellation_policy = body.cancellation_policy || null;
  if (body.blocked_emails !== undefined) fields.blocked_emails = body.blocked_emails || null;
  if (body.ga_measurement_id !== undefined) fields.ga_measurement_id = body.ga_measurement_id || null;
  if (body.meta_pixel_id !== undefined) fields.meta_pixel_id = body.meta_pixel_id || null;
  if (body.custom_domain !== undefined) {
    const domain = body.custom_domain ? body.custom_domain.trim().toLowerCase() : null;
    if (domain) {
      // Verify domain is not already used by another user
      const domainCheck = await env.DB.prepare(
        'SELECT id FROM booking_pages WHERE custom_domain = ? AND user_id != ?'
      ).bind(domain, user.id).first();
      if (domainCheck) return jsonResponse({ error: 'This domain is already in use' }, 409);
    }
    fields.custom_domain = domain;
  }
  if (body.slug !== undefined) {
    const newSlug = generateSlug(body.slug);
    if (!newSlug || isReservedSlug(newSlug)) return jsonResponse({ error: 'That URL is reserved — please choose another' }, 400);
    const existing = await env.DB.prepare('SELECT id FROM booking_pages WHERE slug = ? AND user_id != ?').bind(newSlug, user.id).first();
    if (existing) return jsonResponse({ error: 'Slug already taken' }, 409);
    fields.slug = newSlug;
  }

  if (Object.keys(fields).length === 0) return jsonResponse({ error: 'No fields to update' }, 400);
  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const result = await env.DB.prepare(
    `UPDATE booking_pages SET ${setClauses} WHERE user_id = ? RETURNING *`
  ).bind(...Object.values(fields), user.id).first();

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'settings.updated', 'booking_page', result?.id, { updated_fields: Object.keys(fields).filter(k => k !== 'updated_at') }, clientIP);

  return jsonResponse(result);
}

// ============================================================
// Webhook Handlers
// ============================================================

async function handleListWebhooks(request, env, user) {
  const result = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleCreateWebhook(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { url, events } = body;

  if (!url || !url.trim()) {
    return jsonResponse({ error: 'URL is required' }, 400);
  }

  // Validate URL format
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return jsonResponse({ error: 'URL must use http or https protocol' }, 400);
    }
  } catch {
    return jsonResponse({ error: 'Invalid URL format' }, 400);
  }

  // Validate events
  const validEvents = ['booking.created', 'booking.cancelled', 'booking.rescheduled'];
  const eventList = Array.isArray(events) ? events : ['booking.created'];
  for (const event of eventList) {
    if (!validEvents.includes(event)) {
      return jsonResponse({ error: `Invalid event: ${event}. Valid events: ${validEvents.join(', ')}` }, 400);
    }
  }

  // Auto-generate secret
  const secret = crypto.randomUUID();

  const result = await env.DB.prepare(
    'INSERT INTO webhooks (user_id, url, events, secret) VALUES (?, ?, ?, ?) RETURNING *'
  ).bind(user.id, url.trim(), JSON.stringify(eventList), secret).first();

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'webhook.created', 'webhook', result.id, { url: url.trim(), events: eventList }, clientIP);

  return jsonResponse(result, 201);
}

async function handleUpdateWebhook(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};

  if (body.url !== undefined) {
    if (!body.url || !body.url.trim()) {
      return jsonResponse({ error: 'URL is required' }, 400);
    }
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return jsonResponse({ error: 'URL must use http or https protocol' }, 400);
      }
    } catch {
      return jsonResponse({ error: 'Invalid URL format' }, 400);
    }
    fields.url = body.url.trim();
  }

  if (body.events !== undefined) {
    const validEvents = ['booking.created', 'booking.cancelled', 'booking.rescheduled'];
    if (!Array.isArray(body.events)) {
      return jsonResponse({ error: 'Events must be an array' }, 400);
    }
    for (const event of body.events) {
      if (!validEvents.includes(event)) {
        return jsonResponse({ error: `Invalid event: ${event}. Valid events: ${validEvents.join(', ')}` }, 400);
      }
    }
    fields.events = JSON.stringify(body.events);
  }

  if (body.is_active !== undefined) {
    fields.is_active = body.is_active ? 1 : 0;
  }

  if (Object.keys(fields).length === 0) {
    return jsonResponse({ error: 'No fields to update' }, 400);
  }

  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  const result = await env.DB.prepare(
    `UPDATE webhooks SET ${setClauses} WHERE id = ? AND user_id = ? RETURNING *`
  ).bind(...values, id, user.id).first();

  return jsonResponse(result);
}

async function handleDeleteWebhook(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  await env.DB.prepare(
    'DELETE FROM webhooks WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'webhook.deleted', 'webhook', parseInt(id), { url: existing.url }, clientIP);

  return jsonResponse({ ok: true });
}

// ============================================================
// Webhook Delivery
// ============================================================

async function fireWebhooks(env, userId, eventName, payload) {
  const result = await env.DB.prepare(
    'SELECT * FROM webhooks WHERE user_id = ? AND is_active = 1'
  ).bind(userId).all();

  const webhooks = result.results || [];

  const deliveries = webhooks.map(async (webhook) => {
    const events = JSON.parse(webhook.events || '[]');
    if (!events.includes(eventName)) return;

    const body = JSON.stringify(payload);

    try {
      // Compute HMAC-SHA256 signature
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(webhook.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
      const signatureHex = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Calendo-Signature': signatureHex,
          'X-Calendo-Event': eventName,
        },
        body,
      });

      if (response.ok) {
        await env.DB.prepare(
          "UPDATE webhooks SET failure_count = 0, last_triggered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).bind(webhook.id).run();
      } else {
        const newCount = (webhook.failure_count || 0) + 1;
        const isActive = newCount >= 5 ? 0 : 1;
        await env.DB.prepare(
          "UPDATE webhooks SET failure_count = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(newCount, isActive, webhook.id).run();
      }
    } catch {
      const newCount = (webhook.failure_count || 0) + 1;
      const isActive = newCount >= 5 ? 0 : 1;
      await env.DB.prepare(
        "UPDATE webhooks SET failure_count = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(newCount, isActive, webhook.id).run();
    }
  });

  await Promise.all(deliveries);
}

// ============================================================
// Calendar Connection Handlers

// ============================================================
// Slack Webhook Notifications
// ============================================================

async function sendSlackNotification(env, userId, eventName, data) {
  try {
    const user = await env.DB.prepare(
      'SELECT slack_webhook_url FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!user || !user.slack_webhook_url) return;

    const webhookUrl = user.slack_webhook_url;

    let emoji, title;
    switch (eventName) {
      case 'booking.created':
        emoji = ':calendar:';
        title = 'New Booking';
        break;
      case 'booking.cancelled':
        emoji = ':x:';
        title = 'Booking Cancelled';
        break;
      case 'booking.rescheduled':
        emoji = ':arrows_counterclockwise:';
        title = 'Booking Rescheduled';
        break;
      default:
        emoji = ':bell:';
        title = 'Notification';
    }

    const booking = data.booking || {};
    const fields = [];

    if (booking.event_type) {
      fields.push({ type: 'mrkdwn', text: `*Event*\n${booking.event_type}` });
    }
    if (booking.invitee_name) {
      fields.push({ type: 'mrkdwn', text: `*Invitee*\n${booking.invitee_name}${booking.invitee_email ? ' (' + booking.invitee_email + ')' : ''}` });
    }
    if (booking.start_time) {
      const startDate = new Date(booking.start_time);
      const formatted = startDate.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
      });
      fields.push({ type: 'mrkdwn', text: `*When*\n${formatted} UTC` });
    }
    if (eventName === 'booking.rescheduled' && booking.previous_start_time) {
      const prevDate = new Date(booking.previous_start_time);
      const prevFormatted = prevDate.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
      });
      fields.push({ type: 'mrkdwn', text: `*Previous Time*\n~${prevFormatted} UTC~` });
    }
    if (eventName === 'booking.cancelled' && booking.cancelled_by) {
      fields.push({ type: 'mrkdwn', text: `*Cancelled By*\n${booking.cancelled_by}` });
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} ${title}`, emoji: true },
      },
      {
        type: 'section',
        fields: fields.length > 0 ? fields : [{ type: 'mrkdwn', text: 'No details available.' }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open Dashboard', emoji: true },
            url: 'https://calendo.dev/dashboard/',
            action_id: 'open_dashboard',
          },
        ],
      },
    ];

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
  } catch (err) {
    console.error('Slack notification error:', err);
  }
}

async function handleTestSlackWebhook(request, env, user) {
  if (!user.slack_webhook_url) {
    return jsonResponse({ error: 'No Slack webhook URL configured. Save one in Settings first.' }, 400);
  }

  try {
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':white_check_mark: Calendo Connected!', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Your Slack webhook is working. You will receive notifications here when meetings are booked, cancelled, or rescheduled.' },
      },
    ];

    const response = await fetch(user.slack_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });

    if (!response.ok) {
      const body = await response.text();
      return jsonResponse({ error: `Slack returned ${response.status}: ${body}` }, 400);
    }

    return jsonResponse({ ok: true, message: 'Test message sent to Slack' });
  } catch (err) {
    return jsonResponse({ error: `Failed to reach Slack: ${err.message}` }, 500);
  }
}

async function handleUpdateSlackWebhook(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { slack_webhook_url } = body;

  // Allow clearing (setting to null)
  if (slack_webhook_url === null || slack_webhook_url === '') {
    await env.DB.prepare(
      "UPDATE users SET slack_webhook_url = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(user.id).run();
    return jsonResponse({ ok: true, slack_webhook_url: null });
  }

  // Validate URL format
  if (!slack_webhook_url.startsWith('https://hooks.slack.com/')) {
    return jsonResponse({ error: 'Invalid Slack webhook URL. Must start with https://hooks.slack.com/' }, 400);
  }

  try {
    new URL(slack_webhook_url);
  } catch {
    return jsonResponse({ error: 'Invalid URL format' }, 400);
  }

  await env.DB.prepare(
    "UPDATE users SET slack_webhook_url = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(slack_webhook_url, user.id).run();

  return jsonResponse({ ok: true, slack_webhook_url });
}

// ============================================================
// Email Verification Handlers
// ============================================================

async function handleVerifyEmail(request, env, url) {
  const token = url.searchParams.get('token');
  if (!token) {
    return jsonResponse({ error: 'Verification token is required' }, 400);
  }

  const record = await env.DB.prepare(
    'SELECT * FROM email_verification_tokens WHERE token = ? AND used = 0'
  ).bind(token).first();

  if (!record) {
    return jsonResponse({ error: 'Invalid or already used verification token' }, 400);
  }

  // Check expiry
  const expiresAt = new Date(record.expires_at.endsWith('Z') ? record.expires_at : record.expires_at + 'Z');
  if (expiresAt <= new Date()) {
    return jsonResponse({ error: 'Verification token has expired. Please request a new one.' }, 400);
  }

  // Mark token as used
  await env.DB.prepare(
    'UPDATE email_verification_tokens SET used = 1 WHERE id = ?'
  ).bind(record.id).run();

  // Mark user email as verified
  await env.DB.prepare(
    "UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?"
  ).bind(record.user_id).run();

  const origin = env.APP_ORIGIN || 'https://calendo.dev';
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="2;url=${origin}/onboarding/">
<title>Email Verified — Calendo</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; color: #1a1a1a; }
  .card { background: white; border-radius: 12px; padding: 48px; text-align: center; max-width: 420px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #64748b; font-size: 15px; margin: 0 0 24px; }
  a { display: inline-block; padding: 10px 28px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 15px; }
  a:hover { background: #1d4ed8; }
  .redirect-note { font-size: 13px; color: #94a3b8; margin-top: 16px; }
</style></head><body>
<div class="card">
  <div class="icon">&#10003;</div>
  <h1>Email Verified</h1>
  <p>Your email address has been verified successfully. You're all set!</p>
  <a href="${origin}/onboarding/">Continue Setup</a>
  <div class="redirect-note">Redirecting in 2 seconds…</div>
</div>
</body></html>`, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

async function handleResendVerification(request, env, user, url) {
  if (user.email_verified) {
    return jsonResponse({ error: 'Email is already verified' }, 400);
  }

  // Invalidate existing tokens
  await env.DB.prepare(
    'UPDATE email_verification_tokens SET used = 1 WHERE user_id = ? AND used = 0'
  ).bind(user.id).run();

  // Generate new token
  const token = crypto.randomUUID();
  const expiresAt = formatDbTimestamp(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await env.DB.prepare(
    'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).bind(user.id, token, expiresAt).run();

  // Build verify URL
  const origin = url.origin;
  const verifyUrl = `${origin}/api/auth/verify-email?token=${token}`;

  // Send verification email
  const emailData = verificationEmail(verifyUrl);
  await sendEmail(env, {
    to: user.email,
    subject: emailData.subject,
    html: emailData.html,
    text: emailData.text,
    type: 'verification',
  });

  return jsonResponse({ ok: true, message: 'Verification email sent' });
}
// ============================================================

// ============================================================
// API Key Handlers
// ============================================================

async function handleListApiKeys(request, env, user) {
  const result = await env.DB.prepare(
    'SELECT id, name, key_prefix, scopes, last_used_at, created_at, expires_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleCreateApiKey(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name } = body;
  if (!name || !name.trim()) {
    return jsonResponse({ error: 'Name is required' }, 400);
  }

  // Generate key: cal_live_ + 32 random hex chars
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hexChars = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const fullKey = `cal_live_${hexChars}`;
  const keyPrefix = `cal_live_${hexChars.slice(0, 4)}...`;

  // Store SHA-256 hash
  const keyHash = await hashString(fullKey);

  const result = await env.DB.prepare(
    'INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?) RETURNING id, name, key_prefix, created_at'
  ).bind(user.id, name.trim(), keyHash, keyPrefix).first();

  // Return the full key ONCE - it will never be shown again
  return jsonResponse({ ...result, key: fullKey }, 201);
}

async function handleDeleteApiKey(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT id FROM api_keys WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  await env.DB.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return jsonResponse({ ok: true });
}


async function handleGoogleCalendarOAuth(request, env, user) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return jsonResponse({ error: 'Google Calendar integration is not configured' }, 500);
  }

  const origin = env.APP_ORIGIN || new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/callback/google-calendar`;
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' ');

  const state = await generateOAuthState(env, 'gcal_' + user.id);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return Response.redirect(googleAuthUrl, 302);
}

async function handleGoogleCalendarCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const origin = env.APP_ORIGIN || url.origin;

  if (error) {
    return Response.redirect(`${origin}/dashboard/?tab=settings&calendar=error&reason=${encodeURIComponent(error)}`, 302);
  }

  if (!code || !state) {
    return Response.redirect(`${origin}/dashboard/?tab=settings&calendar=error&reason=missing_params`, 302);
  }

  // Verify OAuth state and extract user ID
  const statePayload = await verifyOAuthState(env, state);
  if (!statePayload || !statePayload.startsWith('gcal_')) {
    return Response.redirect(`${origin}/dashboard/?tab=settings&calendar=error&reason=invalid_state`, 302);
  }
  const userId = parseInt(statePayload.replace('gcal_', ''), 10);
  if (isNaN(userId)) {
    return Response.redirect(`${origin}/dashboard/?tab=settings&calendar=error&reason=invalid_state`, 302);
  }

  // Exchange authorization code for tokens
  const redirectUri = `${origin}/api/auth/callback/google-calendar`;
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Google token exchange failed:', await tokenResponse.text());
    return Response.redirect(`${origin}/dashboard/?tab=settings&calendar=error&reason=token_exchange_failed`, 302);
  }

  const tokens = await tokenResponse.json();

  // Get the user's email — try from Google userinfo, fall back to DB
  let googleEmail = null;
  try {
    const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (userinfoResponse.ok) {
      const userinfo = await userinfoResponse.json();
      googleEmail = userinfo.email;
    }
  } catch {}
  if (!googleEmail) {
    const dbUser = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
    if (dbUser) googleEmail = dbUser.email;
  }

  // Encrypt tokens
  const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
  const refreshTokenEncrypted = tokens.refresh_token
    ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY)
    : null;

  const expiresAt = tokens.expires_in
    ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000)
    : null;

  // Check if connection already exists for this user+provider+email
  const existing = await env.DB.prepare(
    'SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND email = ?'
  ).bind(userId, 'google', googleEmail).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE calendar_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(accessTokenEncrypted, refreshTokenEncrypted, expiresAt, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO calendar_connections (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, email, calendar_id, is_primary, check_conflicts, write_events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, 'google', accessTokenEncrypted, refreshTokenEncrypted, expiresAt, googleEmail, 'primary', 1, 1, 1).run();
  }

  // Set up Google Calendar push notifications for two-way sync
  try {
    const savedConnection = await env.DB.prepare(
      'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? ORDER BY id DESC LIMIT 1'
    ).bind(userId, 'google').first();
    if (savedConnection) {
      await setupGoogleCalendarWatch(env, savedConnection, tokens.access_token);
    }
  } catch (watchErr) {
    console.error('Failed to setup Google Calendar watch after calendar connection:', watchErr);
  }

  await logAuditEvent(env.DB, userId, 'calendar.connected', 'calendar_connection', null, { provider: 'google', email: googleEmail }, null);

  return Response.redirect(`${origin}/dashboard/?calendar=connected`, 302);
}

async function handleAppleCalendarConnect(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { email, app_password } = body;
  if (!email || !app_password) return jsonResponse({ error: 'Email and app_password are required' }, 400);

  // Verify CalDAV credentials by trying to access the iCloud principal URL
  const caldavUrl = 'https://caldav.icloud.com/';
  try {
    const verifyResponse = await fetch(caldavUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + btoa(`${email}:${app_password}`),
      },
    });

    // 401/403 = bad credentials, anything else (200, 207, 301, 404) = credentials are valid
    if (verifyResponse.status === 401 || verifyResponse.status === 403) {
      return jsonResponse({ error: 'Invalid Apple ID or app-specific password. Make sure you generated an app-specific password at appleid.apple.com.' }, 401);
    }
  } catch (err) {
    return jsonResponse({ error: 'Could not reach Apple CalDAV server. Please try again.' }, 502);
  }

  // Encrypt the app-specific password
  const passwordEncrypted = await encryptToken(app_password, env.ENCRYPTION_KEY);

  // Check if connection already exists
  const existing = await env.DB.prepare(
    'SELECT id FROM calendar_connections WHERE user_id = ? AND provider = ? AND email = ?'
  ).bind(user.id, 'apple', email).first();

  if (existing) {
    await env.DB.prepare(
      "UPDATE calendar_connections SET access_token_encrypted = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(passwordEncrypted, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO calendar_connections (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, email, calendar_id, is_primary, check_conflicts, write_events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(user.id, 'apple', passwordEncrypted, null, null, email, 'primary', 1, 1, 0).run();

  // If this is the first calendar, make it primary. Otherwise just check conflicts.
  const allCals = await env.DB.prepare('SELECT COUNT(*) as count FROM calendar_connections WHERE user_id = ?').bind(user.id).first();
  if (allCals.count > 1) {
    // Not the first — don't override existing primary
    const lastInsert = await env.DB.prepare('SELECT id FROM calendar_connections WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(user.id).first();
    if (lastInsert) {
      await env.DB.prepare('UPDATE calendar_connections SET is_primary = 0, write_events = 0 WHERE id = ?').bind(lastInsert.id).run();
    }
  }
  }

  return jsonResponse({ ok: true, message: 'Apple Calendar connected' });
}

async function handleListCalendarConnections(request, env, user) {
  const result = await env.DB.prepare(
    'SELECT id, provider, email, calendar_id, is_primary, check_conflicts, write_events, last_synced_at, created_at FROM calendar_connections WHERE user_id = ?'
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleSetPrimaryCalendar(request, env, user, path) {
  const id = path.split('/')[3];
  const connection = await env.DB.prepare(
    'SELECT id FROM calendar_connections WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!connection) return jsonResponse({ error: 'Not found' }, 404);

  // Unset all as non-primary, then set the selected one
  await env.DB.prepare(
    "UPDATE calendar_connections SET is_primary = 0, write_events = 0 WHERE user_id = ?"
  ).bind(user.id).run();
  await env.DB.prepare(
    "UPDATE calendar_connections SET is_primary = 1, write_events = 1 WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).run();

  return jsonResponse({ ok: true });
}

async function handleUpdateCalendarSettings(request, env, user, path) {
  const id = path.split('/')[3];
  const connection = await env.DB.prepare(
    'SELECT id, provider, email, calendar_id, is_primary, check_conflicts, write_events, last_synced_at, created_at FROM calendar_connections WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!connection) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  if (body.check_conflicts !== undefined) {
    if (typeof body.check_conflicts !== 'boolean') return jsonResponse({ error: 'check_conflicts must be a boolean' }, 400);
    fields.check_conflicts = body.check_conflicts ? 1 : 0;
  }
  if (body.write_events !== undefined) {
    if (typeof body.write_events !== 'boolean') return jsonResponse({ error: 'write_events must be a boolean' }, 400);
    fields.write_events = body.write_events ? 1 : 0;
  }

  if (Object.keys(fields).length === 0) {
    return jsonResponse({ error: 'At least one of check_conflicts or write_events is required' }, 400);
  }

  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  await env.DB.prepare(
    `UPDATE calendar_connections SET ${setClauses} WHERE id = ? AND user_id = ?`
  ).bind(...values, id, user.id).run();

  // Return the updated connection
  const updated = await env.DB.prepare(
    'SELECT id, provider, email, calendar_id, is_primary, check_conflicts, write_events, last_synced_at, created_at FROM calendar_connections WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();

  return jsonResponse(updated);
}

async function handleSyncUserCalendar(request, env, user) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
  ).bind(user.id, 'google').all();

  if (!connections.results || connections.results.length === 0) {
    return jsonResponse({ ok: true, synced: 0 });
  }

  let cancelledCount = 0;

  for (const connection of connections.results) {
    try {
      const accessToken = await getValidAccessToken(env, connection);
      const calendarId = connection.calendar_id || 'primary';

      // Check events modified in the last hour
      const updatedMin = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const eventsResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
        new URLSearchParams({ updatedMin, showDeleted: 'true', singleEvents: 'true', maxResults: '50' }),
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!eventsResponse.ok) continue;

      const eventsData = await eventsResponse.json();
      const events = eventsData.items || [];

      const cancelledEventIds = events
        .filter(e => e.status === 'cancelled')
        .map(e => e.id);

      for (const eventId of cancelledEventIds) {
        const booking = await env.DB.prepare(
          `SELECT b.*, et.user_id as host_user_id FROM bookings b
           JOIN event_types et ON b.event_type_id = et.id
           WHERE b.calendar_event_id = ? AND b.status IN ('confirmed', 'pending', 'pending_payment')`
        ).bind(eventId).first();

        if (booking) {
          await env.DB.prepare(
            "UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = 'calendar_sync', cancellation_reason = 'Event deleted from Google Calendar', updated_at = datetime('now') WHERE id = ?"
          ).bind(booking.id).run();
          cancelledCount++;
        }
      }

      // Also try to set up watch if not already set up
      if (!connection.watch_channel_id) {
        try {
          await setupGoogleCalendarWatch(env, connection, accessToken);
        } catch {}
      }
    } catch (err) {
      console.error('Calendar sync error for connection', connection.id, err);
    }
  }

  return jsonResponse({ ok: true, synced: cancelledCount });
}

async function handleDeleteCalendarConnection(request, env, user, path) {
  const id = path.split('/').pop();
  const connection = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!connection) return jsonResponse({ error: 'Not found' }, 404);

  // Stop Google Calendar watch channel if one exists
  if (connection.provider === 'google' && connection.watch_channel_id && connection.watch_resource_id) {
    try {
      const accessToken = await getValidAccessToken(env, connection);
      await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: connection.watch_channel_id,
          resourceId: connection.watch_resource_id,
        }),
      });
    } catch (err) {
      console.error('Failed to stop Google Calendar watch channel:', err);
      // Non-fatal — continue with deletion
    }
  }

  // Revoke the OAuth grant with the provider so Calendo is actually removed from
  // the user's connected-apps list — not just our stored tokens deleted.
  await revokeOAuthGrant(env, connection);

  await env.DB.prepare('DELETE FROM calendar_connections WHERE id = ?').bind(id).run();

  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null;
  await logAuditEvent(env.DB, user.id, 'calendar.disconnected', 'calendar_connection', parseInt(id), { provider: connection.provider, email: connection.email }, clientIP);

  return jsonResponse({ ok: true });
}

// Revoke a stored OAuth grant with the provider so the app disappears from the
// user's "third-party apps with access" list. Google exposes a revoke endpoint
// (revoking the refresh token tears down the whole grant). Microsoft/Outlook has
// no equivalent user-level delegated-token revoke endpoint — the user must remove
// the app from their Microsoft account — so we no-op there. Best-effort: never
// throws, so it can't block disconnect/deletion.
export async function revokeOAuthGrant(env, connection) {
  if (!connection || connection.provider !== 'google') return false;
  try {
    const enc = connection.refresh_token_encrypted || connection.access_token_encrypted;
    if (!enc) return false;
    const token = await decryptToken(enc, env.ENCRYPTION_KEY);
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(token),
    });
    // 200 = revoked; 400 = token already expired/invalid (grant effectively gone).
    return res.ok || res.status === 400;
  } catch (err) {
    console.error('Failed to revoke Google OAuth grant:', err);
    return false;
  }
}

// Revoke every calendar grant a user holds (used on account deletion).
async function revokeAllCalendarGrants(env, userId) {
  try {
    const conns = await env.DB.prepare('SELECT * FROM calendar_connections WHERE user_id = ?').bind(userId).all();
    for (const c of (conns.results || [])) {
      await revokeOAuthGrant(env, c);
    }
  } catch (err) {
    console.error('Failed to revoke calendar grants for user', userId, err);
  }
}

// ============================================================
// Token Encryption/Decryption (AES-GCM via Web Crypto API)
// ============================================================

async function encryptToken(token, keyBase64) {
  const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

async function decryptToken(encrypted, keyBase64) {
  const [ivB64, ctB64] = encrypted.split(':');
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
  const keyData = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// ============================================================
// Google Calendar API Helpers
// ============================================================

async function refreshGoogleToken(env, connection) {
  if (!connection.refresh_token_encrypted) {
    throw new Error('No refresh token available');
  }

  const refreshToken = await decryptToken(connection.refresh_token_encrypted, env.ENCRYPTION_KEY);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  const tokens = await response.json();
  const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
  const expiresAt = tokens.expires_in
    ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000)
    : null;

  await env.DB.prepare(
    `UPDATE calendar_connections SET access_token_encrypted = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(accessTokenEncrypted, expiresAt, connection.id).run();

  return tokens.access_token;
}

async function getValidAccessToken(env, connection) {
  if (connection.token_expires_at) {
    const expiresAt = parseStoredUtcDate(connection.token_expires_at);
    const now = new Date();
    if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      return await refreshGoogleToken(env, connection);
    }
  }
  return await decryptToken(connection.access_token_encrypted, env.ENCRYPTION_KEY);
}

async function getGoogleBusyTimes(env, userId, startISO, endISO) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
  ).bind(userId, 'google').all();

  if (!connections.results || connections.results.length === 0) {
    return [];
  }

  const allBusyTimes = [];

  for (const connection of connections.results) {
    try {
      const accessToken = await getValidAccessToken(env, connection);

      const freebusyResponse = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          timeMin: startISO,
          timeMax: endISO,
          items: [{ id: connection.calendar_id || 'primary' }],
        }),
      });

      if (!freebusyResponse.ok) {
        console.error('Google freebusy API error:', await freebusyResponse.text());
        continue;
      }

      const freebusyData = await freebusyResponse.json();
      const calendarId = connection.calendar_id || 'primary';
      const busySlots = freebusyData.calendars?.[calendarId]?.busy || [];

      for (const slot of busySlots) {
        allBusyTimes.push({ start: slot.start, end: slot.end });
      }
    } catch (err) {
      console.error(`Failed to get busy times for connection ${connection.id}:`, err);
    }
  }

  return allBusyTimes;
}

// Remove slots (as returned by computeAvailableSlots, keyed by invitee-local
// date with "HH:MM" times) that overlap any busy range. Mutates `slots`.
// Uses dateTimeInTimezoneToUtc for the local→UTC conversion: the previous
// inline version compared hour/minute only, which was off by ±24h whenever the
// invitee's local date differed from the UTC date at slot time.
function removeSlotsOverlappingBusyRanges(slots, busyRanges, eventType, inviteeTimezone) {
  const bufferBefore = (eventType.buffer_before || 0) * 60000;
  const bufferAfter = (eventType.buffer_after || 0) * 60000;
  for (const dateKey of Object.keys(slots)) {
    slots[dateKey] = slots[dateKey].filter((timeStr) => {
      const slotStartUtc = dateTimeInTimezoneToUtc(dateKey, timeStr, inviteeTimezone).getTime();
      const slotEndUtc = slotStartUtc + eventType.duration_minutes * 60000;
      for (const busy of busyRanges) {
        if ((slotStartUtc - bufferBefore) < busy.end && (slotEndUtc + bufferAfter) > busy.start) {
          return false;
        }
      }
      return true;
    });
    if (slots[dateKey].length === 0) {
      delete slots[dateKey];
    }
  }
}

// Booking-time re-check of connected-calendar busy times. Returns 'google',
// 'outlook', or null. Provider API errors are treated as "no conflict" (fail
// open), matching the availability listing's behavior — the product must keep
// accepting bookings when a calendar API is down.
async function findCalendarBusyConflict(env, userId, slotStart, slotEnd, bufferBeforeMin = 0, bufferAfterMin = 0) {
  const bufferedStart = new Date(slotStart.getTime() - bufferBeforeMin * 60000);
  const bufferedEnd = new Date(slotEnd.getTime() + bufferAfterMin * 60000);
  const overlaps = (busyTimes) => busyTimes.some((bt) =>
    bufferedStart.getTime() < new Date(bt.end).getTime() &&
    bufferedEnd.getTime() > new Date(bt.start).getTime()
  );

  try {
    const googleBusy = await getGoogleBusyTimes(env, userId, bufferedStart.toISOString(), bufferedEnd.toISOString());
    if (overlaps(googleBusy)) return 'google';
  } catch (err) {
    console.error('Google busy re-check failed:', err);
  }

  try {
    const outlookConns = await env.DB.prepare(
      'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
    ).bind(userId, 'outlook').all();
    for (const conn of outlookConns.results || []) {
      try {
        const outlookBusy = await getOutlookBusyTimes(env, conn, bufferedStart.toISOString(), bufferedEnd.toISOString());
        if (overlaps(outlookBusy)) return 'outlook';
      } catch (err) {
        console.error('Outlook busy re-check failed:', err);
      }
    }
  } catch (err) {
    console.error('Outlook busy re-check failed:', err);
  }

  return null;
}

async function deleteGoogleCalendarEvent(env, userId, calendarEventId) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1'
  ).bind(userId, 'google').all();

  if (!connections.results || connections.results.length === 0) return;

  const connection = connections.results[0];
  try {
    const accessToken = await getValidAccessToken(env, connection);
    const calendarId = connection.calendar_id || 'primary';
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(calendarEventId)}?sendUpdates=all`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    console.error('Failed to delete Google Calendar event:', err);
  }
}

async function createGoogleCalendarEvent(env, userId, booking, eventType, hostEmail) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1'
  ).bind(userId, 'google').all();

  if (!connections.results || connections.results.length === 0) {
    return null;
  }

  const connection = connections.results[0];

  try {
    const accessToken = await getValidAccessToken(env, connection);
    const appOrigin = env.APP_ORIGIN || 'https://calendo.dev';

    // Build cancel/reschedule links
    const cancelUrl = `${appOrigin}/booking/cancel.html?token=${booking.cancel_token}`;
    const rescheduleUrl = `${appOrigin}/booking/reschedule.html?token=${booking.cancel_token}`;

    // Build description based on location type
    const locType = eventType.location_type || 'google_meet';
    let locationDesc = '';
    if (locType === 'google_meet') {
      locationDesc = 'Location: This is a Google Meet web conference.\nYou can join this meeting from your computer, tablet, or smartphone.';
    } else if (locType === 'zoom' && booking.location) {
      locationDesc = `Location: Zoom Meeting\nJoin: ${booking.location}`;
    } else if (locType === 'teams' && booking.location) {
      locationDesc = `Location: Microsoft Teams\nJoin: ${booking.location}`;
    } else if (locType === 'phone') {
      locationDesc = booking.invitee_phone
        ? `Location: Phone call — ${booking.invitee_phone}`
        : 'Location: Phone call';
    } else if (locType === 'in_person') {
      let address = '';
      try { address = JSON.parse(eventType.location_config || '{}').address || ''; } catch {}
      locationDesc = address ? `Location: ${address}` : 'Location: In person';
    } else if (booking.location) {
      locationDesc = `Location: ${booking.location}`;
    }

    // Format booking answers for description
    let answersDesc = '';
    if (booking.answers) {
      try {
        const answers = typeof booking.answers === 'string' ? JSON.parse(booking.answers) : booking.answers;
        const answerEntries = Object.entries(answers).filter(([_, v]) => v);
        if (answerEntries.length > 0) {
          answersDesc = '\nResponses:\n' + answerEntries.map(([q, a]) => `• ${q}: ${a}`).join('\n');
        }
      } catch {}
    }

    const descParts = [
      `Event Name: ${eventType.name}`,
      `Invitee: ${booking.invitee_name} (${booking.invitee_email})`,
      answersDesc,
      '',
      locationDesc,
      '',
      `Need to make changes to this event?`,
      `Cancel: ${cancelUrl}`,
      `Reschedule: ${rescheduleUrl}`,
      '',
      `Powered by Calendo`,
    ];

    const event = {
      summary: `${eventType.name} with ${booking.invitee_name}`,
      description: descParts.join('\n'),
      start: {
        dateTime: booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z',
        timeZone: 'UTC',
      },
      end: {
        dateTime: booking.end_time.includes('T') ? booking.end_time : booking.end_time.replace(' ', 'T') + 'Z',
        timeZone: 'UTC',
      },
      attendees: [
        { email: booking.invitee_email },
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 10 },
          { method: 'popup', minutes: 30 },
        ],
      },
    };

    // Add guest emails as attendees
    if (booking.guest_emails) {
      try {
        const guests = typeof booking.guest_emails === 'string' ? JSON.parse(booking.guest_emails) : booking.guest_emails;
        if (Array.isArray(guests)) {
          for (const guestEmail of guests) {
            if (guestEmail && guestEmail.trim()) {
              event.attendees.push({ email: guestEmail.trim() });
            }
          }
        }
      } catch {}
    }

    // Only add Google Meet if location type is google_meet (or not set)
    if (locType === 'google_meet') {
      event.conferenceData = {
        createRequest: {
          requestId: booking.uid || crypto.randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    // Add Zoom/Teams/custom link as the calendar event location
    if (booking.location) {
      event.location = booking.location;
    }

    if (hostEmail) {
      event.attendees.push({ email: hostEmail });
    }

    const calendarId = connection.calendar_id || 'primary';
    const queryParams = locType === 'google_meet' ? 'sendUpdates=all&conferenceDataVersion=1' : 'sendUpdates=all';
    const createResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${queryParams}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    if (!createResponse.ok) {
      console.error('Google Calendar event creation failed:', await createResponse.text());
      return null;
    }

    const createdEvent = await createResponse.json();

    // Save the Meet link to the booking if one was created
    if (createdEvent.conferenceData?.entryPoints) {
      const videoEntry = createdEvent.conferenceData.entryPoints.find(e => e.entryPointType === 'video');
      if (videoEntry) {
        await env.DB.prepare(
          "UPDATE bookings SET location = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(videoEntry.uri, booking.id).run();
      }
    }

    return createdEvent.id;
  } catch (err) {
    console.error('Failed to create Google Calendar event:', err);
    return null;
  }
}

// ============================================================
// Google Calendar Push Notifications (Webhooks)
// ============================================================

async function setupGoogleCalendarWatch(env, connection, accessToken) {
  const channelId = crypto.randomUUID();
  const origin = env.APP_ORIGIN || 'https://calendo.dev';
  const webhookAddress = `${origin}/api/calendars/webhook/google`;
  // Max expiration: 7 days from now (Google's limit)
  const expirationMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

  try {
    const calendarId = connection.calendar_id || 'primary';
    const watchResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
          address: webhookAddress,
          expiration: expirationMs,
        }),
      }
    );

    if (!watchResponse.ok) {
      const errText = await watchResponse.text();
      console.error('Google Calendar watch setup failed:', errText);
      return null;
    }

    const watchData = await watchResponse.json();

    // Store channel info in the calendar connection
    await env.DB.prepare(
      `UPDATE calendar_connections SET watch_channel_id = ?, watch_resource_id = ?, watch_expiration = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(watchData.id, watchData.resourceId, formatDbTimestamp(new Date(parseInt(watchData.expiration, 10))), connection.id).run();

    return { channelId: watchData.id, resourceId: watchData.resourceId };
  } catch (err) {
    console.error('Failed to setup Google Calendar watch:', err);
    return null;
  }
}

async function handleGoogleCalendarWebhook(request, env) {
  const channelId = request.headers.get('X-Goog-Channel-ID');
  const resourceId = request.headers.get('X-Goog-Resource-ID');
  const resourceState = request.headers.get('X-Goog-Resource-State');

  // Validate required headers
  if (!channelId || !resourceId) {
    return jsonResponse({ error: 'Missing required Google headers' }, 400);
  }

  // Look up the calendar connection by channel ID and resource ID
  const connection = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE watch_channel_id = ? AND watch_resource_id = ? AND provider = ?'
  ).bind(channelId, resourceId, 'google').first();

  if (!connection) {
    // Unknown channel — could be a stale or forged request
    console.warn('Google Calendar webhook: unknown channel', channelId, resourceId);
    return jsonResponse({ ok: true });
  }

  // "sync" state is the initial confirmation — just acknowledge
  if (resourceState === 'sync') {
    return jsonResponse({ ok: true });
  }

  // "exists" state means events have changed
  if (resourceState === 'exists') {
    try {
      const accessToken = await getValidAccessToken(env, connection);
      const calendarId = connection.calendar_id || 'primary';

      // Fetch recently updated events (last 5 minutes to catch changes)
      const updatedMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const eventsResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
        new URLSearchParams({
          updatedMin,
          showDeleted: 'true',
          singleEvents: 'true',
          maxResults: '100',
        }),
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!eventsResponse.ok) {
        console.error('Google Calendar events fetch failed:', await eventsResponse.text());
        return jsonResponse({ ok: true });
      }

      const eventsData = await eventsResponse.json();
      const events = eventsData.items || [];

      // Find events that are cancelled/deleted
      const cancelledEventIds = events
        .filter(e => e.status === 'cancelled')
        .map(e => e.id);

      if (cancelledEventIds.length === 0) {
        return jsonResponse({ ok: true });
      }

      // Find Calendo bookings that match cancelled Google events
      for (const eventId of cancelledEventIds) {
        const booking = await env.DB.prepare(
          `SELECT b.*, et.user_id as host_user_id FROM bookings b
           JOIN event_types et ON b.event_type_id = et.id
           WHERE b.calendar_event_id = ? AND b.status IN (${SLOT_HOLDING_BOOKING_STATUSES_SQL})`
        ).bind(eventId).first();

        if (booking) {
          // Cancel the booking
          await env.DB.prepare(
            `UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = 'calendar_sync', cancellation_reason = 'Event deleted from Google Calendar', updated_at = datetime('now') WHERE id = ?`
          ).bind(booking.id).run();

          // Send cancellation emails
          try {
            const eventType = await env.DB.prepare(
              'SELECT * FROM event_types WHERE id = ?'
            ).bind(booking.event_type_id).first();
            const host = await env.DB.prepare(
              'SELECT name, email FROM users WHERE id = ?'
            ).bind(booking.host_user_id).first();

            if (eventType && host) {
              const inviteeData = cancellationEmail(booking, eventType, 'host', booking.invitee_name);
              await sendEmail(env, {
                to: booking.invitee_email,
                subject: inviteeData.subject,
                html: inviteeData.html,
                text: inviteeData.text,
                bookingId: booking.id,
                type: 'cancellation',
              });

              const hostTz = await resolveHostTimezone(env, booking.host_user_id, eventType, null);
              const hostData = cancellationEmail(booking, eventType, 'host', host.name, hostTz);
              await sendEmail(env, {
                to: host.email,
                subject: hostData.subject,
                html: hostData.html,
                text: hostData.text,
                bookingId: booking.id,
                type: 'cancellation',
              });
            }
          } catch (emailErr) {
            console.error('Failed to send cancellation emails from webhook:', emailErr);
          }

          // Fire user webhooks
          try {
            await fireWebhooks(env, booking.host_user_id, 'booking.cancelled', {
              booking: {
                id: booking.id,
                uid: booking.uid,
                invitee_name: booking.invitee_name,
                invitee_email: booking.invitee_email,
                start_time: booking.start_time,
                end_time: booking.end_time,
                status: 'cancelled',
                cancelled_by: 'calendar_sync',
              }
            });
          } catch (webhookErr) {
            console.error('Failed to fire webhooks from calendar sync:', webhookErr);
          }

          console.log(`Booking ${booking.id} cancelled via Google Calendar sync (event ${eventId})`);
        }
      }
    } catch (err) {
      console.error('Error processing Google Calendar webhook:', err);
    }
  }

  // Always return 200 to acknowledge receipt (Google retries on non-200)
  return jsonResponse({ ok: true });
}



// ============================================================
// Video Conferencing Auto-Link Creation
// ============================================================

// ── Zoom: per-user OAuth ────────────────────────────────────────────────────
// Each user connects their OWN Zoom account via OAuth; meetings are created with
// their token in their account. This replaced the old single shared
// Server-to-Server credential, under which every user's "Zoom" meeting was
// created inside the platform owner's account — leaking meetings and emailing the
// owner on join. Mirrors the Google/Outlook per-user calendar pattern.

// Whether per-user Zoom OAuth is configured on this deployment (requires a Zoom
// "General App" OAuth client registered by the platform owner).
function isZoomOAuthConfigured(env) {
  return !!(env.ZOOM_OAUTH_CLIENT_ID && env.ZOOM_OAUTH_CLIENT_SECRET);
}

// Start the Zoom OAuth flow: redirect the user to Zoom's consent screen.
async function handleZoomOAuth(request, env, user) {
  if (!isZoomOAuthConfigured(env)) {
    return jsonResponse({ error: 'Zoom integration is not configured on this server.' }, 503);
  }
  const origin = env.APP_ORIGIN || new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/callback/zoom`;
  const state = await generateOAuthState(env, 'zoom_' + user.id);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.ZOOM_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  });
  return Response.redirect(`https://zoom.us/oauth/authorize?${params.toString()}`, 302);
}

// Zoom redirects the user back here after consent. Exchange the code for tokens
// and store the per-user connection.
async function handleZoomCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const origin = env.APP_ORIGIN || url.origin;
  const fail = (reason) => Response.redirect(`${origin}/dashboard/?tab=availability&zoom=error&reason=${encodeURIComponent(reason)}`, 302);

  if (error) return fail(error);
  if (!code || !state) return fail('missing_params');
  if (!isZoomOAuthConfigured(env)) return fail('not_configured');

  const statePayload = await verifyOAuthState(env, state);
  if (!statePayload || !statePayload.startsWith('zoom_')) return fail('invalid_state');
  const userId = parseInt(statePayload.replace('zoom_', ''), 10);
  if (isNaN(userId)) return fail('invalid_state');

  const redirectUri = `${origin}/api/auth/callback/zoom`;
  const credentials = btoa(`${env.ZOOM_OAUTH_CLIENT_ID}:${env.ZOOM_OAUTH_CLIENT_SECRET}`);
  const tokenResponse = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!tokenResponse.ok) {
    console.error('Zoom token exchange failed:', await tokenResponse.text());
    return fail('token_exchange_failed');
  }
  const tokens = await tokenResponse.json();

  // Fetch the Zoom account email/id for display.
  let zoomEmail = null, zoomUserId = null;
  try {
    const meResp = await fetch('https://api.zoom.us/v2/users/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (meResp.ok) { const me = await meResp.json(); zoomEmail = me.email || null; zoomUserId = me.id || null; }
  } catch {}

  const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
  const refreshTokenEncrypted = tokens.refresh_token ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY) : null;
  const expiresAt = tokens.expires_in ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000) : null;

  const existing = await env.DB.prepare('SELECT id FROM zoom_connections WHERE user_id = ?').bind(userId).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE zoom_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?, zoom_user_id = ?, email = ?, updated_at = datetime('now') WHERE user_id = ?`
    ).bind(accessTokenEncrypted, refreshTokenEncrypted, expiresAt, zoomUserId, zoomEmail, userId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO zoom_connections (user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, zoom_user_id, email) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, accessTokenEncrypted, refreshTokenEncrypted, expiresAt, zoomUserId, zoomEmail).run();
  }
  return Response.redirect(`${origin}/dashboard/?tab=availability&zoom=connected`, 302);
}

// Report whether Zoom is configured on the server and connected for this user.
async function handleZoomStatus(request, env, user) {
  const conn = await env.DB.prepare('SELECT email FROM zoom_connections WHERE user_id = ?').bind(user.id).first();
  return jsonResponse({
    configured: isZoomOAuthConfigured(env),
    connected: !!conn,
    email: conn?.email || null,
  });
}

// Disconnect Zoom: revoke the token at Zoom (best-effort) and delete the row.
async function handleZoomDisconnect(request, env, user) {
  const conn = await env.DB.prepare('SELECT * FROM zoom_connections WHERE user_id = ?').bind(user.id).first();
  if (conn && isZoomOAuthConfigured(env)) {
    try {
      const accessToken = await decryptToken(conn.access_token_encrypted, env.ENCRYPTION_KEY);
      const credentials = btoa(`${env.ZOOM_OAUTH_CLIENT_ID}:${env.ZOOM_OAUTH_CLIENT_SECRET}`);
      await fetch('https://zoom.us/oauth/revoke', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }),
      });
    } catch (err) { console.error('Zoom revoke failed (continuing):', err); }
  }
  await env.DB.prepare('DELETE FROM zoom_connections WHERE user_id = ?').bind(user.id).run();
  return jsonResponse({ ok: true });
}

// Hex HMAC-SHA256 of `message` keyed by `secret`. Used for Zoom webhook signature
// verification and the URL-validation handshake.
async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Zoom webhook endpoint (public). Handles two things, both required for a
// published OAuth app that stores user data:
//   1. endpoint.url_validation — the handshake Zoom runs when you set the webhook
//      URL: echo back { plainToken, encryptedToken } where encryptedToken is the
//      HMAC-SHA256 of plainToken keyed by the app's Secret Token.
//   2. app_deauthorized — when a user removes Calendo from their Zoom account, we
//      verify the x-zm-signature, delete that user's stored Zoom data, and submit
//      the data-compliance confirmation back to Zoom.
// Every non-validation request is authenticated via the x-zm-signature header so
// only genuine Zoom events are honored.
async function handleZoomWebhook(request, env) {
  const secret = env.ZOOM_WEBHOOK_SECRET_TOKEN;
  const rawBody = await request.text();
  let body;
  try { body = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  // 1. URL validation handshake (only used when an Event Subscription with a
  // Secret Token is configured). Requires the secret to answer the challenge.
  if (body.event === 'endpoint.url_validation') {
    if (!secret) return jsonResponse({ error: 'Zoom webhook is not configured' }, 503);
    const plainToken = body.payload?.plainToken || '';
    const encryptedToken = await hmacSha256Hex(plainToken, secret);
    return jsonResponse({ plainToken, encryptedToken });
  }

  // 2. Authenticate the event. Preferred path: Zoom's x-zm-signature, verified as
  // HMAC-SHA256 over "v0:<timestamp>:<rawBody>" keyed by the Secret Token.
  // BUT the General-app *deauthorization* endpoint does not expose a Secret Token,
  // so Zoom may POST app_deauthorized WITHOUT a signature. In that case, fall back
  // to confirming the event targets THIS app (payload.client_id === our client id)
  // and only ever delete a connection we actually hold — so a forged request can,
  // at worst, drop a Zoom link the user can re-add, and only for a real user.
  const signature = request.headers.get('x-zm-signature');
  if (signature) {
    if (!secret) return jsonResponse({ error: 'Zoom webhook is not configured' }, 503);
    const timestamp = request.headers.get('x-zm-request-timestamp') || '';
    const expected = `v0=${await hmacSha256Hex(`v0:${timestamp}:${rawBody}`, secret)}`;
    if (!timingSafeEqual(signature, expected)) {
      return jsonResponse({ error: 'Invalid signature' }, 401);
    }
  } else {
    const clientId = body.payload?.client_id;
    if (!clientId || clientId !== env.ZOOM_OAUTH_CLIENT_ID) {
      return jsonResponse({ error: 'Unverified webhook' }, 401);
    }
  }

  // 3. Deauthorization: the user removed the app from their Zoom account — delete
  // their stored Zoom data and confirm compliance to Zoom.
  if (body.event === 'app_deauthorized' || body.event === 'app_uninstalled') {
    const zoomUserId = body.payload?.user_id;
    if (zoomUserId) {
      await env.DB.prepare('DELETE FROM zoom_connections WHERE zoom_user_id = ?').bind(zoomUserId).run();
    }
    try {
      if (isZoomOAuthConfigured(env) && body.payload) {
        const creds = btoa(`${env.ZOOM_OAUTH_CLIENT_ID}:${env.ZOOM_OAUTH_CLIENT_SECRET}`);
        await fetch('https://api.zoom.us/oauth/data/compliance', {
          method: 'POST',
          headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.ZOOM_OAUTH_CLIENT_ID,
            user_id: body.payload.user_id,
            account_id: body.payload.account_id,
            deauthorization_event_received: body.payload,
            compliance_completed: true,
          }),
        });
      }
    } catch (err) { console.error('Zoom data compliance call failed (continuing):', err); }
    return jsonResponse({ ok: true });
  }

  // Acknowledge any other subscribed events we don't specifically act on.
  return jsonResponse({ ok: true });
}

// Refresh a user's Zoom access token. Zoom rotates refresh tokens on every
// refresh, so we MUST persist the new refresh token or the connection dies.
async function refreshZoomToken(env, connection) {
  if (!connection.refresh_token_encrypted) throw new Error('No Zoom refresh token available');
  const refreshToken = await decryptToken(connection.refresh_token_encrypted, env.ENCRYPTION_KEY);
  const credentials = btoa(`${env.ZOOM_OAUTH_CLIENT_ID}:${env.ZOOM_OAUTH_CLIENT_SECRET}`);
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!response.ok) throw new Error(`Zoom token refresh failed: ${await response.text()}`);
  const tokens = await response.json();
  const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
  const refreshTokenEncrypted = tokens.refresh_token
    ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY)
    : connection.refresh_token_encrypted;
  const expiresAt = tokens.expires_in ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000) : null;
  await env.DB.prepare(
    `UPDATE zoom_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(accessTokenEncrypted, refreshTokenEncrypted, expiresAt, connection.id).run();
  return tokens.access_token;
}

// Return a valid Zoom access token for a user, or null if they haven't connected.
async function getValidZoomToken(env, userId) {
  const connection = await env.DB.prepare('SELECT * FROM zoom_connections WHERE user_id = ?').bind(userId).first();
  if (!connection) return null;
  try {
    if (connection.token_expires_at) {
      const expiresAt = parseStoredUtcDate(connection.token_expires_at);
      if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
        return await refreshZoomToken(env, connection);
      }
    }
    return await decryptToken(connection.access_token_encrypted, env.ENCRYPTION_KEY);
  } catch (err) {
    console.error('Failed to get valid Zoom token:', err);
    return null;
  }
}

// Create a Zoom meeting in the HOST's own account. Returns the join URL, or null
// if the host hasn't connected Zoom (booking proceeds without a link, same as
// google_meet without a connected calendar).
async function createZoomMeeting(env, hostUserId, booking, eventType) {
  const accessToken = await getValidZoomToken(env, hostUserId);
  if (!accessToken) return null;
  try {
    const startTime = booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z';
    const response = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: `${eventType.name} with ${booking.invitee_name}`,
        type: 2,
        start_time: startTime,
        duration: eventType.duration_minutes,
        timezone: 'UTC',
        settings: {
          join_before_host: true,
          waiting_room: false,
          meeting_authentication: false,
        },
      }),
    });
    if (!response.ok) { console.error('Zoom meeting creation failed:', await response.text()); return null; }
    const meeting = await response.json();
    return meeting.join_url || null;
  } catch (err) { console.error('Failed to create Zoom meeting:', err); return null; }
}

async function createGoogleMeetLink(env, userId, booking, eventType) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1'
  ).bind(userId, 'google').all();
  if (!connections.results || connections.results.length === 0) return null;
  const connection = connections.results[0];
  try {
    const accessToken = await getValidAccessToken(env, connection);
    const appOrigin = env.APP_ORIGIN || 'https://calendo.dev';
    const startTime = booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z';
    const endTime = booking.end_time.includes('T') ? booking.end_time : booking.end_time.replace(' ', 'T') + 'Z';

    const cancelUrl = `${appOrigin}/booking/cancel.html?token=${booking.cancel_token}`;
    const rescheduleUrl = `${appOrigin}/booking/reschedule.html?token=${booking.cancel_token}`;

    // Format booking answers
    let answersDesc = '';
    if (booking.answers) {
      try {
        const answers = typeof booking.answers === 'string' ? JSON.parse(booking.answers) : booking.answers;
        const answerEntries = Object.entries(answers).filter(([_, v]) => v);
        if (answerEntries.length > 0) {
          answersDesc = '\nResponses:\n' + answerEntries.map(([q, a]) => `• ${q}: ${a}`).join('\n');
        }
      } catch {}
    }

    const description = [
      `Event Name: ${eventType.name}`,
      `Invitee: ${booking.invitee_name} (${booking.invitee_email})`,
      answersDesc,
      '',
      `Location: This is a Google Meet web conference.`,
      `You can join this meeting from your computer, tablet, or smartphone.`,
      '',
      `Need to make changes to this event?`,
      `Cancel: ${cancelUrl}`,
      `Reschedule: ${rescheduleUrl}`,
      '',
      `Powered by Calendo`,
    ].join('\n');

    const event = {
      summary: `${eventType.name} with ${booking.invitee_name}`,
      description,
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: [{ email: booking.invitee_email }],
      conferenceData: {
        createRequest: {
          requestId: booking.uid || crypto.randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 10 },
          { method: 'popup', minutes: 30 },
        ],
      },
    };
    const calendarId = connection.calendar_id || 'primary';
    const createResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
    );
    if (!createResponse.ok) { console.error('Google Meet link creation failed:', await createResponse.text()); return null; }
    const createdEvent = await createResponse.json();
    const meetLink = createdEvent.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri;
    return { meetLink: meetLink || null, calendarEventId: createdEvent.id };
  } catch (err) { console.error('Failed to create Google Meet link:', err); return null; }
}

async function createTeamsMeeting(env, userId, booking, eventType) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND write_events = 1'
  ).bind(userId, 'outlook').all();
  if (!connections.results || connections.results.length === 0) return null;
  const connection = connections.results[0];
  try {
    const accessToken = await getValidOutlookToken(env, connection);
    const startTime = booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z';
    const endTime = booking.end_time.includes('T') ? booking.end_time : booking.end_time.replace(' ', 'T') + 'Z';

    // Try creating an online meeting directly via the onlineMeetings API
    const meetingResponse = await fetch('https://graph.microsoft.com/v1.0/me/onlineMeetings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: `${eventType.name} with ${booking.invitee_name}`,
        startDateTime: startTime,
        endDateTime: endTime,
      }),
    });

    if (meetingResponse.ok) {
      const meeting = await meetingResponse.json();
      return meeting.joinWebUrl || meeting.joinUrl || null;
    }

    // Fall back to creating a calendar event with isOnlineMeeting
    const event = {
      subject: `${eventType.name} with ${booking.invitee_name}`,
      body: { contentType: 'text', content: `Booked via Calendo\n\nInvitee: ${booking.invitee_name} (${booking.invitee_email})` },
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: booking.invitee_email, name: booking.invitee_name }, type: 'required' }],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    };
    const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Teams meeting creation failed:', errText);
      return null;
    }
    const createdEvent = await response.json();
    return createdEvent.onlineMeeting?.joinUrl || null;
  } catch (err) { console.error('Failed to create Teams meeting:', err); return null; }
}

// ============================================================
// Microsoft Outlook Calendar Helpers
// ============================================================

async function refreshOutlookToken(env, connection) {
  if (!connection.refresh_token_encrypted) {
    throw new Error('No Outlook refresh token available — user must re-authenticate');
  }
  const refreshToken = await decryptToken(connection.refresh_token_encrypted, env.ENCRYPTION_KEY);
  const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token',
      scope: 'openid email profile offline_access Calendars.ReadWrite OnlineMeetings.ReadWrite',
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    // Check if the refresh token itself has expired (Microsoft tokens expire after 90 days of inactivity)
    if (response.status === 400 && (errorText.includes('AADSTS700082') || errorText.includes('AADSTS50173') || errorText.includes('expired'))) {
      throw new Error('Outlook refresh token expired — user must re-connect their Outlook calendar');
    }
    throw new Error(`Outlook token refresh failed (${response.status}): ${errorText}`);
  }
  const tokens = await response.json();
  const accessTokenEncrypted = await encryptToken(tokens.access_token, env.ENCRYPTION_KEY);
  const refreshTokenEncrypted = tokens.refresh_token ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY) : connection.refresh_token_encrypted;
  const expiresAt = tokens.expires_in ? formatDbTimestamp(Date.now() + tokens.expires_in * 1000) : null;
  await env.DB.prepare(
    `UPDATE calendar_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(accessTokenEncrypted, refreshTokenEncrypted, expiresAt, connection.id).run();
  return tokens.access_token;
}

async function getValidOutlookToken(env, connection) {
  if (connection.token_expires_at) {
    const expiresAt = parseStoredUtcDate(connection.token_expires_at);
    if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) return await refreshOutlookToken(env, connection);
  } else {
    // No expiry recorded — proactively refresh to avoid using a stale token
    return await refreshOutlookToken(env, connection);
  }
  return await decryptToken(connection.access_token_encrypted, env.ENCRYPTION_KEY);
}

async function getOutlookBusyTimes(env, connection, startISO, endISO) {
  // calendarView (vs getSchedule) doesn't require the email address.
  const apiUrl = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}&$select=start,end,showAs`;
  // Force UTC in the response so start/end dateTime values are unambiguous.
  // Graph defaults to UTC, but be explicit (CU-04 inbound-sync conflict finding).
  const reqHeaders = (token) => ({ Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' });
  // calendarView returns dateTime without a trailing 'Z'; mark it UTC so Date parses it correctly.
  const toUtcIso = (dt) => (dt && dt.endsWith('Z') ? dt : dt + 'Z');
  try {
    let accessToken = await getValidOutlookToken(env, connection);
    let response = await fetch(apiUrl, { headers: reqHeaders(accessToken) });

    // If 401, force a token refresh and retry once
    if (response.status === 401) {
      try {
        accessToken = await refreshOutlookToken(env, connection);
        response = await fetch(apiUrl, { headers: reqHeaders(accessToken) });
      } catch (refreshErr) {
        console.error('Outlook token refresh failed during retry:', refreshErr);
        await logCalendarSyncError(env, connection.user_id, 'outlook', 'token_refresh_error', String(refreshErr), connection.id);
        return [];
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error('Outlook calendarView API error:', response.status, errText);
      // Surface the failure — a silently-swallowed conflict-check error means a
      // real Outlook busy event won't block slots (double-booking risk).
      await logCalendarSyncError(env, connection.user_id, 'outlook', 'api_error', `HTTP ${response.status}: ${errText}`, connection.id);
      return [];
    }
    const data = await response.json();
    const events = data.value || [];
    return events
      .filter(item => item.showAs === 'busy' || item.showAs === 'tentative' || item.showAs === 'oof')
      .map(item => ({ start: toUtcIso(item.start.dateTime), end: toUtcIso(item.end.dateTime) }));
  } catch (err) {
    console.error('Failed to get Outlook busy times:', err);
    await logCalendarSyncError(env, connection.user_id, 'outlook', 'busy_fetch_error', String(err), connection.id);
    return [];
  }
}

// Full event details fetchers (for Meetings tab and Calendar view)
async function logCalendarSyncError(env, userId, provider, errorType, errorMessage, connectionId) {
  try {
    await env.DB.prepare(
      'INSERT INTO calendar_sync_errors (user_id, provider, error_type, error_message, connection_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, provider, errorType, (errorMessage || '').slice(0, 500), connectionId || null).run();
  } catch { /* best-effort logging */ }
}

async function getGoogleCalendarEvents(env, userId, startISO, endISO) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
  ).bind(userId, 'google').all();
  if (!connections.results || connections.results.length === 0) return [];

  const allEvents = [];
  for (const connection of connections.results) {
    try {
      const accessToken = await getValidAccessToken(env, connection);
      const calId = encodeURIComponent(connection.calendar_id || 'primary');
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${encodeURIComponent(startISO)}&timeMax=${encodeURIComponent(endISO)}&singleEvents=true&orderBy=startTime&maxResults=250`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!response.ok) {
        const errText = await response.text();
        console.error('Google Calendar Events API error:', response.status, errText);
        await logCalendarSyncError(env, userId, 'google', 'api_error', `HTTP ${response.status}: ${errText}`, connection.id);
        continue;
      }
      const data = await response.json();
      for (const ev of (data.items || [])) {
        if (ev.status === 'cancelled') continue;
        let start = ev.start?.dateTime || null;
        let end = ev.end?.dateTime || null;
        // Handle all-day events (date only, no time)
        if (!start && ev.start?.date) {
          start = ev.start.date + 'T00:00:00Z';
          end = (ev.end?.date || ev.start.date) + 'T23:59:59Z';
        }
        if (!start || !end) continue;
        const meetLink = ev.hangoutLink || ev.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null;
        allEvents.push({
          title: ev.summary || '(No title)',
          start, end,
          location: meetLink || ev.location || null,
          source: 'google',
          color: '#ea4335',
        });
      }
    } catch (err) {
      console.error('Google events fetch error:', err);
      await logCalendarSyncError(env, userId, 'google', 'token_refresh', err.message, connection.id);
    }
  }
  return allEvents;
}

async function getOutlookCalendarEvents(env, userId, startISO, endISO) {
  const connections = await env.DB.prepare(
    'SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND check_conflicts = 1'
  ).bind(userId, 'outlook').all();
  if (!connections.results || connections.results.length === 0) return [];

  const allEvents = [];
  for (const conn of connections.results) {
    try {
      let accessToken = await getValidOutlookToken(env, conn);
      let response = await fetch(
        `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}&$select=subject,start,end,location,onlineMeeting,webLink&$orderby=start/dateTime&$top=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      // Retry once on 401 with a fresh token
      if (response.status === 401) {
        try {
          accessToken = await refreshOutlookToken(env, conn);
          response = await fetch(
            `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}&$select=subject,start,end,location,onlineMeeting,webLink&$orderby=start/dateTime&$top=100`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
        } catch (refreshErr) {
          console.error('Outlook token refresh failed during calendar events retry:', refreshErr);
          await logCalendarSyncError(env, userId, 'outlook', 'token_expired', refreshErr.message, conn.id);
          continue;
        }
      }
      if (!response.ok) {
        const errText = await response.text();
        console.error('Outlook Calendar API error:', response.status, errText);
        await logCalendarSyncError(env, userId, 'outlook', 'api_error', `HTTP ${response.status}: ${errText}`, conn.id);
        continue;
      }
      const data = await response.json();
      for (const ev of (data.value || [])) {
        const start = ev.start?.dateTime ? ev.start.dateTime + 'Z' : null;
        const end = ev.end?.dateTime ? ev.end.dateTime + 'Z' : null;
        if (!start || !end) continue;
        allEvents.push({
          title: ev.subject || '(No title)',
          start, end,
          location: ev.onlineMeeting?.joinUrl || ev.location?.displayName || null,
          source: 'outlook',
          color: '#0078d4',
        });
      }
    } catch (err) {
      console.error('Outlook events fetch error:', err);
      await logCalendarSyncError(env, userId, 'outlook', 'token_refresh', err.message, conn.id);
    }
  }
  return allEvents;
}

async function createOutlookCalendarEvent(env, connection, booking, eventType) {
  try {
    let accessToken = await getValidOutlookToken(env, connection);
    const startTime = booking.start_time.includes('T') ? booking.start_time : booking.start_time.replace(' ', 'T') + 'Z';
    const endTime = booking.end_time.includes('T') ? booking.end_time : booking.end_time.replace(' ', 'T') + 'Z';
    const event = {
      subject: `${eventType.name} with ${booking.invitee_name}`,
      body: { contentType: 'text', content: `Booked via Calendo\n\nInvitee: ${booking.invitee_name} (${booking.invitee_email})` },
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: booking.invitee_email, name: booking.invitee_name }, type: 'required' }],
    };
    // Add guest emails as attendees
    if (booking.guest_emails) {
      try {
        const guests = typeof booking.guest_emails === 'string' ? JSON.parse(booking.guest_emails) : booking.guest_emails;
        if (Array.isArray(guests)) {
          for (const guestEmail of guests) {
            if (guestEmail && guestEmail.trim()) {
              event.attendees.push({ emailAddress: { address: guestEmail.trim(), name: guestEmail.trim() }, type: 'optional' });
            }
          }
        }
      } catch {}
    }
    let response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    // Retry once on 401 with a fresh token
    if (response.status === 401) {
      try {
        accessToken = await refreshOutlookToken(env, connection);
        response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
      } catch (refreshErr) {
        console.error('Outlook token refresh failed during event creation retry:', refreshErr);
        return null;
      }
    }
    if (!response.ok) { console.error('Outlook Calendar event creation failed:', await response.text()); return null; }
    const createdEvent = await response.json();
    return createdEvent.id;
  } catch (err) { console.error('Failed to create Outlook Calendar event:', err); return null; }
}

// ============================================================
// Organization Handlers
// ============================================================

async function handleCreateOrganization(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name, slug: rawSlug } = body;
  if (!name || !name.trim()) {
    return jsonResponse({ error: 'Organization name is required' }, 400);
  }

  const slug = generateSlug(rawSlug || name);
  if (!slug) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  // Check slug uniqueness
  const existingSlug = await env.DB.prepare(
    'SELECT id FROM organizations WHERE slug = ?'
  ).bind(slug).first();
  if (existingSlug) {
    return jsonResponse({ error: 'Organization slug already taken' }, 409);
  }

  const org = await env.DB.prepare(
    'INSERT INTO organizations (name, slug, owner_id) VALUES (?, ?, ?) RETURNING *'
  ).bind(name.trim(), slug, user.id).first();

  // Add creator as owner member
  await env.DB.prepare(
    "INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')"
  ).bind(org.id, user.id).run();

  return jsonResponse(org, 201);
}

async function handleListOrganizations(request, env, user) {
  const result = await env.DB.prepare(
    `SELECT o.*, om.role as my_role
     FROM organizations o
     JOIN org_members om ON o.id = om.org_id
     WHERE om.user_id = ?
     ORDER BY o.created_at DESC`
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleGetOrganization(request, env, user, path) {
  const orgId = path.split('/').pop();

  const membership = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, user.id).first();
  if (!membership) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const org = await env.DB.prepare(
    'SELECT * FROM organizations WHERE id = ?'
  ).bind(orgId).first();
  if (!org) return jsonResponse({ error: 'Not found' }, 404);

  const members = await env.DB.prepare(
    `SELECT om.user_id, om.role, om.created_at as joined_at, u.name, u.email, u.avatar_url
     FROM org_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.org_id = ?
     ORDER BY om.created_at ASC`
  ).bind(orgId).all();

  const invitations = await env.DB.prepare(
    'SELECT id, email, role, created_at FROM org_invitations WHERE org_id = ? AND accepted = 0'
  ).bind(orgId).all();

  const eventTypes = await env.DB.prepare(
    'SELECT * FROM event_types WHERE org_id = ? AND is_active = 1 ORDER BY created_at DESC'
  ).bind(orgId).all();

  const thirtyDaysAgo = formatDbTimestamp(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const bookingStats = await env.DB.prepare(
    `SELECT assigned_user_id, COUNT(*) as booking_count
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE et.org_id = ? AND b.status IN ('confirmed', 'pending')
     AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}
     GROUP BY assigned_user_id`
  ).bind(orgId, thirtyDaysAgo).all();

  const statsMap = {};
  for (const stat of bookingStats.results) {
    if (stat.assigned_user_id) {
      statsMap[stat.assigned_user_id] = stat.booking_count;
    }
  }

  return jsonResponse({
    ...org,
    my_role: membership.role,
    members: members.results.map(m => ({
      ...m,
      booking_count_30d: statsMap[m.user_id] || 0,
    })),
    invitations: invitations.results,
    event_types: eventTypes.results,
  });
}

async function handleUpdateOrganization(request, env, user, path) {
  const orgId = path.split('/').pop();

  const membership = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, user.id).first();
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return jsonResponse({ error: 'Only admins and owners can update the organization' }, 403);
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.logo_url !== undefined) fields.logo_url = body.logo_url;

  if (Object.keys(fields).length === 0) {
    return jsonResponse({ error: 'No fields to update' }, 400);
  }

  fields.updated_at = formatDbTimestamp();
  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');

  const result = await env.DB.prepare(
    `UPDATE organizations SET ${setClauses} WHERE id = ? RETURNING *`
  ).bind(...Object.values(fields), orgId).first();

  return jsonResponse(result);
}

async function handleInviteMember(request, env, user, path) {
  const orgId = path.split('/')[3];

  const membership = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, user.id).first();
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return jsonResponse({ error: 'Only admins and owners can invite members' }, 403);
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { email, role } = body;
  if (!email || !email.trim()) {
    return jsonResponse({ error: 'Email is required' }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400);
  }

  const memberRole = role || 'member';
  if (!['member', 'admin'].includes(memberRole)) {
    return jsonResponse({ error: 'Role must be "member" or "admin"' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(normalizedEmail).first();

  if (existingUser) {
    const existingMember = await env.DB.prepare(
      'SELECT user_id FROM org_members WHERE org_id = ? AND user_id = ?'
    ).bind(orgId, existingUser.id).first();
    if (existingMember) {
      return jsonResponse({ error: 'User is already a member of this organization' }, 409);
    }

    await env.DB.prepare(
      'INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)'
    ).bind(orgId, existingUser.id, memberRole).run();

    return jsonResponse({ status: 'added', user_id: existingUser.id, role: memberRole }, 201);
  }

  const token = crypto.randomUUID();

  const existingInvite = await env.DB.prepare(
    'SELECT id FROM org_invitations WHERE org_id = ? AND email = ? AND accepted = 0'
  ).bind(orgId, normalizedEmail).first();
  if (existingInvite) {
    return jsonResponse({ error: 'An invitation has already been sent to this email' }, 409);
  }

  await env.DB.prepare(
    'INSERT INTO org_invitations (org_id, email, role, token) VALUES (?, ?, ?, ?)'
  ).bind(orgId, normalizedEmail, memberRole, token).run();

  return jsonResponse({ status: 'invited', email: normalizedEmail, role: memberRole }, 201);
}

async function handleRemoveMember(request, env, user, path) {
  const segments = path.split('/');
  const orgId = segments[3];
  const targetUserId = segments[5];

  const membership = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, user.id).first();
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return jsonResponse({ error: 'Only admins and owners can remove members' }, 403);
  }

  const targetMember = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, targetUserId).first();
  if (!targetMember) {
    return jsonResponse({ error: 'Member not found' }, 404);
  }
  if (targetMember.role === 'owner') {
    return jsonResponse({ error: 'Cannot remove the organization owner' }, 403);
  }

  await env.DB.prepare(
    'DELETE FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, targetUserId).run();

  return jsonResponse({ ok: true });
}

async function handleUpdateMemberRole(request, env, user, path) {
  const segments = path.split('/');
  const orgId = segments[3];
  const targetUserId = segments[5];

  const membership = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, user.id).first();
  if (!membership || membership.role !== 'owner') {
    return jsonResponse({ error: 'Only the owner can change member roles' }, 403);
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { role, can_edit_event_types, can_manage_bookings, can_view_analytics } = body;
  if (role && !['member', 'admin'].includes(role)) {
    return jsonResponse({ error: 'Role must be "member" or "admin"' }, 400);
  }

  if (parseInt(targetUserId) === user.id) {
    return jsonResponse({ error: 'Cannot change your own role' }, 400);
  }

  const targetMember = await env.DB.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, targetUserId).first();
  if (!targetMember) {
    return jsonResponse({ error: 'Member not found' }, 404);
  }

  // Update role and/or permissions
  const updates = [];
  const values = [];
  if (role) { updates.push('role = ?'); values.push(role); }
  if (can_edit_event_types !== undefined) { updates.push('can_edit_event_types = ?'); values.push(can_edit_event_types ? 1 : 0); }
  if (can_manage_bookings !== undefined) { updates.push('can_manage_bookings = ?'); values.push(can_manage_bookings ? 1 : 0); }
  if (can_view_analytics !== undefined) { updates.push('can_view_analytics = ?'); values.push(can_view_analytics ? 1 : 0); }

  if (updates.length === 0) return jsonResponse({ error: 'No fields to update' }, 400);

  await env.DB.prepare(
    `UPDATE org_members SET ${updates.join(', ')} WHERE org_id = ? AND user_id = ?`
  ).bind(...values, orgId, targetUserId).run();

  return jsonResponse({ ok: true });
}

// ============================================================
// Public Team Page Handler
// ============================================================

async function handleGetTeamPage(request, env, path) {
  const slug = path.replace('/api/public/team/', '');
  if (!slug) {
    return jsonResponse({ error: 'Organization slug is required' }, 400);
  }

  // Look up organization by slug
  const org = await env.DB.prepare(
    'SELECT id, name, slug, logo_url FROM organizations WHERE slug = ?'
  ).bind(slug).first();
  if (!org) {
    return jsonResponse({ error: 'Team not found' }, 404);
  }

  // Get all org members with their user info and booking page slugs
  const members = await env.DB.prepare(
    `SELECT u.id as user_id, u.name, u.avatar_url, bp.slug as booking_slug, bp.display_name
     FROM org_members om
     JOIN users u ON om.user_id = u.id
     LEFT JOIN booking_pages bp ON bp.user_id = u.id
     WHERE om.org_id = ?
     ORDER BY om.created_at ASC`
  ).bind(org.id).all();

  // Get all active, non-secret event types for the org
  const eventTypes = await env.DB.prepare(
    `SELECT et.id, et.name, et.slug, et.description, et.duration_minutes, et.color, et.user_id,
            et.location_type, et.price_cents, et.currency
     FROM event_types et
     WHERE et.org_id = ? AND et.is_active = 1 AND et.is_secret = 0
     ORDER BY et.sort_order ASC, et.created_at ASC`
  ).bind(org.id).all();

  // Also get personal (non-org) event types for each member
  const memberIds = (members.results || []).map(m => m.user_id);
  let personalEventTypes = [];
  if (memberIds.length > 0) {
    const placeholders = memberIds.map(() => '?').join(',');
    const personalResult = await env.DB.prepare(
      `SELECT et.id, et.name, et.slug, et.description, et.duration_minutes, et.color, et.user_id,
              et.location_type, et.price_cents, et.currency
       FROM event_types et
       WHERE et.user_id IN (${placeholders}) AND et.org_id IS NULL AND et.is_active = 1 AND et.is_secret = 0
       ORDER BY et.sort_order ASC, et.created_at ASC`
    ).bind(...memberIds).all();
    personalEventTypes = personalResult.results || [];
  }

  // Build member map with their event types
  const memberList = (members.results || []).map(member => {
    const orgEvents = (eventTypes.results || []).filter(et => et.user_id === member.user_id);
    const personalEvents = personalEventTypes.filter(et => et.user_id === member.user_id);
    const allEvents = [...orgEvents, ...personalEvents];
    return {
      name: member.display_name || member.name,
      avatar_url: member.avatar_url,
      booking_slug: member.booking_slug,
      event_types: allEvents.map(et => ({
        id: et.id,
        name: et.name,
        slug: et.slug,
        description: et.description,
        duration_minutes: et.duration_minutes,
        color: et.color,
        location_type: et.location_type,
        price_cents: et.price_cents,
        currency: et.currency,
      })),
    };
  });

  return jsonResponse({
    org: {
      name: org.name,
      slug: org.slug,
      logo_url: org.logo_url,
    },
    members: memberList,
  });
}

// ============================================================
// Audit Log
// ============================================================

async function logAuditEvent(db, userId, action, entityType, entityId, details, ipAddress) {
  try {
    await db.prepare(
      'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      userId || null,
      action,
      entityType || null,
      entityId || null,
      typeof details === 'object' ? JSON.stringify(details) : (details || '{}'),
      ipAddress || null
    ).run();
  } catch (err) {
    // Audit logging should never break the main flow
    console.error('Audit log error:', err);
  }
}

async function handleGetAuditLog(request, env, user, url) {
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;
  const action = url.searchParams.get('action') || '';
  const startDate = url.searchParams.get('start_date') || '';
  const endDate = url.searchParams.get('end_date') || '';

  let whereClause = 'WHERE user_id = ?';
  const bindArgs = [user.id];

  if (action) {
    whereClause += ' AND action = ?';
    bindArgs.push(action);
  }
  if (startDate) {
    whereClause += ` AND ${sqlUnixEpoch('created_at')} >= ${sqlUnixEpoch('?')}`;
    bindArgs.push(startDate);
  }
  if (endDate) {
    whereClause += ` AND ${sqlUnixEpoch('created_at')} <= ${sqlUnixEpoch('?')}`;
    bindArgs.push(endDate);
  }

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM audit_log ${whereClause}`
  ).bind(...bindArgs).first();

  const results = await env.DB.prepare(
    `SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...bindArgs, limit, offset).all();

  return jsonResponse({
    data: results.results || [],
    pagination: {
      page,
      limit,
      total: countResult?.total || 0,
    },
  });
}

async function handleAdminAuditLog(request, env, user, url) {
  if (!isAdmin(env, user)) return jsonResponse({ error: 'Forbidden' }, 403);

  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;
  const action = url.searchParams.get('action') || '';
  const userId = url.searchParams.get('user_id') || '';

  let whereClause = '';
  const conditions = [];
  const bindArgs = [];

  if (action) {
    conditions.push('action = ?');
    bindArgs.push(action);
  }
  if (userId) {
    conditions.push('user_id = ?');
    bindArgs.push(parseInt(userId, 10));
  }

  if (conditions.length > 0) {
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM audit_log ${whereClause}`
  ).bind(...bindArgs).first();

  const results = await env.DB.prepare(
    `SELECT al.*, u.name as user_name, u.email as user_email
     FROM audit_log al
     LEFT JOIN users u ON al.user_id = u.id
     ${whereClause}
     ORDER BY al.created_at DESC LIMIT ? OFFSET ?`
  ).bind(...bindArgs, limit, offset).all();

  return jsonResponse({
    data: results.results || [],
    pagination: {
      page,
      limit,
      total: countResult?.total || 0,
    },
  });
}

// ============================================================
// AI Chat Handler
// ============================================================

async function handleAIChat(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { booking_page_slug, session_id, message } = body;
  if (!booking_page_slug || !message) {
    return jsonResponse({ error: 'booking_page_slug and message are required' }, 400);
  }

  const chatSessionId = session_id || crypto.randomUUID();

  // Look up the booking page and host
  const page = await env.DB.prepare(
    `SELECT bp.*, u.name as host_name, u.timezone as host_timezone
     FROM booking_pages bp JOIN users u ON bp.user_id = u.id
     WHERE bp.slug = ?`
  ).bind(booking_page_slug).first();

  if (!page) return jsonResponse({ error: 'Booking page not found' }, 404);

  // Get event types
  const eventTypes = await env.DB.prepare(
    `SELECT id, name, slug, description, duration_minutes, color
     FROM event_types WHERE user_id = ? AND is_active = 1 AND is_secret = 0`
  ).bind(page.user_id).all();

  // Get or create conversation
  let conversation = await env.DB.prepare(
    'SELECT * FROM ai_conversations WHERE booking_page_id = ? AND session_id = ?'
  ).bind(page.id, chatSessionId).first();

  let messages = [];
  if (conversation) {
    messages = JSON.parse(conversation.messages || '[]');
  }

  messages.push({ role: 'user', content: message, ts: new Date().toISOString() });

  // Fetch REAL availability for the next 14 days
  const hostTz = page.host_timezone || 'America/Los_Angeles';
  const today = new Date();
  const start = formatDateInTz(today, hostTz);
  const endDate = new Date(today.getTime() + 14 * 86400000);
  const end = formatDateInTz(endDate, hostTz);

  let availabilityText = '';
  let availabilitySlots = null;
  const defaultEvent = eventTypes.results[0];
  if (defaultEvent) {
    const schedule = await env.DB.prepare(
      'SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1'
    ).bind(page.user_id).first();

    if (schedule) {
      const bookingsResult = await env.DB.prepare(
        `SELECT start_time, end_time, status FROM bookings
         WHERE event_type_id = ? AND status IN ('confirmed', 'pending', 'pending_payment')
         AND ${sqlUnixEpoch('start_time')} <= ${sqlUnixEpoch('?')}
         AND ${sqlUnixEpoch('end_time')} >= ${sqlUnixEpoch('?')}`
      ).bind(defaultEvent.id, end + 'T23:59:59Z', start + 'T00:00:00Z').all();

      const slots = computeAvailableSlots({
        schedule: {
          rules: JSON.parse(schedule.rules || '[]'),
          overrides: JSON.parse(schedule.overrides || '[]'),
          holidays: JSON.parse(schedule.holidays || '[]'),
          timezone: schedule.timezone,
        },
        eventType: defaultEvent,
        existingBookings: bookingsResult.results,
        dateRange: { start, end },
        inviteeTimezone: hostTz,
      });
      availabilitySlots = slots;

      // Format availability as human-readable text for the AI
      const slotEntries = Object.entries(slots);
      if (slotEntries.length > 0) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        availabilityText = '\n\nREAL AVAILABLE SLOTS (use these exact times when suggesting):\n';
        for (const [date, times] of slotEntries.slice(0, 5)) { // first 5 days
          const d = new Date(date + 'T12:00:00Z');
          const dayName = dayNames[d.getUTCDay()];
          const dateLabel = date === start ? 'Today' : `${dayName}, ${date}`;
          availabilityText += `${dateLabel}: ${times.slice(0, 8).join(', ')}\n`;
        }
      } else {
        availabilityText = '\n\nNo available slots in the next 14 days.';
      }
    }
  }

  const eventTypeList = eventTypes.results.map(et =>
    `- "${et.name}" (${et.duration_minutes} min): ${et.description || 'No description'} [slug: ${et.slug}]`
  ).join('\n');

  // Check if user is trying to confirm a booking
  const conversationContext = messages.map(m => m.content).join(' ').toLowerCase();
  const looksLikeConfirmation = /\b(yes|book it|confirm|sounds good|perfect|go ahead|let's do it|that works|9\s*pm|10\s*am|book.*slot)\b/i.test(message);

  const systemPrompt = `You are Calendo AI, a friendly scheduling assistant for ${page.host_name}. You help people find the right time to meet.

Available event types:
${eventTypeList}

Host timezone: ${hostTz}
Current time: ${new Date().toLocaleString('en-US', { timeZone: hostTz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}
${availabilityText}

RULES:
1. Always respond in plain, friendly English. Never output JSON, code, or technical data.
2. Show times as "3:00 PM" not "15:00". Always use the host's timezone (${hostTz}).
3. Only suggest times from the REAL AVAILABLE SLOTS listed above. Never make up times.
4. When the user picks a time, tell them you'll show a quick form to complete the booking. Say something like "Great choice! I'll pull up a quick form for you to confirm."
5. NEVER ask for or guess email addresses. NEVER make up names. The form will collect that.
6. Keep responses short — 2-3 sentences max. Be warm and helpful.
7. If no slots are available today, suggest the next day that has slots.`;

  try {
    const chatMessages = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));

    // Use Claude API (Sonnet 4.6)
    const bookingAiKey = await getAIApiKey(env, page.user_id);
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': bookingAiKey || env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages: chatMessages,
      }),
    });

    let responseText;
    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error('Claude API error:', claudeResponse.status, errText);
      // Fall back to Cloudflare Workers AI
      const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [{ role: 'system', content: systemPrompt }, ...chatMessages],
        max_tokens: 500,
      });
      responseText = aiResponse.response || 'I\'m sorry, I couldn\'t process that. Could you try again?';
    } else {
      const claudeData = await claudeResponse.json();
      responseText = claudeData.content?.[0]?.text || 'I\'m sorry, I couldn\'t process that. Could you try again?';
    }

    // Strip any JSON fragments
    try {
      const parsed = JSON.parse(responseText);
      responseText = parsed.message || responseText;
    } catch {
      responseText = responseText.replace(/\{["\s]*type["\s]*:.*?\}/gs, '').trim();
      responseText = responseText.replace(/BOOK:.*$/gm, '').trim();
    }

    if (!responseText) responseText = 'I can help you book a meeting! What kind of meeting do you need, and when works best for you?';

    // Detect if a time was likely selected — look for confirmation language
    let suggestedSlot = null;
    const confirmWords = /\b(great choice|i'll pull up|confirm|let me book|perfect|form|complete the booking|quick form)\b/i;
    if (confirmWords.test(responseText) && defaultEvent && availabilitySlots) {
      // Use the real computed slots directly
      const allSlots = [];
      for (const [date, times] of Object.entries(availabilitySlots)) {
        for (const time of times) {
          allSlots.push({ date, time });
        }
      }
      if (allSlots.length > 0) {
        suggestedSlot = {
          event_slug: defaultEvent.slug,
          event_name: defaultEvent.name,
          duration: defaultEvent.duration_minutes,
          slots: allSlots.slice(0, 20),
        };
      }
    }

    messages.push({ role: 'assistant', content: responseText, ts: new Date().toISOString() });

    const messagesJson = JSON.stringify(messages);
    if (conversation) {
      await env.DB.prepare(
        `UPDATE ai_conversations SET messages = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(messagesJson, conversation.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO ai_conversations (booking_page_id, session_id, messages) VALUES (?, ?, ?)`
      ).bind(page.id, chatSessionId, messagesJson).run();
    }

    return jsonResponse({
      session_id: chatSessionId,
      message: responseText,
      show_booking_form: !!suggestedSlot,
      suggested_slot: suggestedSlot,
    });
  } catch (err) {
    console.error('AI chat error:', err);
    const fallback = `I can help you book a meeting with ${page.host_name}! They offer:\n\n${eventTypeList}\n\nWhat kind of meeting do you need?`;
    messages.push({ role: 'assistant', content: fallback, ts: new Date().toISOString() });

    return jsonResponse({
      session_id: chatSessionId,
      message: fallback,
    });
  }
}

function formatDateInTz(date, tz) {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

// ============================================================
// ============================================================
// Stripe Payment Handlers
// ============================================================

async function handleCreateCheckout(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { booking_uid, success_url, cancel_url } = body;
  if (!booking_uid) return jsonResponse({ error: 'booking_uid is required' }, 400);
  if (!success_url || !cancel_url) return jsonResponse({ error: 'success_url and cancel_url are required' }, 400);

  const booking = await env.DB.prepare(
    `SELECT b.* FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.uid = ? AND et.user_id = ?`
  ).bind(booking_uid, user.id).first();
  if (!booking) return jsonResponse({ error: 'Booking not found' }, 404);

  const eventType = await env.DB.prepare(
    'SELECT * FROM event_types WHERE id = ?'
  ).bind(booking.event_type_id).first();
  if (!eventType) return jsonResponse({ error: 'Event type not found' }, 404);

  const priceCents = eventType.price_cents || 0;
  if (priceCents <= 0) return jsonResponse({ error: 'This event type is not a paid event' }, 400);

  try {
    const checkoutUrl = await createCheckoutSession(env, {
      eventType,
      booking,
      successUrl: success_url,
      cancelUrl: cancel_url,
    });
    return jsonResponse({ checkout_url: checkoutUrl });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return jsonResponse({ error: 'Failed to create checkout session' }, 500);
  }
}

async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const signature = request.headers.get('Stripe-Signature');

  if (!signature) return jsonResponse({ error: 'Missing Stripe-Signature header' }, 400);

  const valid = await verifyWebhookSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonResponse({ error: 'Invalid signature' }, 401);

  const event = JSON.parse(payload);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;

      // Subscription checkout — upgrade user to Pro
      if (session.mode === 'subscription') {
        const customerId = session.customer;
        if (!customerId) break;

        const user = await env.DB.prepare(
          'SELECT * FROM users WHERE stripe_customer_id = ?'
        ).bind(customerId).first();
        if (!user) break;

        await env.DB.prepare(
          `UPDATE users SET plan = 'pro', stripe_subscription_id = ?, updated_at = ? WHERE id = ?`
        ).bind(session.subscription, formatDbTimestamp(), user.id).run();
        break;
      }

      // Per-booking payment checkout
      const bookingUid = session.metadata?.booking_uid;
      if (!bookingUid) break;

      const booking = await env.DB.prepare('SELECT * FROM bookings WHERE uid = ?').bind(bookingUid).first();
      if (!booking) break;

      const wasPendingPayment = booking.status === 'pending_payment';
      await env.DB.prepare(
        `UPDATE bookings SET status = 'confirmed', updated_at = ? WHERE uid = ?`
      ).bind(formatDbTimestamp(), bookingUid).run();

      // Payment succeeded — now the coupon use actually counts
      if (wasPendingPayment && booking.coupon_id) {
        await env.DB.prepare('UPDATE coupons SET use_count = use_count + 1 WHERE id = ?').bind(booking.coupon_id).run();
      }

      const eventType = await env.DB.prepare('SELECT * FROM event_types WHERE id = ?').bind(booking.event_type_id).first();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO payments (booking_id, amount_cents, currency, stripe_payment_intent_id, status) VALUES (?, ?, ?, ?, 'succeeded')`
      ).bind(
        booking.id,
        eventType?.price_cents || session.amount_total || 0,
        eventType?.currency || 'usd',
        session.payment_intent
      ).run();

      if (wasPendingPayment && eventType) {
        const confirmedBooking = await env.DB.prepare('SELECT * FROM bookings WHERE uid = ?').bind(bookingUid).first();
        if (confirmedBooking) {
          await runBookingCreatedSideEffects(env, {
            booking: confirmedBooking,
            eventType,
            hostUserId: eventType.user_id,
            appOrigin: env.APP_ORIGIN || 'https://calendo.dev',
            clientIP: null,
          });
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      if (!customerId) break;

      await env.DB.prepare(
        `UPDATE users SET plan = 'free', stripe_subscription_id = NULL, updated_at = ? WHERE stripe_customer_id = ?`
      ).bind(formatDbTimestamp(), customerId).run();
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      if (!customerId) break;

      // Downgrade if subscription moves to canceled, past_due, or unpaid
      if (['canceled', 'past_due', 'unpaid'].includes(subscription.status)) {
        await env.DB.prepare(
          `UPDATE users SET plan = 'free', updated_at = ? WHERE stripe_customer_id = ?`
        ).bind(formatDbTimestamp(), customerId).run();
      }
      // Re-activate if subscription becomes active again
      else if (subscription.status === 'active') {
        await env.DB.prepare(
          `UPDATE users SET plan = 'pro', stripe_subscription_id = ?, updated_at = ? WHERE stripe_customer_id = ?`
        ).bind(subscription.id, formatDbTimestamp(), customerId).run();
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      if (!customerId) break;

      // Only downgrade for subscription invoices, not one-time payments
      if (invoice.subscription) {
        await env.DB.prepare(
          `UPDATE users SET plan = 'free', updated_at = ? WHERE stripe_customer_id = ?`
        ).bind(formatDbTimestamp(), customerId).run();
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      const paymentIntentId = charge.payment_intent;
      if (!paymentIntentId) break;

      await env.DB.prepare(
        `UPDATE payments SET status = 'refunded', refunded_at = datetime('now') WHERE stripe_payment_intent_id = ?`
      ).bind(paymentIntentId).run();
      break;
    }
  }

  return jsonResponse({ received: true });
}

// ============================================================
// Stripe Subscription Handlers
// ============================================================

async function handleCreateSubscription(request, env, user) {
  // Already on Pro?
  if (isPro(user)) {
    return jsonResponse({ error: 'Already on Pro plan' }, 400);
  }

  try {
    let customerId = user.stripe_customer_id;

    // Create Stripe customer if needed
    if (!customerId) {
      customerId = await createStripeCustomer(env, user);
      await env.DB.prepare(
        `UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`
      ).bind(customerId, formatDbTimestamp(), user.id).run();
    }

    const appOrigin = env.APP_ORIGIN || 'https://calendo.dev';
    const checkoutUrl = await createSubscriptionCheckout(env, {
      customerId,
      successUrl: `${appOrigin}/dashboard/?upgrade=success`,
      cancelUrl: `${appOrigin}/dashboard/?upgrade=cancelled`,
    });

    return jsonResponse({ checkout_url: checkoutUrl });
  } catch (err) {
    console.error('Subscription checkout error:', err);
    return jsonResponse({ error: 'Failed to create subscription checkout' }, 500);
  }
}

async function handleCustomerPortal(request, env, user) {
  if (!user.stripe_customer_id) {
    return jsonResponse({ error: 'No billing account found' }, 400);
  }

  try {
    const appOrigin = env.APP_ORIGIN || 'https://calendo.dev';
    const portalUrl = await createCustomerPortalSession(env, {
      customerId: user.stripe_customer_id,
      returnUrl: `${appOrigin}/dashboard/`,
    });

    return jsonResponse({ portal_url: portalUrl });
  } catch (err) {
    console.error('Customer portal error:', err);
    return jsonResponse({ error: 'Failed to create customer portal session' }, 500);
  }
}

async function handleListPayments(request, env, user) {
  const result = await env.DB.prepare(
    `SELECT p.*, b.uid as booking_uid, b.invitee_name, b.invitee_email, et.name as event_type_name
     FROM payments p
     JOIN bookings b ON p.booking_id = b.id
     JOIN event_types et ON b.event_type_id = et.id
     WHERE et.user_id = ?
     ORDER BY p.created_at DESC`
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleBookingRefund(request, env, user, path) {
  const bookingId = path.split('/')[3];

  const booking = await env.DB.prepare(
    `SELECT b.* FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?`
  ).bind(bookingId, user.id).first();
  if (!booking) return jsonResponse({ error: 'Booking not found' }, 404);

  const payment = await env.DB.prepare(
    `SELECT * FROM payments WHERE booking_id = ? AND status = 'succeeded'`
  ).bind(bookingId).first();
  if (!payment) return jsonResponse({ error: 'No successful payment found for this booking' }, 404);
  if (!payment.stripe_payment_intent_id) return jsonResponse({ error: 'No Stripe payment intent found' }, 400);

  try {
    const refund = await handleRefund(env, payment.stripe_payment_intent_id);
    return jsonResponse({ ok: true, refund_id: refund.id });
  } catch (err) {
    console.error('Refund error:', err);
    return jsonResponse({ error: 'Failed to process refund' }, 500);
  }
}

// ============================================================
// PayPal Payment Handlers
// ============================================================

async function handlePayPalCapture(request, env, url) {
  const bookingUid = url.searchParams.get('token');
  if (!bookingUid) {
    return jsonResponse({ error: 'Missing token parameter' }, 400);
  }

  // Look up the booking
  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE uid = ?').bind(bookingUid).first();
  if (!booking) {
    return jsonResponse({ error: 'Booking not found' }, 404);
  }

  if (booking.status !== 'pending_payment') {
    const appOrigin = env.APP_ORIGIN || new URL(request.url).origin;
    if (booking.status === 'confirmed' || booking.status === 'pending') {
      // Already captured — show the confirmed page
      return Response.redirect(`${appOrigin}/booking/confirmed?uid=${bookingUid}`, 302);
    }
    // Expired or cancelled — never capture money for a dead booking
    return Response.redirect(`${appOrigin}/booking/cancelled?uid=${bookingUid}`, 302);
  }

  // Look up the pending PayPal payment
  const payment = await env.DB.prepare(
    `SELECT * FROM payments WHERE booking_id = ? AND paypal_order_id IS NOT NULL AND status = 'pending'`
  ).bind(booking.id).first();
  if (!payment || !payment.paypal_order_id) {
    return jsonResponse({ error: 'No pending PayPal payment found for this booking' }, 404);
  }

  // Get event type to find host user
  const eventType = await env.DB.prepare('SELECT * FROM event_types WHERE id = ?').bind(booking.event_type_id).first();
  if (!eventType) {
    return jsonResponse({ error: 'Event type not found' }, 404);
  }

  // Get host user's PayPal credentials
  const hostUser = await env.DB.prepare(
    'SELECT paypal_client_id_encrypted, paypal_client_secret_encrypted, paypal_mode FROM users WHERE id = ?'
  ).bind(eventType.user_id).first();
  if (!hostUser?.paypal_client_id_encrypted || !hostUser?.paypal_client_secret_encrypted) {
    return jsonResponse({ error: 'PayPal credentials not configured' }, 500);
  }

  try {
    const paypalClientId = await decryptToken(hostUser.paypal_client_id_encrypted, env.ENCRYPTION_KEY);
    const paypalClientSecret = await decryptToken(hostUser.paypal_client_secret_encrypted, env.ENCRYPTION_KEY);
    const paypalMode = hostUser.paypal_mode || 'sandbox';

    const accessToken = await getPayPalAccessToken(paypalClientId, paypalClientSecret, paypalMode);
    const capture = await capturePayPalOrder({
      accessToken,
      mode: paypalMode,
      orderId: payment.paypal_order_id,
    });

    if (capture.status === 'COMPLETED') {
      // Update payment status
      await env.DB.prepare(
        `UPDATE payments SET status = 'succeeded' WHERE id = ?`
      ).bind(payment.id).run();

      // Confirm the booking
      await env.DB.prepare(
        `UPDATE bookings SET status = 'confirmed', updated_at = ? WHERE id = ?`
      ).bind(formatDbTimestamp(), booking.id).run();

      // Payment succeeded — now the coupon use actually counts
      if (booking.coupon_id) {
        await env.DB.prepare('UPDATE coupons SET use_count = use_count + 1 WHERE id = ?').bind(booking.coupon_id).run();
      }

      // Run side effects (emails, calendar, webhooks)
      const confirmedBooking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(booking.id).first();
      if (confirmedBooking) {
        await runBookingCreatedSideEffects(env, {
          booking: confirmedBooking,
          eventType,
          hostUserId: eventType.user_id,
          appOrigin: env.APP_ORIGIN || new URL(request.url).origin,
          clientIP: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || null,
        });
      }

      // Redirect to confirmed page
      const appOrigin = env.APP_ORIGIN || new URL(request.url).origin;
      return Response.redirect(`${appOrigin}/booking/confirmed?uid=${bookingUid}`, 302);
    } else {
      // Payment not completed
      await env.DB.prepare(
        `UPDATE payments SET status = 'failed' WHERE id = ?`
      ).bind(payment.id).run();
      return jsonResponse({ error: 'PayPal payment was not completed', status: capture.status }, 400);
    }
  } catch (err) {
    console.error('PayPal capture error:', err);
    return jsonResponse({ error: 'Failed to capture PayPal payment' }, 500);
  }
}

async function handleUpdatePayPalSettings(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { client_id, client_secret, mode } = body;
  if (!client_id || !client_id.trim()) return jsonResponse({ error: 'PayPal client_id is required' }, 400);
  if (!client_secret || !client_secret.trim()) return jsonResponse({ error: 'PayPal client_secret is required' }, 400);
  if (mode && !['sandbox', 'live'].includes(mode)) return jsonResponse({ error: 'mode must be "sandbox" or "live"' }, 400);

  const encryptedId = await encryptToken(client_id.trim(), env.ENCRYPTION_KEY);
  const encryptedSecret = await encryptToken(client_secret.trim(), env.ENCRYPTION_KEY);

  await env.DB.prepare(
    `UPDATE users SET paypal_client_id_encrypted = ?, paypal_client_secret_encrypted = ?, paypal_mode = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(encryptedId, encryptedSecret, mode || 'sandbox', user.id).run();

  return jsonResponse({ success: true, has_paypal: true, mode: mode || 'sandbox' });
}

async function handleDeletePayPalSettings(request, env, user) {
  await env.DB.prepare(
    `UPDATE users SET paypal_client_id_encrypted = NULL, paypal_client_secret_encrypted = NULL, paypal_mode = 'sandbox', updated_at = datetime('now') WHERE id = ?`
  ).bind(user.id).run();
  return jsonResponse({ success: true, has_paypal: false });
}

// Scheduled Tasks
// ============================================================

async function sendPendingReminders(env) {
  const now = new Date();

  // 24-hour window: bookings starting in ~24h (+/- 5 min)
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const win24Start = formatDbTimestamp(in24h.getTime() - 5 * 60 * 1000);
  const win24End = formatDbTimestamp(in24h.getTime() + 5 * 60 * 1000);

  // 1-hour window: bookings starting in ~1h (+/- 5 min)
  const in1h = new Date(now.getTime() + 60 * 60 * 1000);
  const win1Start = formatDbTimestamp(in1h.getTime() - 5 * 60 * 1000);
  const win1End = formatDbTimestamp(in1h.getTime() + 5 * 60 * 1000);

  const bookings24 = await env.DB.prepare(
    `SELECT b.*, et.name as event_type_name, et.duration_minutes, et.user_id as host_user_id, et.reminder_settings
     FROM bookings b JOIN event_types et ON b.event_type_id = et.id
     WHERE b.status = 'confirmed'
     AND ${sqlUnixEpoch('b.start_time')} >= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('b.start_time')} <= ${sqlUnixEpoch('?')}`
  ).bind(win24Start, win24End).all();

  const bookings1 = await env.DB.prepare(
    `SELECT b.*, et.name as event_type_name, et.duration_minutes, et.user_id as host_user_id, et.reminder_settings
     FROM bookings b JOIN event_types et ON b.event_type_id = et.id
     WHERE b.status = 'confirmed'
     AND ${sqlUnixEpoch('b.start_time')} >= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('b.start_time')} <= ${sqlUnixEpoch('?')}`
  ).bind(win1Start, win1End).all();

  const doSendReminder = async (booking, hoursUntil) => {
    // Check reminder settings
    let settings = { email_24h: true, email_1h: true, sms_24h: false, sms_1h: false };
    try { settings = { ...settings, ...JSON.parse(booking.reminder_settings || '{}') }; } catch {}
    const emailKey = `email_${hoursUntil}h`;
    const smsKey = `sms_${hoursUntil}h`;
    if (!settings[emailKey] && !settings[smsKey]) return;

    const reminderType = `reminder_${hoursUntil}h`;
    const alreadySent = await env.DB.prepare(
      `SELECT id FROM notification_log WHERE booking_id = ? AND type = ? AND status = 'sent'`
    ).bind(booking.id, reminderType).first();
    if (alreadySent) return;

    const eventType = { name: booking.event_type_name, duration_minutes: booking.duration_minutes };
    const host = await env.DB.prepare('SELECT id, name, email, timezone FROM users WHERE id = ?')
      .bind(booking.host_user_id).first();
    if (!host) return;

    // Send email reminders if enabled
    if (settings[emailKey]) {
      const inviteeData = reminderEmail(booking, eventType, hoursUntil, booking.invitee_name);
      await sendEmail(env, { to: booking.invitee_email, subject: inviteeData.subject, html: inviteeData.html, text: inviteeData.text, bookingId: booking.id, type: reminderType });

      const hostTz = await resolveHostTimezone(env, host.id, null, host.timezone);
      const hostData = reminderEmail(booking, eventType, hoursUntil, host.name, hostTz);
      await sendEmail(env, { to: host.email, subject: hostData.subject, html: hostData.html, text: hostData.text, bookingId: booking.id, type: reminderType });
    }

    // Send SMS reminder if enabled and phone available
    if (settings[smsKey] && booking.invitee_phone) {
      const smsType = `sms_${reminderType}`;
      const smsAlreadySent = await env.DB.prepare(
        `SELECT id FROM notification_log WHERE booking_id = ? AND type = ? AND channel = 'sms' AND status = 'sent'`
      ).bind(booking.id, smsType).first();
      if (!smsAlreadySent) {
        const dateStr = parseStoredUtcDate(booking.start_time).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
        await sendSMS(env, {
          to: booking.invitee_phone,
          body: `Calendo reminder: ${eventType.name} in ${hoursUntil}h (${dateStr}).`,
          bookingId: booking.id,
          type: smsType,
        });
      }
    }
  };

  for (const b of (bookings24.results || [])) {
    try { await doSendReminder(b, 24); } catch (err) { console.error('24h reminder failed:', b.id, err); }
  }
  for (const b of (bookings1.results || [])) {
    try { await doSendReminder(b, 1); } catch (err) { console.error('1h reminder failed:', b.id, err); }
  }

  // Process email sequences
  await processEmailSequences(env);

  // Process reconfirmation emails
  await sendPendingReconfirmations(env);
}

async function sendPendingReconfirmations(env) {
  const now = new Date();

  // Find bookings that need reconfirmation:
  // - Event type has reconfirmation_hours set
  // - Booking status is confirmed
  // - reconfirmation_sent_at is NULL (not yet sent)
  // - start_time minus reconfirmation_hours <= now (it's time to send)
  // - start_time > now (booking hasn't started yet)
  const nowISO = formatDbTimestamp(now);

  const bookingsToReconfirm = await env.DB.prepare(
    `SELECT b.*, et.name as event_type_name, et.duration_minutes, et.user_id as host_user_id, et.reconfirmation_hours
     FROM bookings b JOIN event_types et ON b.event_type_id = et.id
     WHERE b.status = 'confirmed'
     AND et.reconfirmation_hours IS NOT NULL
     AND b.reconfirmation_sent_at IS NULL
     AND ${sqlUnixEpoch('b.start_time')} - (et.reconfirmation_hours * 3600) <= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('b.start_time')} > ${sqlUnixEpoch('?')}`
  ).bind(nowISO, nowISO).all();

  for (const booking of (bookingsToReconfirm.results || [])) {
    try {
      const host = await env.DB.prepare('SELECT id, name, email, timezone FROM users WHERE id = ?')
        .bind(booking.host_user_id).first();
      if (!host) continue;

      const eventType = { name: booking.event_type_name, duration_minutes: booking.duration_minutes };
      const origin = 'https://calendo.dev';
      const confirmUrl = `${origin}/api/bookings/${booking.id}/reconfirm?token=${booking.cancel_token}`;
      const cancelUrl = `${origin}/cancel/${booking.uid}?token=${booking.cancel_token}`;

      const emailData = reconfirmationEmail(booking, eventType, host, confirmUrl, cancelUrl);
      await sendEmail(env, {
        to: booking.invitee_email,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
        bookingId: booking.id,
        type: 'reconfirmation',
      });

      // Mark as sent
      await env.DB.prepare(
        "UPDATE bookings SET reconfirmation_sent_at = datetime('now'), reconfirmed = 0, updated_at = datetime('now') WHERE id = ?"
      ).bind(booking.id).run();
    } catch (err) {
      console.error('Reconfirmation email failed:', booking.id, err);
    }
  }
}

async function processEmailSequences(env) {
  const now = new Date();
  const nowISO = formatDbTimestamp(now);

  // Get all active sequences
  const sequences = await env.DB.prepare(
    'SELECT es.*, u.email as host_email, u.name as host_name FROM email_sequences es JOIN users u ON es.user_id = u.id WHERE es.is_active = 1'
  ).all();

  for (const seq of (sequences.results || [])) {
    try {
      let bookingsToProcess = [];

      if (seq.trigger_type === 'before_meeting') {
        // Find bookings starting in ~delay_minutes (+/- 5 min window)
        const targetTime = new Date(now.getTime() + seq.delay_minutes * 60000);
        const winStart = formatDbTimestamp(targetTime.getTime() - 5 * 60000);
        const winEnd = formatDbTimestamp(targetTime.getTime() + 5 * 60000);
        const etFilter = seq.event_type_id ? `AND b.event_type_id = ${seq.event_type_id}` : '';
        bookingsToProcess = (await env.DB.prepare(
          `SELECT b.*, et.name as event_type_name FROM bookings b JOIN event_types et ON b.event_type_id = et.id
           WHERE et.user_id = ? AND b.status = 'confirmed' ${etFilter}
           AND ${sqlUnixEpoch('b.start_time')} >= ${sqlUnixEpoch('?')} AND ${sqlUnixEpoch('b.start_time')} <= ${sqlUnixEpoch('?')}`
        ).bind(seq.user_id, winStart, winEnd).all()).results || [];
      } else if (seq.trigger_type === 'after_meeting') {
        // Find bookings that ended delay_minutes ago (+/- 5 min)
        const targetTime = new Date(now.getTime() - seq.delay_minutes * 60000);
        const winStart = formatDbTimestamp(targetTime.getTime() - 5 * 60000);
        const winEnd = formatDbTimestamp(targetTime.getTime() + 5 * 60000);
        const etFilter = seq.event_type_id ? `AND b.event_type_id = ${seq.event_type_id}` : '';
        bookingsToProcess = (await env.DB.prepare(
          `SELECT b.*, et.name as event_type_name FROM bookings b JOIN event_types et ON b.event_type_id = et.id
           WHERE et.user_id = ? AND b.status = 'confirmed' ${etFilter}
           AND ${sqlUnixEpoch('b.end_time')} >= ${sqlUnixEpoch('?')} AND ${sqlUnixEpoch('b.end_time')} <= ${sqlUnixEpoch('?')}`
        ).bind(seq.user_id, winStart, winEnd).all()).results || [];
      } else if (seq.trigger_type === 'after_booking') {
        // Find bookings created delay_minutes ago (+/- 5 min)
        const targetTime = new Date(now.getTime() - seq.delay_minutes * 60000);
        const winStart = formatDbTimestamp(targetTime.getTime() - 5 * 60000);
        const winEnd = formatDbTimestamp(targetTime.getTime() + 5 * 60000);
        const etFilter = seq.event_type_id ? `AND b.event_type_id = ${seq.event_type_id}` : '';
        bookingsToProcess = (await env.DB.prepare(
          `SELECT b.*, et.name as event_type_name FROM bookings b JOIN event_types et ON b.event_type_id = et.id
           WHERE et.user_id = ? AND b.status IN ('confirmed', 'pending') ${etFilter}
           AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')} AND ${sqlUnixEpoch('b.created_at')} <= ${sqlUnixEpoch('?')}`
        ).bind(seq.user_id, winStart, winEnd).all()).results || [];
      }

      for (const booking of bookingsToProcess) {
        // Check if already sent
        const alreadySent = await env.DB.prepare(
          'SELECT id FROM email_sequence_log WHERE sequence_id = ? AND booking_id = ?'
        ).bind(seq.id, booking.id).first();
        if (alreadySent) continue;

        // Replace template variables
        const subject = replaceEmailVars(seq.subject, booking, seq);
        const body = replaceEmailVars(seq.body, booking, seq);

        await sendEmail(env, {
          to: booking.invitee_email,
          subject,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">${body.replace(/\n/g, '<br>')}</div>`,
          text: body,
          bookingId: booking.id,
          type: `sequence_${seq.id}`,
        });

        // Log it
        await env.DB.prepare(
          'INSERT INTO email_sequence_log (sequence_id, booking_id) VALUES (?, ?)'
        ).bind(seq.id, booking.id).run();
      }
    } catch (err) {
      console.error(`Email sequence ${seq.id} error:`, err);
    }
  }
}

function replaceEmailVars(template, booking, sequence) {
  return template
    .replace(/\{\{invitee_name\}\}/g, booking.invitee_name || '')
    .replace(/\{\{invitee_email\}\}/g, booking.invitee_email || '')
    .replace(/\{\{event_type\}\}/g, booking.event_type_name || '')
    .replace(/\{\{start_time\}\}/g, booking.start_time || '')
    .replace(/\{\{end_time\}\}/g, booking.end_time || '')
    .replace(/\{\{host_name\}\}/g, sequence.host_name || '')
    .replace(/\{\{date\}\}/g, booking.start_time ? booking.start_time.slice(0, 10) : '');
}

async function syncCalendars(env) {
  // Renew Google Calendar watch channels that expire within the next 24 hours
  try {
    const renewThreshold = formatDbTimestamp(Date.now() + 24 * 60 * 60 * 1000);
    const expiringConnections = await env.DB.prepare(
      `SELECT * FROM calendar_connections
       WHERE provider = 'google'
       AND watch_channel_id IS NOT NULL
       AND watch_expiration IS NOT NULL
       AND watch_expiration < ?`
    ).bind(renewThreshold).all();

    for (const connection of (expiringConnections.results || [])) {
      try {
        const accessToken = await getValidAccessToken(env, connection);
        await setupGoogleCalendarWatch(env, connection, accessToken);
        console.log(`Renewed Google Calendar watch for connection ${connection.id}`);
      } catch (err) {
        console.error(`Failed to renew watch for connection ${connection.id}:`, err);
      }
    }
  } catch (err) {
    console.error('Failed to renew Google Calendar watches:', err);
  }
}

async function cleanupExpired(env) {
  await env.DB.prepare(
    `DELETE FROM sessions
     WHERE ${sqlUnixEpoch('expires_at')} < ${sqlUnixEpoch("'now'")}`
  ).run();
  await env.DB.prepare(
    `DELETE FROM api_keys
     WHERE expires_at IS NOT NULL
     AND ${sqlUnixEpoch('expires_at')} < ${sqlUnixEpoch("'now'")}`
  ).run();
}

// A pending_payment booking holds its slot (it's in
// SLOT_HOLDING_BOOKING_STATUSES_SQL), so without an expiry an abandoned
// checkout blocks the slot forever — and anyone could lock up a paid event
// type for free by starting checkouts. 60 minutes comfortably exceeds the
// ~30-minute Stripe Checkout session lifetime set in createCheckoutSession,
// so a payment can no longer complete once its booking has expired.
const PENDING_PAYMENT_MAX_AGE_MINUTES = 60;

async function expireStalePendingPayments(env) {
  const cutoff = formatDbTimestamp(Date.now() - PENDING_PAYMENT_MAX_AGE_MINUTES * 60 * 1000);
  await env.DB.prepare(
    `UPDATE bookings SET status = 'expired', updated_at = datetime('now')
     WHERE status = 'pending_payment'
     AND ${sqlUnixEpoch('created_at')} < ${sqlUnixEpoch('?')}`
  ).bind(cutoff).run();
  await env.DB.prepare(
    `UPDATE payments SET status = 'expired'
     WHERE status = 'pending'
     AND booking_id IN (SELECT id FROM bookings WHERE status = 'expired')`
  ).run();
}

// ============================================================
// Auth Middleware
// ============================================================

async function authenticate(request, env) {
  // Check session cookie
  const cookie = request.headers.get('Cookie') || '';
  const sessionMatch = cookie.match(/session=([^;]+)/);

  // Check API key
  const apiKey = request.headers.get('X-API-Key');

  if (sessionMatch) {
    const token = sessionMatch[1];
    const session = await env.DB.prepare(
      `SELECT s.user_id, u.* FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ?
       AND ${sqlUnixEpoch('s.expires_at')} > ${sqlUnixEpoch("'now'")}`
    ).bind(token).first();
    return session || null;
  }

  if (apiKey) {
    // Hash the API key and look up
    const keyHash = await hashString(apiKey);
    const result = await env.DB.prepare(
      `SELECT u.* FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = ?
       AND (ak.expires_at IS NULL OR ${sqlUnixEpoch('ak.expires_at')} > ${sqlUnixEpoch("'now'")})`
    ).bind(keyHash).first();
    if (result) {
      await env.DB.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE key_hash = ?').bind(keyHash).run();
    }
    return result || null;
  }

  return null;
}

/**
 * Check if user has a specific team permission for an org.
 * Org owners and admins have all permissions.
 * Members need specific permission flags.
 */
async function checkTeamPermission(env, userId, orgId, permission) {
  const member = await env.DB.prepare(
    'SELECT * FROM org_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, userId).first();
  if (!member) return false;
  if (member.role === 'owner' || member.role === 'admin') return true;
  if (permission === 'edit_event_types') return !!member.can_edit_event_types;
  if (permission === 'manage_bookings') return !!member.can_manage_bookings;
  if (permission === 'view_analytics') return !!member.can_view_analytics;
  return false;
}

// ============================================================
// Utility Functions
// ============================================================

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    // API responses are dynamic per-user/per-request and must never be cached by
    // the browser or an intermediary. Caching availability in particular is a
    // correctness bug: a stale "free" response risks a double-booking, and a
    // stale "busy" response leaves slots blocked after a calendar event is
    // deleted (observed in RETEST CU-04 Step 5).
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// SINGLE SOURCE OF TRUTH for public booking URLs. Everything that needs to show
// or tell a user their booking URL (the AI context, AI tools, embeds, emails)
// must use these — never hand-build the URL inline. That's how the AI drifted
// out of date: the live context hardcoded the old `/booking/?user=` format after
// the product moved to clean `/<slug>` short links. Change the format here once
// and it updates everywhere, including what the AI tells users.
export function bookingPageUrl(origin, slug) {
  return `${origin}/${slug}`;
}
export function eventTypeBookingUrl(origin, slug, eventSlug) {
  return `${origin}/${slug}/${eventSlug}`;
}

function formatDbTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 19) + 'Z';
}

// Shift a YYYY-MM-DD date string by whole days (UTC-safe, no DST pitfalls).
function padDateStr(dateStr, offsetDays) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function parseStoredUtcDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (!value) return new Date(NaN);

  let normalized = String(value).trim();
  if (normalized.includes(' ') && !normalized.includes('T')) {
    normalized = normalized.replace(' ', 'T');
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    normalized += 'Z';
  }

  return new Date(normalized);
}

function sqlUnixEpoch(expr) {
  return `strftime('%s', ${expr})`;
}

function corsResponse(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request)
  });
}

function addCorsHeaders(response, request) {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

function corsHeaders(request) {
  // Public endpoints stay callable cross-origin (embeds, API-key clients) via
  // "*" WITHOUT credentials. Reflecting an arbitrary Origin together with
  // Allow-Credentials:true would let any website make cookie-authenticated
  // requests to the API — credentials are only allowed when the Origin is
  // this deployment itself (e.g. www vs apex host of the same zone).
  const origin = request?.headers?.get('Origin');
  let allowOrigin = '*';
  let allowCredentials = 'false';
  if (origin && request?.url) {
    try {
      const requestHost = new URL(request.url).host;
      const originHost = new URL(origin).host;
      const sameSite = originHost === requestHost ||
        originHost === `www.${requestHost}` ||
        requestHost === `www.${originHost}`;
      if (sameSite) {
        allowOrigin = origin;
        allowCredentials = 'true';
      }
    } catch {}
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Credentials': allowCredentials,
    'Access-Control-Max-Age': '86400'
  };
}

async function hashString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// Password Hashing (PBKDF2 via Web Crypto API)
// ============================================================

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArray = Array.from(new Uint8Array(derivedBits));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:100000:${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1]);
  const saltHex = parts[2];
  const expectedHash = parts[3];

  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === expectedHash;
}

// ============================================================
// Session Management
// ============================================================

async function createSession(env, userId) {
  const token = crypto.randomUUID();
  const id = crypto.randomUUID();
  const expiresAt = formatDbTimestamp(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(id, userId, token, expiresAt).run();

  return { token, expires_at: expiresAt };
}

function isInsecureLocalRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.protocol === 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function sessionCookie(token, expiresAt, request) {
  const expires = new Date(expiresAt).toUTCString();
  const secureFlag = request && isInsecureLocalRequest(request) ? '' : ' Secure;';
  return `session=${token}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Expires=${expires}`;
}

function clearSessionCookie(request) {
  const secureFlag = request && isInsecureLocalRequest(request) ? '' : ' Secure;';
  return `session=; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0`;
}

// ============================================================
// Slug Generation
// ============================================================

function formatPhoneNumber(phone) {
  if (!phone) return phone;
  // Strip everything except digits and leading +
  const hasPlus = phone.startsWith('+');
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    // US number without country code: 5551234567 → +1 (555) 123-4567
    return `+1 (${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    // US number with country code: 15551234567 → +1 (555) 123-4567
    return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  }
  // International or other format — just add + prefix and keep digits
  return hasPlus ? `+${digits}` : `+${digits}`;
}

function validateCustomQuestions(questions) {
  if (!Array.isArray(questions)) return null;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.condition) {
      const cond = q.condition;
      // Validate condition structure: must have show_when with question_index and answer
      if (!cond.show_when || typeof cond.show_when !== 'object') {
        return `Question ${i + 1}: condition must have a "show_when" object`;
      }
      const sw = cond.show_when;
      if (typeof sw.question_index !== 'number' || !Number.isInteger(sw.question_index)) {
        return `Question ${i + 1}: condition.show_when.question_index must be an integer`;
      }
      if (sw.question_index < 0 || sw.question_index >= i) {
        return `Question ${i + 1}: condition references non-existent or later question (index ${sw.question_index})`;
      }
      if (sw.answer === undefined || sw.answer === null || (typeof sw.answer === 'string' && sw.answer.trim() === '')) {
        return `Question ${i + 1}: condition.show_when.answer is required`;
      }
    }
  }
  return null;
}

function generateSlug(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlug(env, slug) {
  const base = slug || 'user';
  let candidate = base;
  let counter = 1;
  while (true) {
    const existing = await env.DB.prepare('SELECT id FROM booking_pages WHERE slug = ?').bind(candidate).first();
    // Treat reserved words as "taken" so an auto-generated slug like "admin"
    // never becomes an un-routable booking page.
    if (!existing && !isReservedSlug(candidate)) return candidate;
    candidate = `${base}-${counter}`;
    counter++;
  }
}

// ============================================================
// New User Setup (booking page + availability + default event type)
// ============================================================

async function setupNewUserDefaults(env, userId, name) {
  const slug = generateSlug(name);
  const uniqueSlug = await ensureUniqueSlug(env, slug);
  await env.DB.prepare(
    'INSERT INTO booking_pages (user_id, slug, display_name) VALUES (?, ?, ?)'
  ).bind(userId, uniqueSlug, name.trim()).run();

  const defaultRules = JSON.stringify([
    { day: 1, start: '09:00', end: '17:00' },
    { day: 2, start: '09:00', end: '17:00' },
    { day: 3, start: '09:00', end: '17:00' },
    { day: 4, start: '09:00', end: '17:00' },
    { day: 5, start: '09:00', end: '17:00' },
  ]);
  await env.DB.prepare(
    'INSERT INTO availability_schedules (user_id, name, timezone, rules, is_default) VALUES (?, ?, ?, ?, 1)'
  ).bind(userId, 'Working Hours', 'America/Los_Angeles', defaultRules).run();

  const defaultSchedule = await env.DB.prepare(
    'SELECT id FROM availability_schedules WHERE user_id = ? AND is_default = 1'
  ).bind(userId).first();

  const schedId = defaultSchedule?.id || null;
  const eventTypes = [
    { name: '15 Minute Chat', slug: '15-minute-chat', desc: 'A quick 15-minute chat', duration: 15, color: '#10b981' },
    { name: '30 Minute Meeting', slug: '30-minute-meeting', desc: 'A standard 30-minute meeting', duration: 30, color: '#2563eb' },
    { name: '45 Minute Meeting', slug: '45-minute-meeting', desc: 'A 45-minute meeting', duration: 45, color: '#f59e0b' },
    { name: '60 Minute Deep Dive', slug: '60-minute-deep-dive', desc: 'An in-depth 60-minute session', duration: 60, color: '#7c3aed' },
  ];
  for (const et of eventTypes) {
    const slotInterval = et.duration > 15 ? 30 : 15;
    await env.DB.prepare(
      `INSERT INTO event_types (user_id, name, slug, description, duration_minutes, color, location_type, availability_schedule_id, min_notice_hours, max_future_days, slot_interval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, et.name, et.slug, et.desc, et.duration, et.color, 'google_meet', schedId, 4, 60, slotInterval).run();
  }

  return uniqueSlug;
}

// ============================================================
// OAuth State (CSRF protection)
// ============================================================

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getOAuthStateSecretBytes(env) {
  if (env.OAUTH_STATE_SECRET) {
    return new TextEncoder().encode(env.OAUTH_STATE_SECRET);
  }

  if (env.ENCRYPTION_KEY) {
    try {
      return Uint8Array.from(atob(env.ENCRYPTION_KEY), c => c.charCodeAt(0));
    } catch {
      // Fall through to the default secret if ENCRYPTION_KEY is malformed.
    }
  }

  return new TextEncoder().encode('calendo-oauth-state-secret');
}

async function signOAuthState(env, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    getOAuthStateSecretBytes(env),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function generateOAuthState(env, payload) {
  const nonce = crypto.randomUUID();
  const ts = Date.now().toString();
  const data = `${payload}:${nonce}:${ts}`;
  const sig = await signOAuthState(env, data);
  return `${data}:${sig}`;
}

async function verifyOAuthState(env, state) {
  if (!state) return null;

  const parts = state.split(':');
  if (parts.length !== 4) return null;

  const [payload, nonce, tsRaw, sig] = parts;
  if (!payload || !nonce || !tsRaw || !sig) return null;

  const ts = parseInt(tsRaw, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000) {
    return null;
  }

  const data = `${payload}:${nonce}:${tsRaw}`;
  const expectedSig = await signOAuthState(env, data);
  if (!timingSafeEqual(sig, expectedSig)) {
    return null;
  }

  return payload;
}

// ============================================================
// Routing Form Handlers (Authenticated)
// ============================================================

async function handleListRoutingForms(request, env, user) {
  const result = await env.DB.prepare(
    'SELECT * FROM routing_forms WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return jsonResponse(result.results);
}

async function handleCreateRoutingForm(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name, slug: rawSlug, fields, rules } = body;
  if (!name || !name.trim()) {
    return jsonResponse({ error: 'Name is required' }, 400);
  }

  const slug = generateSlug(rawSlug || name);
  if (!slug) return jsonResponse({ error: 'Invalid slug' }, 400);

  // Check slug uniqueness for this user
  const existingSlug = await env.DB.prepare(
    'SELECT id FROM routing_forms WHERE user_id = ? AND slug = ?'
  ).bind(user.id, slug).first();
  if (existingSlug) {
    return jsonResponse({ error: 'A routing form with this slug already exists' }, 409);
  }

  // Validate fields
  const parsedFields = Array.isArray(fields) ? fields : [];
  for (const field of parsedFields) {
    if (!field.id || !field.label || !field.type) {
      return jsonResponse({ error: 'Each field must have id, label, and type' }, 400);
    }
    if (!['text', 'select', 'radio'].includes(field.type)) {
      return jsonResponse({ error: 'Field type must be text, select, or radio' }, 400);
    }
    if ((field.type === 'select' || field.type === 'radio') && (!Array.isArray(field.options) || field.options.length === 0)) {
      return jsonResponse({ error: `Field "${field.label}" of type ${field.type} must have options` }, 400);
    }
  }

  // Validate rules
  const parsedRules = Array.isArray(rules) ? rules : [];
  for (const rule of parsedRules) {
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
      return jsonResponse({ error: 'Each rule must have at least one condition' }, 400);
    }
    if (!rule.target_event_type_id) {
      return jsonResponse({ error: 'Each rule must have a target_event_type_id' }, 400);
    }
    for (const cond of rule.conditions) {
      if (!cond.field_id || !cond.operator || cond.value === undefined) {
        return jsonResponse({ error: 'Each condition must have field_id, operator, and value' }, 400);
      }
      if (!['eq', 'contains'].includes(cond.operator)) {
        return jsonResponse({ error: 'Condition operator must be eq or contains' }, 400);
      }
    }
  }

  const result = await env.DB.prepare(
    'INSERT INTO routing_forms (user_id, name, slug, fields, rules) VALUES (?, ?, ?, ?, ?) RETURNING *'
  ).bind(
    user.id, name.trim(), slug,
    JSON.stringify(parsedFields),
    JSON.stringify(parsedRules)
  ).first();

  return jsonResponse(result, 201);
}

async function handleGetRoutingForm(request, env, user, path) {
  const id = path.split('/').pop();
  const result = await env.DB.prepare(
    'SELECT * FROM routing_forms WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!result) return jsonResponse({ error: 'Not found' }, 404);
  return jsonResponse(result);
}

async function handleUpdateRoutingForm(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT * FROM routing_forms WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  if (body.name !== undefined) fields.name = body.name.trim();
  if (body.slug !== undefined) {
    const newSlug = generateSlug(body.slug);
    const slugCheck = await env.DB.prepare(
      'SELECT id FROM routing_forms WHERE user_id = ? AND slug = ? AND id != ?'
    ).bind(user.id, newSlug, id).first();
    if (slugCheck) return jsonResponse({ error: 'Slug already in use' }, 409);
    fields.slug = newSlug;
  }
  if (body.fields !== undefined) fields.fields = JSON.stringify(body.fields);
  if (body.rules !== undefined) fields.rules = JSON.stringify(body.rules);
  if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0;

  if (Object.keys(fields).length === 0) return jsonResponse({ error: 'No fields to update' }, 400);

  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  const result = await env.DB.prepare(
    `UPDATE routing_forms SET ${setClauses} WHERE id = ? AND user_id = ? RETURNING *`
  ).bind(...values, id, user.id).first();

  return jsonResponse(result);
}

async function handleDeleteRoutingForm(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT id FROM routing_forms WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  await env.DB.prepare(
    'DELETE FROM routing_forms WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).run();

  return jsonResponse({ ok: true });
}

async function handleRoutingAnalytics(request, env, user) {
  // Get all routing forms for this user
  const forms = await env.DB.prepare(
    'SELECT id, name, slug FROM routing_forms WHERE user_id = ?'
  ).bind(user.id).all();

  const analytics = [];
  for (const form of (forms.results || [])) {
    const totalSubs = await env.DB.prepare(
      'SELECT COUNT(*) as total FROM routing_form_submissions WHERE routing_form_id = ?'
    ).bind(form.id).first();

    const converted = await env.DB.prepare(
      'SELECT COUNT(*) as total FROM routing_form_submissions WHERE routing_form_id = ? AND booking_id IS NOT NULL'
    ).bind(form.id).first();

    const byEventType = await env.DB.prepare(
      `SELECT et.name, COUNT(*) as submissions
       FROM routing_form_submissions rfs
       JOIN event_types et ON rfs.routed_to_event_type_id = et.id
       WHERE rfs.routing_form_id = ?
       GROUP BY et.id ORDER BY submissions DESC`
    ).bind(form.id).all();

    analytics.push({
      form_id: form.id,
      form_name: form.name,
      form_slug: form.slug,
      total_submissions: totalSubs?.total || 0,
      conversions: converted?.total || 0,
      conversion_rate: totalSubs?.total > 0 ? Math.round((converted?.total || 0) / totalSubs.total * 100) : 0,
      by_event_type: byEventType.results || [],
    });
  }

  return jsonResponse({ data: analytics });
}

// ============================================================
// Contacts Handler
// ============================================================

async function handleListContacts(request, env, user) {
  const result = await env.DB.prepare(`
    SELECT
      invitee_name,
      invitee_email,
      invitee_phone,
      COUNT(*) as booking_count,
      MIN(b.created_at) as first_booking,
      MAX(CASE WHEN start_time <= datetime('now') THEN start_time END) as last_meeting,
      MIN(CASE WHEN start_time > datetime('now') AND status IN ('confirmed','pending') THEN start_time END) as next_meeting
    FROM bookings b
    JOIN event_types et ON b.event_type_id = et.id
    WHERE et.user_id = ?
    GROUP BY invitee_email
    ORDER BY last_meeting DESC
  `).bind(user.id).all();

  return jsonResponse(result.results);
}

// ============================================================
// Public Routing Form Handlers
// ============================================================

async function handleGetPublicRoutingForm(request, env, path) {
  // Path: /api/public/routing/USER_SLUG/FORM_SLUG
  const segments = path.replace('/api/public/routing/', '').split('/');
  if (segments.length < 2) {
    return jsonResponse({ error: 'Invalid path' }, 400);
  }
  const userSlug = segments[0];
  const formSlug = segments[1];

  // Look up user by booking page slug
  const page = await env.DB.prepare(
    'SELECT user_id FROM booking_pages WHERE slug = ?'
  ).bind(userSlug).first();
  if (!page) return jsonResponse({ error: 'User not found' }, 404);

  // Look up routing form
  const form = await env.DB.prepare(
    'SELECT * FROM routing_forms WHERE user_id = ? AND slug = ? AND is_active = 1'
  ).bind(page.user_id, formSlug).first();
  if (!form) return jsonResponse({ error: 'Form not found' }, 404);

  // Get event types for context
  const eventTypes = await env.DB.prepare(
    'SELECT id, name, slug, description, duration_minutes FROM event_types WHERE user_id = ? AND is_active = 1'
  ).bind(page.user_id).all();

  return jsonResponse({
    form: {
      id: form.id,
      name: form.name,
      slug: form.slug,
      fields: form.fields,
    },
    event_types: eventTypes.results,
    user_slug: userSlug,
  });
}

async function handleSubmitRoutingForm(request, env, path) {
  // Path: /api/public/routing/USER_SLUG/FORM_SLUG
  const segments = path.replace('/api/public/routing/', '').split('/');
  if (segments.length < 2) {
    return jsonResponse({ error: 'Invalid path' }, 400);
  }
  const userSlug = segments[0];
  const formSlug = segments[1];

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { answers } = body;
  if (!answers || typeof answers !== 'object') {
    return jsonResponse({ error: 'answers object is required' }, 400);
  }

  // Look up user
  const page = await env.DB.prepare(
    'SELECT user_id FROM booking_pages WHERE slug = ?'
  ).bind(userSlug).first();
  if (!page) return jsonResponse({ error: 'User not found' }, 404);

  // Look up routing form
  const form = await env.DB.prepare(
    'SELECT * FROM routing_forms WHERE user_id = ? AND slug = ? AND is_active = 1'
  ).bind(page.user_id, formSlug).first();
  if (!form) return jsonResponse({ error: 'Form not found' }, 404);

  let rules;
  try {
    rules = typeof form.rules === 'string' ? JSON.parse(form.rules) : form.rules;
  } catch {
    rules = [];
  }

  // Evaluate rules in order - first match wins
  let matchedEventTypeId = null;
  for (const rule of rules) {
    const allConditionsMet = rule.conditions.every(cond => {
      const answerValue = answers[cond.field_id] || '';
      if (cond.operator === 'eq') {
        return answerValue.toLowerCase() === String(cond.value).toLowerCase();
      } else if (cond.operator === 'contains') {
        return answerValue.toLowerCase().includes(String(cond.value).toLowerCase());
      }
      return false;
    });

    if (allConditionsMet) {
      matchedEventTypeId = rule.target_event_type_id;
      break;
    }
  }

  if (!matchedEventTypeId) {
    return jsonResponse({
      error: 'No matching event type found for your answers',
      message: 'No matching event type found for your answers',
    }, 404);
  }

  // Look up the matched event type
  const eventType = await env.DB.prepare(
    'SELECT id, name, slug FROM event_types WHERE id = ? AND user_id = ? AND is_active = 1'
  ).bind(matchedEventTypeId, page.user_id).first();

  if (!eventType) {
    return jsonResponse({
      error: 'Matched event type is no longer available',
      message: 'Matched event type is no longer available',
    }, 404);
  }

  // Build redirect URL to booking page
  const origin = getRequestOrigin(request);
  const redirectUrl = `${origin}/${encodeURIComponent(userSlug)}/${encodeURIComponent(eventType.slug)}`;

  // Log submission for analytics
  try {
    await env.DB.prepare(
      'INSERT INTO routing_form_submissions (routing_form_id, answers, routed_to_event_type_id) VALUES (?, ?, ?)'
    ).bind(form.id, JSON.stringify(answers), eventType.id).run();
  } catch (err) { console.error('Failed to log routing form submission:', err); }

  return jsonResponse({
    matched_event_type: {
      id: eventType.id,
      name: eventType.name,
      slug: eventType.slug,
    },
    redirect_url: redirectUrl,
  });
}

// ============================================================
// Analytics Handler
// ============================================================

async function handleAnalytics(request, env, user) {
  // Scope: own event types + org event types where user is a member
  const userScope = `(et.user_id = ? OR et.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?))`;
  const scopeArgs = [user.id, user.id];

  const totalResult = await env.DB.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
            SUM(CASE WHEN status IN ('confirmed', 'pending') THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope}`
  ).bind(...scopeArgs).first();

  const now = new Date();
  const thisMonthStart = formatDbTimestamp(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)));
  const thisMonthResult = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope}
     AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}`
  ).bind(...scopeArgs, thisMonthStart).first();

  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = formatDbTimestamp(new Date(Date.UTC(lastMonth.getFullYear(), lastMonth.getMonth(), 1)));
  const lastMonthEnd = thisMonthStart;
  const lastMonthResult = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope}
     AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('b.created_at')} < ${sqlUnixEpoch('?')}`
  ).bind(...scopeArgs, lastMonthStart, lastMonthEnd).first();

  const total = totalResult?.total || 0;
  const cancelled = totalResult?.cancelled || 0;
  const noShow = totalResult?.no_show || 0;
  const cancellationRate = total > 0 ? Math.round((cancelled / total) * 100) : 0;
  const noShowRate = total > 0 ? Math.round((noShow / total) * 100) : 0;

  const byEventType = await env.DB.prepare(
    `SELECT et.name, et.color, COUNT(*) as bookings,
            SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
            SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) as no_shows
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope}
     GROUP BY et.id
     ORDER BY bookings DESC`
  ).bind(...scopeArgs).all();

  const byDayOfWeek = await env.DB.prepare(
    `SELECT CAST(strftime('%w', b.start_time) AS INTEGER) as day_of_week, COUNT(*) as count
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope} AND b.status IN ('confirmed', 'pending')
     GROUP BY day_of_week
     ORDER BY day_of_week`
  ).bind(...scopeArgs).all();

  const byHour = await env.DB.prepare(
    `SELECT CAST(strftime('%H', b.start_time) AS INTEGER) as hour, COUNT(*) as count
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope} AND b.status IN ('confirmed', 'pending')
     GROUP BY hour
     ORDER BY hour`
  ).bind(...scopeArgs).all();

  const thirtyDaysAgo = formatDbTimestamp(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dailyVolume = await env.DB.prepare(
    `SELECT DATE(b.created_at) as date, COUNT(*) as count
     FROM bookings b
     JOIN event_types et ON b.event_type_id = et.id
     WHERE ${userScope}
     AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}
     GROUP BY date
     ORDER BY date`
  ).bind(...scopeArgs, thirtyDaysAgo).all();

  const mostPopular = byEventType.results && byEventType.results.length > 0
    ? byEventType.results[0].name : null;

  return jsonResponse({
    total_bookings: total,
    this_month: thisMonthResult?.count || 0,
    last_month: lastMonthResult?.count || 0,
    cancellation_rate: cancellationRate,
    no_show_count: noShow,
    no_show_rate: noShowRate,
    most_popular_event_type: mostPopular,
    by_event_type: byEventType.results || [],
    by_day_of_week: byDayOfWeek.results || [],
    by_hour: byHour.results || [],
    daily_volume: dailyVolume.results || [],
  });
}

async function handleAnalyticsExport(request, env, user, url) {
  const format = url.searchParams.get('format') || 'csv';
  const range = url.searchParams.get('range') || 'all'; // 'all', '30d', '90d', '1y'

  let dateFilter = '';
  let dateArg = null;
  if (range === '30d') { dateArg = formatDbTimestamp(Date.now() - 30 * 86400000); dateFilter = `AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}`; }
  else if (range === '90d') { dateArg = formatDbTimestamp(Date.now() - 90 * 86400000); dateFilter = `AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}`; }
  else if (range === '1y') { dateArg = formatDbTimestamp(Date.now() - 365 * 86400000); dateFilter = `AND ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}`; }

  const query = `SELECT b.id, b.uid, et.name as event_type, b.invitee_name, b.invitee_email, b.invitee_phone,
    b.start_time, b.end_time, b.status, b.invitee_timezone, b.location, b.created_at, b.notes, b.cancelled_at, b.cancelled_by, b.cancellation_reason
    FROM bookings b JOIN event_types et ON b.event_type_id = et.id
    WHERE et.user_id = ? ${dateFilter}
    ORDER BY b.start_time DESC`;

  const stmt = dateArg
    ? env.DB.prepare(query).bind(user.id, dateArg)
    : env.DB.prepare(query).bind(user.id);
  const results = await stmt.all();
  const rows = results.results || [];

  if (format === 'csv') {
    const headers = ['ID', 'Event Type', 'Invitee Name', 'Invitee Email', 'Phone', 'Start Time', 'End Time', 'Status', 'Timezone', 'Location', 'Notes', 'Created At', 'Cancelled At', 'Cancelled By', 'Cancellation Reason'];

    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const csvLines = [headers.join(',')];
    for (const r of rows) {
      csvLines.push([r.id, r.event_type, r.invitee_name, r.invitee_email, r.invitee_phone, r.start_time, r.end_time, r.status, r.invitee_timezone, r.location, r.notes, r.created_at, r.cancelled_at, r.cancelled_by, r.cancellation_reason].map(csvEscape).join(','));
    }

    return new Response(csvLines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="calendo-bookings-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // JSON export
  return jsonResponse({ bookings: rows });
}

async function handleCalendarView(request, env, user, url) {
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  if (!start || !end) return jsonResponse({ error: 'start and end required (YYYY-MM-DD)' }, 400);

  const startISO = start + 'T00:00:00Z';
  const endISO = end + 'T23:59:59Z';

  // Get Calendo bookings
  const bookingsResult = await env.DB.prepare(
    `SELECT b.id, b.start_time, b.end_time, b.invitee_name, b.invitee_email, b.status, b.location,
            et.name as event_type_name, et.color, et.duration_minutes, et.location_type
     FROM bookings b JOIN event_types et ON b.event_type_id = et.id
     WHERE (et.user_id = ? OR b.assigned_user_id = ? OR et.org_id IN (SELECT org_id FROM org_members WHERE user_id = ?))
     AND b.status IN ('confirmed', 'pending')
     AND ${sqlUnixEpoch('b.start_time')} >= ${sqlUnixEpoch('?')}
     AND ${sqlUnixEpoch('b.start_time')} <= ${sqlUnixEpoch('?')}
     ORDER BY b.start_time`
  ).bind(user.id, user.id, user.id, startISO, endISO).all();

  const events = (bookingsResult.results || []).map(b => ({
    id: b.id,
    title: `${b.event_type_name} with ${b.invitee_name}`,
    start: b.start_time,
    end: b.end_time,
    color: b.color || '#2563eb',
    source: 'calendo',
    status: b.status,
    location: b.location || null,
    invitee_name: b.invitee_name,
    invitee_email: b.invitee_email,
    event_type_name: b.event_type_name,
    location_type: b.location_type,
  }));

  // Dedup: normalize start times to epoch ms so "2026-04-20T18:00:00Z" matches "2026-04-20T11:00:00-07:00"
  const calendoEpochs = new Set(events.map(e => new Date(e.start).getTime()));
  const googleEvents = await getGoogleCalendarEvents(env, user.id, startISO, endISO);
  for (const ge of googleEvents) {
    if (!calendoEpochs.has(new Date(ge.start).getTime())) events.push(ge);
  }

  const outlookEvents = await getOutlookCalendarEvents(env, user.id, startISO, endISO);
  for (const oe of outlookEvents) {
    if (!calendoEpochs.has(new Date(oe.start).getTime())) events.push(oe);
  }

  events.sort((a, b) => a.start.localeCompare(b.start));

  // Surface recent sync errors so the dashboard can warn the user
  const recentErrors = await env.DB.prepare(
    `SELECT provider, error_type, error_message, created_at FROM calendar_sync_errors
     WHERE user_id = ? AND created_at > datetime('now', '-1 hour') ORDER BY created_at DESC LIMIT 5`
  ).bind(user.id).all().catch(() => ({ results: [] }));

  return jsonResponse({ events, sync_errors: recentErrors.results || [] });
}

// ============================================================
// Meeting Polls Handlers
// ============================================================

async function handleCreatePoll(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { title, description, deadline, options } = body;
  if (!title || !title.trim()) return jsonResponse({ error: 'Title is required' }, 400);
  if (!options || !Array.isArray(options) || options.length === 0) {
    return jsonResponse({ error: 'At least one option is required' }, 400);
  }

  for (const opt of options) {
    if (!opt.date || !opt.start_time || !opt.end_time) {
      return jsonResponse({ error: 'Each option must have date, start_time, and end_time' }, 400);
    }
  }

  const poll = await env.DB.prepare(
    'INSERT INTO meeting_polls (user_id, title, description, deadline) VALUES (?, ?, ?, ?) RETURNING *'
  ).bind(user.id, title.trim(), description || null, deadline || null).first();

  for (const opt of options) {
    await env.DB.prepare(
      'INSERT INTO poll_options (poll_id, date, start_time, end_time) VALUES (?, ?, ?, ?)'
    ).bind(poll.id, opt.date, opt.start_time, opt.end_time).run();
  }

  const createdOptions = await env.DB.prepare(
    'SELECT * FROM poll_options WHERE poll_id = ?'
  ).bind(poll.id).all();

  return jsonResponse({ ...poll, options: createdOptions.results }, 201);
}

async function handleListPolls(request, env, user) {
  const polls = await env.DB.prepare(
    'SELECT * FROM meeting_polls WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();

  const result = [];
  for (const poll of polls.results) {
    const voteCount = await env.DB.prepare(
      "SELECT COUNT(DISTINCT voter_email) as voters FROM poll_votes WHERE poll_id = ?"
    ).bind(poll.id).first();
    result.push({ ...poll, voter_count: voteCount?.voters || 0 });
  }

  return jsonResponse(result);
}

async function handleGetPublicPoll(request, env, path) {
  const id = path.split('/').pop();

  const poll = await env.DB.prepare(
    `SELECT mp.*, u.name as creator_name
     FROM meeting_polls mp
     JOIN users u ON mp.user_id = u.id
     WHERE mp.id = ?`
  ).bind(id).first();

  if (!poll) return jsonResponse({ error: 'Poll not found' }, 404);

  const options = await env.DB.prepare(
    'SELECT * FROM poll_options WHERE poll_id = ? ORDER BY date, start_time'
  ).bind(id).all();

  const votes = await env.DB.prepare(
    'SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY created_at'
  ).bind(id).all();

  // This endpoint is public (anyone with the poll URL), so voter emails must
  // never leave the server. Each voter gets an opaque per-response key instead;
  // the page only needs it to line votes up with voter columns.
  const voterKeyByEmail = new Map();
  const voters = [];
  const votesByOption = {};
  for (const vote of votes.results) {
    if (!voterKeyByEmail.has(vote.voter_email)) {
      const key = 'v' + voterKeyByEmail.size;
      voterKeyByEmail.set(vote.voter_email, key);
      voters.push({ key, name: vote.voter_name });
    }
    if (!votesByOption[vote.option_id]) votesByOption[vote.option_id] = [];
    votesByOption[vote.option_id].push({
      voter_key: voterKeyByEmail.get(vote.voter_email),
      voter_name: vote.voter_name,
      vote: vote.vote,
    });
  }

  const optionsWithVotes = options.results.map(opt => {
    const optVotes = votesByOption[opt.id] || [];
    return {
      ...opt,
      yes_count: optVotes.filter(v => v.vote === 'yes').length,
      maybe_count: optVotes.filter(v => v.vote === 'maybe').length,
      no_count: optVotes.filter(v => v.vote === 'no').length,
      votes: optVotes,
    };
  });

  let bestOption = null;
  const totalVotes = votes.results.length;
  if (optionsWithVotes.length > 0 && totalVotes > 0) {
    bestOption = optionsWithVotes.reduce((best, opt) => {
      if (!best) return opt;
      if (opt.yes_count > best.yes_count) return opt;
      if (opt.yes_count === best.yes_count && opt.no_count < best.no_count) return opt;
      return best;
    }, null);
  }

  return jsonResponse({
    id: poll.id,
    user_id: poll.user_id, // lets the host's own browser show the Finalize button
    title: poll.title,
    description: poll.description,
    status: poll.status,
    deadline: poll.deadline,
    finalized_option_id: poll.finalized_option_id,
    creator_name: poll.creator_name,
    created_at: poll.created_at,
    options: optionsWithVotes,
    voters,
    best_option_id: bestOption?.id || null,
  });
}

async function handlePollVote(request, env, path) {
  const segments = path.split('/');
  const pollId = segments[segments.length - 2];

  const poll = await env.DB.prepare(
    'SELECT * FROM meeting_polls WHERE id = ?'
  ).bind(pollId).first();

  if (!poll) return jsonResponse({ error: 'Poll not found' }, 404);
  if (poll.status !== 'open') {
    return jsonResponse({ error: 'This poll is no longer accepting votes' }, 400);
  }

  if (poll.deadline) {
    const deadline = new Date(poll.deadline);
    if (new Date() > deadline) {
      return jsonResponse({ error: 'Voting deadline has passed' }, 400);
    }
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { name, email, votes } = body;
  if (!name || !name.trim()) return jsonResponse({ error: 'Name is required' }, 400);
  if (!email || !email.trim()) return jsonResponse({ error: 'Email is required' }, 400);
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'Invalid email format' }, 400);
  }
  if (!votes || !Array.isArray(votes) || votes.length === 0) {
    return jsonResponse({ error: 'Votes array is required' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  await env.DB.prepare(
    'DELETE FROM poll_votes WHERE poll_id = ? AND voter_email = ?'
  ).bind(pollId, normalizedEmail).run();

  for (const v of votes) {
    if (!v.option_id) continue;
    const vote = ['yes', 'maybe', 'no'].includes(v.vote) ? v.vote : 'yes';
    await env.DB.prepare(
      'INSERT INTO poll_votes (poll_id, option_id, voter_name, voter_email, vote) VALUES (?, ?, ?, ?, ?)'
    ).bind(pollId, v.option_id, name.trim(), normalizedEmail, vote).run();
  }

  return jsonResponse({ ok: true, message: 'Votes recorded' });
}

async function handleFinalizePoll(request, env, user, path) {
  const segments = path.split('/');
  const pollId = segments[3];

  const poll = await env.DB.prepare(
    'SELECT * FROM meeting_polls WHERE id = ? AND user_id = ?'
  ).bind(pollId, user.id).first();

  if (!poll) return jsonResponse({ error: 'Poll not found' }, 404);
  if (poll.status === 'finalized') {
    return jsonResponse({ error: 'Poll has already been finalized' }, 400);
  }

  const body = await request.json().catch(() => ({}));
  let option_id = body && body.option_id;

  if (!option_id) {
    // No explicit option: auto-pick the most-voted option (most "yes", then
    // "yes"+"maybe"). Lets the dashboard "Finalize" button work without the host
    // pre-selecting an option, matching its "Best option selected" message.
    const best = await env.DB.prepare(
      `SELECT po.id AS id,
              SUM(CASE WHEN pv.vote = 'yes' THEN 1 ELSE 0 END) AS yes_votes,
              SUM(CASE WHEN pv.vote IN ('yes','maybe') THEN 1 ELSE 0 END) AS soft_votes
       FROM poll_options po
       LEFT JOIN poll_votes pv ON pv.option_id = po.id
       WHERE po.poll_id = ?
       GROUP BY po.id
       ORDER BY yes_votes DESC, soft_votes DESC, po.date, po.start_time
       LIMIT 1`
    ).bind(pollId).first();
    if (!best) return jsonResponse({ error: 'Poll has no options to finalize' }, 400);
    option_id = best.id;
  }

  const option = await env.DB.prepare(
    'SELECT * FROM poll_options WHERE id = ? AND poll_id = ?'
  ).bind(option_id, pollId).first();
  if (!option) return jsonResponse({ error: 'Option not found in this poll' }, 404);

  await env.DB.prepare(
    `UPDATE meeting_polls SET status = 'finalized', finalized_option_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(option_id, pollId).run();

  return jsonResponse({
    ok: true,
    message: 'Poll finalized',
    finalized_option: option,
  });
}

// ============================================================
// Dashboard AI Assistant
// ============================================================

const DASHBOARD_KNOWLEDGE_BASE = `
# Calendo — Product Knowledge Base

Calendo is a free scheduling platform (like Calendly) where AI is the key differentiator. Built by a solo indie developer with minimal overhead.

## Core Concepts

### Event Types (Meeting Types)
Event types are templates for bookable meetings. Each has:
- **Name** — e.g. "30 Minute Meeting", "Quick Chat"
- **Duration** — 15, 30, 45, 60, 90, or 120 minutes
- **Description** — optional, shown to invitees
- **Color** — for visual identification on the dashboard
- **Slug** — URL-friendly name, auto-generated from the name
- **Active/Inactive** — inactive event types are hidden from the booking page
- **Group events** — optional, allows multiple attendees per slot (max configurable)
- **Secret event types** — hidden from the public booking page; only accessible via direct link. Useful for VIP or invite-only meetings.
- **Redirect URL** — optional URL to redirect the invitee to after they complete a booking (e.g., a thank-you page or onboarding flow)
- **Allow guests** — controls whether invitees can add guest email addresses when booking. Default is true.

Users share a booking link for each event type. Invitees use these links to pick a time and book.

### Booking Page
Every user has a public booking page at a clean short-link URL: \`https://calendo.dev/YOUR-SLUG\`. (Always use the exact URL from the Current User Context or the get_booking_link tool — never invent a URL format.)
- **Slug** — unique URL identifier, editable in Settings
- **Display name** — shown on the booking page
- **Bio** — optional description
- **Brand color** — customizes the look of the booking page

Each event type also has its own direct link: \`https://calendo.dev/YOUR-SLUG/EVENT-SLUG\`

### Availability
Availability controls when invitees can book meetings:
- **Schedules** — named sets of weekly hours (e.g. "Working Hours", "Office Hours")
- **Weekly rules** — which days and time windows you're available (e.g. Mon-Fri 9am-5pm)
- **Date overrides** — block specific dates or set custom hours for exceptions
- **Timezone** — each schedule has a timezone setting
- **Default schedule** — one schedule is marked as default and used by event types unless overridden

### Bookings
When someone books a meeting:
- It appears in the Bookings tab with status "confirmed"
- The user can cancel bookings (one-time or all future for recurring)
- Bookings show invitee name, email, date/time, duration, and event type
- Filters: Upcoming, Past, Cancelled

### Connected Calendars
Users can connect external calendars to prevent double-bookings:
- **Google Calendar** — OAuth-based, checks for conflicts
- **Outlook / Office 365** — OAuth-based, checks for conflicts
- **Apple iCloud** — coming soon
When connected, Calendo checks these calendars when showing available slots.

### Video Conferencing
Event types can auto-generate a meeting link based on their location type:
- **Google Meet** — uses the user's connected Google Calendar
- **Zoom** — each user connects their OWN Zoom account (Settings → Connect Zoom); the meeting is created in their Zoom account. Zoom must be connected before "zoom" event types generate links.
- **Microsoft Teams** — uses the user's connected Outlook account
- Other location types: phone, in person, custom link, or none.

### Analytics
Dashboard analytics show:
- Total bookings, bookings this month, cancellation rate
- Most popular event type
- Daily booking volume chart (last 30 days)
- Event type breakdown
- Popular times heatmap

### Routing Forms
Forms that route invitees to the right event type based on their answers:
- Define fields (text, dropdown, radio)
- Define routing rules with conditions
- Invitees fill out the form and get routed to the appropriate meeting type

### Polls
Doodle-style meeting polls where:
- User proposes several time options
- Participants vote on which times work
- User finalizes the best option

### Team / Organization
- Create an organization
- Invite team members
- Assign roles (admin, member)

### Settings
Found in the Settings tab:
- **Profile**: display name, booking page slug, bio
- **Branding**: brand color, logo URL, hide "Powered by Calendo"
- **API Keys**: create and manage API keys for programmatic access
- **Danger Zone**: delete your account permanently

### Account Management
- **Delete account**: Go to Settings → scroll to Danger Zone → "Delete My Account". This permanently deletes all data and cannot be undone.
- **Sign out**: Click "Sign out" in the sidebar footer
- **Change name/slug**: Go to Settings, update the fields, click Save
- **Password reset**: If the user forgot their password, trigger a password reset email. The user will receive a link to set a new password. Works even from the AI chat.

### Embed Widgets
Users can embed their booking page on external websites using three modes:
- **Inline embed** — embeds the full booking calendar directly into a page
- **Popup button** — adds a "Book a Meeting" button that opens the booking page in a popup
- **Floating badge** — adds a floating badge widget to the page
The embed code can be retrieved via the AI assistant or from the dashboard Settings tab.

### Analytics Tracking
Users can add tracking to their booking pages:
- **Google Analytics** — set a GA4 measurement ID (e.g. "G-XXXXXXXXXX") to track booking page visits and conversions
- **Meta Pixel** — set a Meta (Facebook) Pixel ID to track booking conversions for ad optimization
- **UTM parameters** — booking page links support UTM parameters (?utm_source=...) for campaign tracking
These are configured in Settings under the Analytics / Tracking section, or via the manage_tracking tool.

### Conditional Questions
Event types support conditional booking questions:
- Define questions shown to invitees during booking (text, textarea, dropdown)
- Questions can be conditional — shown only when a previous answer matches a condition
- Questions are configured in the event type settings

### SMS Reminders
Booking reminders can be sent via SMS in addition to email:
- Configurable per event type (enable/disable 24h and 1h SMS reminders)
- Requires the invitee to provide a phone number when booking
- SMS delivery via Twilio integration

### QR Codes
Each event type and booking page has an auto-generated QR code:
- Scan to open the booking page directly
- Useful for print materials, business cards, and in-person sharing
- Available from the event type details or booking page settings

### Reconfirmation
Event types can require invitees to reconfirm their booking:
- **reconfirmation_hours** — set to 24, 48, or 72 to send a reconfirmation email that many hours before the meeting
- Invitees must click to confirm; if they don't, the host is notified
- Set to null to disable reconfirmation

### Slack Notifications
Users can connect a Slack workspace to receive booking notifications:
- Set a Slack incoming webhook URL in Settings
- Receive messages when meetings are booked, cancelled, or rescheduled
- Test the webhook to verify the connection works
- Manage via the manage_slack tool

### Email Verification
Users should verify their email address for security:
- A verification email is sent on signup
- Users can request a new verification email if the first expired
- Use the resend_verification tool to resend the verification email

### Team Pages
Organizations have a public team page showing all members and their event types:
- URL format: /team/?org=SLUG (where SLUG is the organization slug)
- Shows all team members with their booking links
- Displays shared org event types and personal event types
- Use the get_team_page_url tool to get the URL

### Audit Log
Every significant action is logged in the audit trail:
- Track who did what and when (event type changes, booking actions, settings updates)
- Filter by action type and date range
- Accessible from the Settings tab or via the get_audit_log tool

### PayPal Payments
In addition to Stripe, event types can accept PayPal payments:
- Configure PayPal credentials (client ID and secret) in Settings
- Set payment_method on event types to "stripe" or "paypal"
- Supports sandbox and live modes
- Manage via the manage_paypal tool

### Chrome Extension
A Chrome extension is available for quick scheduling:
- Open the scheduling popup from any webpage
- Quickly share booking links without navigating to the dashboard

### Pricing
Calendo's core scheduling features are free — not freemium, not a trial, just free. This is possible because one developer on modern infrastructure keeps costs extremely low.

Pro tier ($2/month) covers features that cost real money to deliver: AI assistant, SMS reminders, and remove branding. The AI assistant is available free for initial users to get started, but will be a paid feature as usage grows. The paid tier exists to cover operating costs, not to maximize profit.
`;

const DASHBOARD_TOOLS = [
  {
    name: 'get_event_types',
    description: 'Get the list of all event types (meeting types) for this user, including name, duration, color, active status, slug, description, is_secret, redirect_url, allow_guests, payment_method, and reconfirmation_hours.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_bookings',
    description: 'Get the user\'s bookings. Returns invitee name, email, date/time, duration, status, event type, and guest emails.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['upcoming', 'past', 'cancelled', 'all'], description: 'Filter bookings by status. Default: upcoming.' },
      },
      required: [],
    },
  },
  {
    name: 'get_availability',
    description: 'Get the user\'s availability schedules (weekly hours, timezone, date overrides).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_booking_link',
    description: 'Get the user\'s booking page URL, or a specific event type\'s direct booking URL.',
    input_schema: {
      type: 'object',
      properties: {
        event_type_id: { type: 'number', description: 'If provided, returns the direct link for this event type. Otherwise returns the main booking page URL.' },
      },
      required: [],
    },
  },
  {
    name: 'get_connected_calendars',
    description: 'List the user\'s connected calendar accounts (Google, Outlook).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_settings',
    description: 'Get the user\'s booking page settings (display name, slug, bio, brand color).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_analytics',
    description: 'Get booking analytics: total bookings, this month, cancellation rate, no-show rate, most popular event type.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_event_type',
    description: 'Create a new event type (meeting type). Execute immediately for the user.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the event type, e.g. "30 Minute Meeting"' },
        duration_minutes: { type: 'number', description: 'Duration in minutes — any whole number from 5 to 720 (e.g. 15, 20, 30, 45, 60, 90). Default 30.' },
        description: { type: 'string', description: 'Optional description shown to invitees' },
        color: { type: 'string', description: 'Hex color code, e.g. "#2563eb". Default: blue.' },
        availability_schedule_id: { type: 'number', description: 'ID of the availability schedule to use. If not provided, uses the default schedule.' },
        location_type: { type: 'string', enum: ['google_meet', 'zoom', 'teams', 'phone', 'in_person', 'custom', 'none'], description: 'Meeting location type. Default: google_meet. zoom auto-generates a Zoom link but requires the user to have connected their Zoom account (Settings → Connect Zoom).' },
        allow_guests: { type: 'boolean', description: 'Whether invitees can add guest email addresses when booking. Default: true.' },
        is_secret: { type: 'boolean', description: 'If true, the event type is hidden from the public booking page and only accessible via direct link. Default: false.' },
        redirect_url: { type: 'string', description: 'URL to redirect the invitee to after booking. Must be a valid http/https URL. Leave empty for no redirect.' },
        payment_method: { type: 'string', enum: ['stripe', 'paypal'], description: 'Payment processor to use for paid event types. Default: stripe.' },
        reconfirmation_hours: { type: 'number', enum: [24, 48, 72], description: 'Hours before the meeting to send a reconfirmation email to the invitee. Set to null to disable. Options: 24, 48, or 72.' },
      },
      required: ['name', 'duration_minutes'],
    },
  },
  {
    name: 'update_event_type',
    description: 'Update an existing event type. Can change name, slug (the URL), duration, description, color, active status, availability schedule, location type, buffers, min notice, max bookings per day, allow_guests, is_secret, redirect_url, payment_method, and reconfirmation_hours. Execute immediately. Note: the slug does NOT change automatically when you rename — pass slug explicitly to change the URL. To use zoom the user must have connected their Zoom account first.',
    input_schema: {
      type: 'object',
      properties: {
        event_type_id: { type: 'number', description: 'The ID of the event type to update' },
        name: { type: 'string' },
        slug: { type: 'string', description: 'The URL slug for this event type (lowercase letters, numbers, hyphens). Must be unique within the account. Changing it changes the public booking URL and breaks existing links.' },
        duration_minutes: { type: 'number' },
        description: { type: 'string' },
        color: { type: 'string' },
        is_active: { type: 'boolean', description: 'Set to true to activate or false to deactivate' },
        availability_schedule_id: { type: 'number', description: 'ID of the availability schedule to assign. Check get_availability to see available schedule IDs.' },
        location_type: { type: 'string', enum: ['google_meet', 'zoom', 'teams', 'phone', 'in_person', 'custom', 'none'], description: 'Meeting location type. google_meet auto-generates a Meet link, zoom auto-generates a Zoom link (requires the user to have connected Zoom), teams uses Microsoft Teams.' },
        buffer_before: { type: 'number', description: 'Minutes of buffer time before each meeting. Default 0.' },
        buffer_after: { type: 'number', description: 'Minutes of buffer time after each meeting. Default 0.' },
        min_notice_hours: { type: 'number', description: 'Minimum hours of advance notice required for booking. Default 4.' },
        max_bookings_per_day: { type: 'number', description: 'Maximum number of bookings allowed per day. Null or 0 means unlimited.' },
        allow_guests: { type: 'boolean', description: 'Whether invitees can add guest email addresses when booking. Default: true.' },
        is_secret: { type: 'boolean', description: 'If true, the event type is hidden from the public booking page and only accessible via direct link. Default: false.' },
        redirect_url: { type: 'string', description: 'URL to redirect the invitee to after booking. Must be a valid http/https URL. Pass empty string to clear.' },
        payment_method: { type: 'string', enum: ['stripe', 'paypal'], description: 'Payment processor to use for paid event types. Default: stripe.' },
        reconfirmation_hours: { type: 'number', description: 'Hours before the meeting to send a reconfirmation email. Set to null/0 to disable. Options: 24, 48, or 72.' },
      },
      required: ['event_type_id'],
    },
  },
  {
    name: 'delete_event_type',
    description: 'Delete an event type permanently. This is a HIGH-RISK action. Only call this AFTER the user has explicitly confirmed they want to delete it.',
    input_schema: {
      type: 'object',
      properties: {
        event_type_id: { type: 'number', description: 'The ID of the event type to delete' },
      },
      required: ['event_type_id'],
    },
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a booking. This is a HIGH-RISK action. Only call this AFTER the user has confirmed with the specific booking details.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'number', description: 'The ID of the booking to cancel' },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'mark_no_show',
    description: 'Mark a past booking as no-show. The invitee did not attend. Only works for past confirmed bookings, not cancelled ones.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'number', description: 'The ID of the booking to mark as no-show' },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'add_booking_notes',
    description: 'Add or update private internal notes on a booking. These notes are only visible to the host, not to the invitee. Execute immediately.',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'number', description: 'The ID of the booking to add notes to' },
        notes: { type: 'string', description: 'The notes text. Pass empty string to clear notes.' },
      },
      required: ['booking_id', 'notes'],
    },
  },
  {
    name: 'delete_account',
    description: 'Permanently delete the user\'s account and ALL data (event types, bookings, calendars, everything). This is the HIGHEST-RISK action. Only call this AFTER the user has explicitly confirmed they understand this is permanent and irreversible.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_availability_schedule',
    description: 'Create a new availability schedule with weekly hours. Execute immediately.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the schedule, e.g. "Weekend Hours", "Evening Slots"' },
        timezone: { type: 'string', description: 'Timezone, e.g. "America/Los_Angeles". Defaults to user timezone.' },
        rules: {
          type: 'array',
          description: 'Weekly availability rules. Each rule has day (0=Sun to 6=Sat), start ("HH:MM"), end ("HH:MM").',
          items: {
            type: 'object',
            properties: {
              day: { type: 'number', description: '0=Sunday, 1=Monday, ..., 6=Saturday' },
              start: { type: 'string', description: 'Start time in HH:MM format, e.g. "09:00"' },
              end: { type: 'string', description: 'End time in HH:MM format, e.g. "17:00"' },
            },
          },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_availability_schedule',
    description: 'Update an existing availability schedule\'s weekly hours. Execute immediately.',
    input_schema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'number', description: 'ID of the schedule to update' },
        name: { type: 'string', description: 'New name for the schedule' },
        rules: {
          type: 'array',
          description: 'New weekly rules. Replaces ALL existing rules.',
          items: {
            type: 'object',
            properties: {
              day: { type: 'number' },
              start: { type: 'string' },
              end: { type: 'string' },
            },
          },
        },
      },
      required: ['schedule_id'],
    },
  },
  {
    name: 'delete_availability_schedule',
    description: 'Delete an availability schedule. Cannot delete the default schedule. HIGH-RISK — confirm with user first.',
    input_schema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'number', description: 'ID of the schedule to delete' },
      },
      required: ['schedule_id'],
    },
  },
  {
    name: 'update_date_overrides',
    description: 'Add or remove a date-specific availability override on a schedule. Use to block a day off or set custom hours for a specific date. HIGH-RISK — modifies availability.',
    input_schema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'number', description: 'ID of the availability schedule' },
        action: { type: 'string', enum: ['add', 'remove'], description: '"add" to create an override, "remove" to delete an existing override for that date' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        available: { type: 'boolean', description: 'For "add": false to block the entire day, true (with start/end) for custom hours. Default: false.' },
        start: { type: 'string', description: 'Start time in HH:MM format (only when available is true for custom hours)' },
        end: { type: 'string', description: 'End time in HH:MM format (only when available is true for custom hours)' },
      },
      required: ['schedule_id', 'action', 'date'],
    },
  },
  {
    name: 'update_holidays',
    description: 'Manage holidays on an availability schedule. Load preset holidays for a country/year, add/remove individual holidays, or toggle a holiday on/off.',
    input_schema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'number', description: 'ID of the availability schedule' },
        action: { type: 'string', enum: ['load_preset', 'add', 'remove', 'toggle'], description: '"load_preset" to load country holidays, "add" to add a single holiday, "remove" to remove one, "toggle" to enable/disable one' },
        country: { type: 'string', description: 'Country code for load_preset: "US", "UK", "CA", "AU", "DE", "FR", "IN", "JP"' },
        year: { type: 'number', description: 'Year for load_preset. Defaults to current year.' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (for add/remove/toggle)' },
        name: { type: 'string', description: 'Holiday name (for add)' },
        enabled: { type: 'boolean', description: 'Whether the holiday is enabled (for toggle)' },
      },
      required: ['schedule_id', 'action'],
    },
  },
  {
    name: 'set_meeting_limits',
    description: 'Set daily and/or weekly meeting limits on an availability schedule. Pass an empty array to clear all limits.',
    input_schema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'number', description: 'ID of the availability schedule' },
        limits: {
          type: 'array',
          description: 'Array of meeting limit objects. Each has type ("daily" or "weekly") and max (positive integer). Pass empty array to clear.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['daily', 'weekly'], description: '"daily" or "weekly"' },
              max: { type: 'number', description: 'Maximum number of meetings allowed' },
            },
          },
        },
      },
      required: ['schedule_id', 'limits'],
    },
  },
  {
    name: 'update_calendar_settings',
    description: 'Update settings on a connected calendar: toggle conflict checking, event writing, or set as primary calendar.',
    input_schema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'number', description: 'ID of the calendar connection (from get_connected_calendars)' },
        check_conflicts: { type: 'boolean', description: 'Whether to check this calendar for scheduling conflicts' },
        write_events: { type: 'boolean', description: 'Whether to write new bookings to this calendar' },
        set_primary: { type: 'boolean', description: 'If true, set this calendar as the primary calendar' },
      },
      required: ['calendar_id'],
    },
  },
  {
    name: 'update_settings',
    description: 'Update booking page settings. Execute immediately.',
    input_schema: {
      type: 'object',
      properties: {
        display_name: { type: 'string' },
        slug: { type: 'string' },
        bio: { type: 'string' },
        brand_color: { type: 'string' },
        cancellation_policy: { type: 'string', description: 'Cancellation policy text shown on booking confirmation and cancel pages' },
        blocked_emails: { type: 'string', description: 'Newline-separated list of blocked emails or @domain.com patterns' },
      },
      required: [],
    },
  },
  {
    name: 'upgrade_to_pro',
    description: 'Start the Pro subscription upgrade flow ($2/month). Creates a Stripe checkout session and returns the checkout URL. The frontend will redirect the user to complete payment.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'submit_feedback',
    description: 'Submit feedback, report a bug, or request a feature. Use this when the user says they want to report a bug, give feedback, suggest a feature, or has a complaint. Execute immediately after collecting the details.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['feedback', 'bug', 'feature_request'], description: 'The type of feedback. Use "bug" for bug reports, "feature_request" for feature suggestions, "feedback" for general feedback.' },
        message: { type: 'string', description: 'The feedback message content.' },
      },
      required: ['category', 'message'],
    },
  },
  {
    name: 'navigate_to',
    description: 'Navigate the dashboard to a specific tab. Use when the user wants to see a particular section.',
    input_schema: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: ['overview', 'bookings', 'analytics', 'availability', 'routing-forms', 'settings'], description: 'The tab to navigate to' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'copy_to_clipboard',
    description: 'Copy text to the user\'s clipboard. Use for sharing links, slugs, etc.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to copy to clipboard' },
      },
      required: ['text'],
    },
  },
  {
    name: 'start_product_tour',
    description: 'Launch the interactive product tour — a guided, step-by-step walkthrough of the dashboard that highlights the public booking link, creating meeting types, setting availability, connecting a calendar, and using the AI assistant. Use this when the user is new, asks for a tour/walkthrough, says "show me around", "how does this work", "I\'m lost", or wants an overview of the main features.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'connect_zoom',
    description: 'Start the Zoom account connection flow (redirects the user to Zoom to authorize). Use when the user wants to connect Zoom, or when they want a "zoom" event type but Zoom is not connected yet (check the Zoom connected status in the context). After they connect, "zoom" event types will auto-generate Zoom links in their own account.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'trigger_password_reset',
    description: 'Trigger a password reset email for the given email address. Useful if the user says "I forgot my password" or wants to change their password via email link.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email address to send the password reset link to.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'get_embed_code',
    description: 'Get the HTML embed code snippet for embedding the user\'s booking page on an external website. Returns inline, popup, or badge embed code.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['inline', 'popup', 'badge'], description: 'Embed mode: "inline" for an embedded calendar, "popup" for a button that opens a popup, "badge" for a floating badge. Default: inline.' },
      },
      required: [],
    },
  },
  {
    name: 'get_audit_log',
    description: 'Get recent audit log entries for the current user. Returns a list of actions taken on the account (event type changes, booking actions, settings updates, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of entries to return. Default: 20. Max: 50.' },
        action: { type: 'string', description: 'Optional filter by action type, e.g. "event_type.created", "booking.cancelled", "settings.updated".' },
      },
      required: [],
    },
  },
  {
    name: 'get_team_page_url',
    description: 'Get the team page URL(s) for organizations the user belongs to. Returns the public team page link for each organization.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'manage_tracking',
    description: 'Get or set analytics tracking IDs (Google Analytics measurement ID and/or Meta Pixel ID) on the user\'s booking page.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: '"get" to retrieve current tracking IDs, "set" to update them.' },
        ga_measurement_id: { type: 'string', description: 'Google Analytics 4 measurement ID, e.g. "G-XXXXXXXXXX". Pass empty string to clear. Only used with action "set".' },
        meta_pixel_id: { type: 'string', description: 'Meta (Facebook) Pixel ID. Pass empty string to clear. Only used with action "set".' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_slack',
    description: 'Manage Slack webhook integration. Get the current webhook URL, set a new one, test the connection, or remove it.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'test', 'remove'], description: '"get" to see current webhook, "set" to configure a new one, "test" to send a test message, "remove" to disconnect Slack.' },
        webhook_url: { type: 'string', description: 'Slack incoming webhook URL (required for "set" action). Must start with https://hooks.slack.com/' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_paypal',
    description: 'Manage PayPal payment credentials. Get the current status, set new credentials, or remove them.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'remove'], description: '"get" to check if PayPal is configured, "set" to save credentials, "remove" to disconnect PayPal.' },
        client_id: { type: 'string', description: 'PayPal client ID (required for "set" action).' },
        client_secret: { type: 'string', description: 'PayPal client secret (required for "set" action).' },
        mode: { type: 'string', enum: ['sandbox', 'live'], description: 'PayPal mode. Default: sandbox.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'resend_verification',
    description: 'Resend the email verification email to the current user. Use when the user says their email is not verified or they need a new verification link.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_poll',
    description: 'Create a meeting poll so invitees can vote on proposed time options. Provide a title and one or more options, each with date (YYYY-MM-DD), start_time and end_time (HH:MM, 24-hour). Returns the poll and its shareable voting link.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Poll title, e.g. "Team sync time".' },
        description: { type: 'string', description: 'Optional description shown to voters.' },
        options: {
          type: 'array',
          description: 'Proposed time slots to vote on (at least one).',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD' },
              start_time: { type: 'string', description: 'HH:MM (24-hour)' },
              end_time: { type: 'string', description: 'HH:MM (24-hour)' },
            },
            required: ['date', 'start_time', 'end_time'],
          },
        },
      },
      required: ['title', 'options'],
    },
  },
  {
    name: 'list_polls',
    description: 'List the user\'s meeting polls with status, voter counts, and shareable voting links.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finalize_poll',
    description: 'Finalize a meeting poll by choosing the winning time option. If option_id is omitted, the most-voted option is selected automatically.',
    input_schema: {
      type: 'object',
      properties: {
        poll_id: { type: 'number', description: 'The poll to finalize.' },
        option_id: { type: 'number', description: 'Optional specific option to pick; if omitted, the most-voted option wins.' },
      },
      required: ['poll_id'],
    },
  },
];

// ============================================================
// Feedback Handlers
// ============================================================

async function handleSubmitFeedback(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { category, message } = body;
  if (!message || !message.trim()) {
    return jsonResponse({ error: 'Message is required' }, 400);
  }

  const validCategories = ['feedback', 'bug', 'feature_request'];
  const cat = validCategories.includes(category) ? category : 'feedback';

  if (message.trim().length > 5000) {
    return jsonResponse({ error: 'Message must be 5000 characters or less' }, 400);
  }

  await env.DB.prepare(
    'INSERT INTO feedback (user_id, category, message) VALUES (?, ?, ?)'
  ).bind(user.id, cat, message.trim()).run();

  return jsonResponse({ ok: true, message: 'Feedback submitted. Thank you!' }, 201);
}

async function handleListFeedback(request, env, user) {
  // Admin only (ADMIN_EMAIL env var)
  if (!isAdmin(env, user)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;

  const [countResult, feedbackResult] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as total FROM feedback').first(),
    env.DB.prepare(
      'SELECT f.id, f.category, f.message, f.created_at, u.name as user_name, u.email as user_email FROM feedback f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC LIMIT ? OFFSET ?'
    ).bind(limit, offset).all(),
  ]);

  return jsonResponse({
    data: feedbackResult.results,
    pagination: { page, limit, total: countResult.total },
  });
}

// ============================================================
// Admin Dashboard Handlers
// ============================================================

// Platform admins come from the ADMIN_EMAIL env var (comma-separated), so each
// deployment — including self-hosted ones — picks its own. Unset = no admin.
export function isAdmin(env, user) {
  const admins = String(env.ADMIN_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return !!user?.email && admins.includes(String(user.email).toLowerCase());
}

async function handleAdminStats(request, env, user) {
  if (!isAdmin(env, user)) return jsonResponse({ error: 'Forbidden' }, 403);

  const now = new Date();
  const thirtyDaysAgo = formatDbTimestamp(now.getTime() - 30 * 86400000);
  const sevenDaysAgo = formatDbTimestamp(now.getTime() - 7 * 86400000);

  // Run queries individually with error handling so one failure doesn't crash everything
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  const [
    totalUsers, totalBookings, activeUsers, proUsers,
    recentSignups, totalRevenue, bookingsThisMonth,
    totalEventTypes, totalCalendars, recentFeedback,
    failedNotifications, aiConversations, dailySignups
  ] = await Promise.all([
    safe(() => env.DB.prepare('SELECT COUNT(*) as cnt FROM users').first()),
    safe(() => env.DB.prepare('SELECT COUNT(*) as cnt FROM bookings').first()),
    safe(() => env.DB.prepare(`SELECT COUNT(DISTINCT et.user_id) as cnt FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE ${sqlUnixEpoch('b.created_at')} >= ${sqlUnixEpoch('?')}`).bind(thirtyDaysAgo).first()),
    safe(() => env.DB.prepare("SELECT COUNT(DISTINCT user_id) as cnt FROM payments WHERE status = 'succeeded'").first()),
    safe(() => env.DB.prepare(`SELECT COUNT(*) as cnt FROM users WHERE ${sqlUnixEpoch('created_at')} >= ${sqlUnixEpoch('?')}`).bind(sevenDaysAgo).first()),
    safe(() => env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM payments WHERE status = 'succeeded'").first()),
    safe(() => env.DB.prepare(`SELECT COUNT(*) as cnt FROM bookings WHERE ${sqlUnixEpoch('created_at')} >= ${sqlUnixEpoch('?')}`).bind(formatDbTimestamp(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)))).first()),
    safe(() => env.DB.prepare('SELECT COUNT(*) as cnt FROM event_types').first()),
    safe(() => env.DB.prepare('SELECT COUNT(*) as cnt FROM calendar_connections').first()),
    safe(() => env.DB.prepare('SELECT f.id, f.category, f.message, f.created_at, u.name, u.email FROM feedback f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC LIMIT 10').all()),
    safe(() => env.DB.prepare("SELECT COUNT(*) as cnt FROM notification_log WHERE status = 'failed'").first()),
    safe(() => env.DB.prepare('SELECT COUNT(*) as cnt FROM ai_conversations').first()),
    safe(() => env.DB.prepare(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE ${sqlUnixEpoch('created_at')} >= ${sqlUnixEpoch('?')} GROUP BY date ORDER BY date`).bind(thirtyDaysAgo).all()),
  ]);

  return jsonResponse({
    total_users: totalUsers?.cnt || 0,
    total_bookings: totalBookings?.cnt || 0,
    active_users_30d: activeUsers?.cnt || 0,
    pro_subscribers: proUsers?.cnt || 0,
    recent_signups_7d: recentSignups?.cnt || 0,
    total_revenue_cents: totalRevenue?.total || 0,
    bookings_this_month: bookingsThisMonth?.cnt || 0,
    total_event_types: totalEventTypes?.cnt || 0,
    total_calendar_connections: totalCalendars?.cnt || 0,
    failed_notifications: failedNotifications?.cnt || 0,
    ai_conversations: aiConversations?.cnt || 0,
    recent_feedback: recentFeedback?.results || [],
    daily_signups: dailySignups?.results || [],
  });
}

async function handleAdminUsers(request, env, user, url) {
  if (!isAdmin(env, user)) return jsonResponse({ error: 'Forbidden' }, 403);

  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;
  const search = url.searchParams.get('search') || '';

  let whereClause = '';
  let bindArgs = [];
  if (search) {
    whereClause = "WHERE u.name LIKE ? OR u.email LIKE ?";
    bindArgs = [`%${search}%`, `%${search}%`];
  }

  const countStmt = search
    ? env.DB.prepare(`SELECT COUNT(*) as total FROM users u ${whereClause}`).bind(...bindArgs)
    : env.DB.prepare('SELECT COUNT(*) as total FROM users');
  const countResult = await countStmt.first();

  const queryStmt = env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.timezone, u.created_at,
            (SELECT COUNT(*) FROM event_types WHERE user_id = u.id) as event_type_count,
            (SELECT COUNT(*) FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = u.id) as booking_count,
            (SELECT COUNT(*) FROM calendar_connections WHERE user_id = u.id) as calendar_count,
            (SELECT MAX(b.created_at) FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = u.id) as last_booking_at,
            bp.slug as booking_slug
     FROM users u
     LEFT JOIN booking_pages bp ON bp.user_id = u.id
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`
  );

  const usersResult = search
    ? await queryStmt.bind(...bindArgs, limit, offset).all()
    : await queryStmt.bind(limit, offset).all();

  return jsonResponse({
    data: usersResult.results,
    pagination: { page, limit, total: countResult.total },
  });
}

// ============================================================
// Email Sequence Handlers
// ============================================================

// Turn a raw AI-call failure into a clear, actionable message for the user.
// The dashboard AI assistant has no fallback model (tool-calling needs Claude),
// so when the Anthropic call fails the message it shows IS the whole diagnosis.
// Previously only 429/529 were handled and everything else (auth, credit,
// provider 5xx outages, network errors) collapsed into "something went wrong",
// which is exactly what made the CU-09 run impossible to diagnose. The error
// message thrown upstream looks like `Claude API <status>: <body excerpt>`.
export function classifyAiError(err) {
  const msg = (err && err.message) || '';
  const statusMatch = msg.match(/Claude API (\d{3})/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null;

  if (status === 429 || /rate.?limit/i.test(msg)) {
    return 'The AI assistant is temporarily rate-limited. Please wait a moment and try again.';
  }
  if (status === 529 || /overloaded/i.test(msg)) {
    return 'The AI service is busy right now. Please try again in a few seconds.';
  }
  if (status === 401 || status === 403 || /authentication|invalid x-api-key|permission_error/i.test(msg)) {
    return 'The AI assistant couldn’t authenticate. If you set your own API key in Settings → AI, double-check it’s valid; otherwise this is a temporary issue on our side — please try again shortly.';
  }
  if (status === 400 && /credit|billing|quota|insufficient/i.test(msg)) {
    return 'The AI assistant’s API key is out of credit. If you’re using your own key (Settings → AI), top it up; otherwise please try again later.';
  }
  if (status && status >= 500) {
    return 'The AI service is temporarily unavailable (provider outage). Your data is safe — please try again shortly.';
  }
  if (!status && /fetch|network|timeout|timed out|Failed to|ECONN|socket/i.test(msg)) {
    return 'Couldn’t reach the AI service. Check your connection and try again.';
  }
  return 'Sorry, something went wrong with the AI assistant. Please try again.';
}

async function getAIApiKey(env, userId) {
  // Check for user's own API key (BYOK)
  if (userId) {
    const user = await env.DB.prepare('SELECT ai_api_key_encrypted FROM users WHERE id = ?').bind(userId).first();
    if (user?.ai_api_key_encrypted) {
      try {
        return await decryptToken(user.ai_api_key_encrypted, env.ENCRYPTION_KEY);
      } catch {}
    }
  }
  return env.ANTHROPIC_API_KEY;
}

async function handleUpdateAIKey(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { api_key } = body;
  if (!api_key || !api_key.trim()) return jsonResponse({ error: 'api_key is required' }, 400);

  const trimmedKey = api_key.trim();
  if (!trimmedKey.startsWith('sk-')) return jsonResponse({ error: 'API key should start with sk-' }, 400);

  const encrypted = await encryptToken(trimmedKey, env.ENCRYPTION_KEY);
  await env.DB.prepare(
    "UPDATE users SET ai_api_key_encrypted = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(encrypted, user.id).run();

  return jsonResponse({ success: true, has_key: true });
}

async function handleDeleteAIKey(request, env, user) {
  await env.DB.prepare(
    "UPDATE users SET ai_api_key_encrypted = NULL, updated_at = datetime('now') WHERE id = ?"
  ).bind(user.id).run();
  return jsonResponse({ success: true, has_key: false });
}

async function handleListEmailSequences(request, env, user) {
  const results = await env.DB.prepare(
    `SELECT es.*, et.name as event_type_name FROM email_sequences es
     LEFT JOIN event_types et ON es.event_type_id = et.id
     WHERE es.user_id = ? ORDER BY es.trigger_type, es.delay_minutes`
  ).bind(user.id).all();
  return jsonResponse({ data: results.results });
}

async function handleCreateEmailSequence(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { event_type_id, trigger_type, delay_minutes, subject, body: emailBody } = body;
  if (!trigger_type || !['before_meeting', 'after_meeting', 'after_booking'].includes(trigger_type)) {
    return jsonResponse({ error: 'trigger_type must be before_meeting, after_meeting, or after_booking' }, 400);
  }
  if (delay_minutes === undefined || delay_minutes < 0) return jsonResponse({ error: 'delay_minutes is required and must be >= 0' }, 400);
  if (!subject || !subject.trim()) return jsonResponse({ error: 'subject is required' }, 400);
  if (!emailBody || !emailBody.trim()) return jsonResponse({ error: 'body is required' }, 400);

  const result = await env.DB.prepare(
    'INSERT INTO email_sequences (user_id, event_type_id, trigger_type, delay_minutes, subject, body) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(user.id, event_type_id || null, trigger_type, delay_minutes, subject.trim(), emailBody.trim()).first();

  return jsonResponse(result, 201);
}

async function handleUpdateEmailSequence(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare('SELECT * FROM email_sequences WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  if (body.subject !== undefined) fields.subject = body.subject.trim();
  if (body.body !== undefined) fields.body = body.body.trim();
  if (body.delay_minutes !== undefined) fields.delay_minutes = body.delay_minutes;
  if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0;
  if (body.trigger_type !== undefined) fields.trigger_type = body.trigger_type;

  if (Object.keys(fields).length === 0) return jsonResponse({ error: 'No fields to update' }, 400);
  fields.updated_at = formatDbTimestamp();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const result = await env.DB.prepare(
    `UPDATE email_sequences SET ${setClauses} WHERE id = ? AND user_id = ? RETURNING *`
  ).bind(...Object.values(fields), id, user.id).first();

  return jsonResponse(result);
}

async function handleDeleteEmailSequence(request, env, user, path) {
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM email_sequences WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return jsonResponse({ success: true });
}

// ============================================================
// Holiday Presets
// ============================================================

async function handleGetHolidayPresets(url) {
  const country = (url.searchParams.get('country') || 'US').toUpperCase();
  const year = parseInt(url.searchParams.get('year') || new Date().getFullYear(), 10);

  const presets = await getHolidayPresets(country, year);
  return jsonResponse({ country, year, holidays: presets });
}

async function getHolidayPresets(country, year, env) {
  // ── Nager.Date API covers ~100 countries with accurate dates ──
  // Countries NOT covered by Nager.Date get hardcoded per-year data
  const NAGER_UNSUPPORTED = new Set(['IN']);

  if (!NAGER_UNSUPPORTED.has(country)) {
    try {
      const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          return data.map(h => ({
            date: h.date,
            name: h.localName || h.name,
          }));
        }
      }
    } catch (e) {
      // Fall through to hardcoded presets
    }
  }

  // ── Fallback: hardcoded presets for unsupported countries ──
  // India uses lunar calendar for many holidays — dates are per-year lookups
  function fmt(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // India gazetted holidays (source: timeanddate.com, Government of India gazette)
  // Lunar holidays have year-specific dates
  const INDIA_HOLIDAYS = {
    2025: [
      { date: `2025-01-14`, name: 'Makar Sankranti' },
      { date: `2025-01-26`, name: 'Republic Day' },
      { date: `2025-02-26`, name: 'Maha Shivaratri' },
      { date: `2025-03-14`, name: 'Holi' },
      { date: `2025-03-30`, name: 'Ramzan Id (Eid ul-Fitr)' },
      { date: `2025-03-31`, name: 'Ugadi' },
      { date: `2025-04-06`, name: 'Rama Navami' },
      { date: `2025-04-10`, name: 'Mahavir Jayanti' },
      { date: `2025-04-14`, name: 'Ambedkar Jayanti' },
      { date: `2025-04-18`, name: 'Good Friday' },
      { date: `2025-05-12`, name: 'Buddha Purnima' },
      { date: `2025-06-07`, name: 'Bakrid (Eid ul-Adha)' },
      { date: `2025-07-06`, name: 'Muharram' },
      { date: `2025-08-15`, name: 'Independence Day' },
      { date: `2025-08-16`, name: 'Janmashtami' },
      { date: `2025-09-05`, name: 'Milad-un-Nabi' },
      { date: `2025-10-02`, name: 'Gandhi Jayanti' },
      { date: `2025-10-02`, name: 'Dussehra' },
      { date: `2025-10-20`, name: 'Diwali' },
      { date: `2025-11-05`, name: 'Guru Nanak Jayanti' },
      { date: `2025-12-25`, name: 'Christmas Day' },
    ],
    2026: [
      { date: `2026-01-14`, name: 'Makar Sankranti' },
      { date: `2026-01-26`, name: 'Republic Day' },
      { date: `2026-02-15`, name: 'Maha Shivaratri' },
      { date: `2026-03-04`, name: 'Holi' },
      { date: `2026-03-21`, name: 'Ramzan Id (Eid ul-Fitr)' },
      { date: `2026-03-31`, name: 'Mahavir Jayanti' },
      { date: `2026-04-03`, name: 'Good Friday' },
      { date: `2026-04-14`, name: 'Ambedkar Jayanti' },
      { date: `2026-05-01`, name: 'Buddha Purnima' },
      { date: `2026-05-27`, name: 'Bakrid (Eid ul-Adha)' },
      { date: `2026-08-15`, name: 'Independence Day' },
      { date: `2026-08-26`, name: 'Milad-un-Nabi' },
      { date: `2026-08-28`, name: 'Raksha Bandhan' },
      { date: `2026-09-04`, name: 'Janmashtami' },
      { date: `2026-10-02`, name: 'Gandhi Jayanti' },
      { date: `2026-10-20`, name: 'Dussehra' },
      { date: `2026-11-08`, name: 'Diwali' },
      { date: `2026-11-24`, name: 'Guru Nanak Jayanti' },
      { date: `2026-12-25`, name: 'Christmas Day' },
    ],
    2027: [
      { date: `2027-01-15`, name: 'Makar Sankranti' },
      { date: `2027-01-26`, name: 'Republic Day' },
      { date: `2027-03-06`, name: 'Maha Shivaratri' },
      { date: `2027-03-10`, name: 'Ramzan Id (Eid ul-Fitr)' },
      { date: `2027-03-22`, name: 'Holi' },
      { date: `2027-03-26`, name: 'Good Friday' },
      { date: `2027-04-14`, name: 'Ambedkar Jayanti' },
      { date: `2027-04-15`, name: 'Rama Navami' },
      { date: `2027-05-01`, name: 'May Day' },
      { date: `2027-05-17`, name: 'Bakrid (Eid ul-Adha)' },
      { date: `2027-05-20`, name: 'Buddha Purnima' },
      { date: `2027-08-15`, name: 'Independence Day' },
      { date: `2027-08-17`, name: 'Raksha Bandhan' },
      { date: `2027-08-25`, name: 'Janmashtami' },
      { date: `2027-10-02`, name: 'Gandhi Jayanti' },
      { date: `2027-10-09`, name: 'Dussehra' },
      { date: `2027-10-29`, name: 'Diwali' },
      { date: `2027-11-14`, name: 'Guru Nanak Jayanti' },
      { date: `2027-12-25`, name: 'Christmas Day' },
    ],
    2028: [
      { date: `2028-01-14`, name: 'Makar Sankranti' },
      { date: `2028-01-26`, name: 'Republic Day' },
      { date: `2028-02-24`, name: 'Maha Shivaratri' },
      { date: `2028-02-29`, name: 'Ramzan Id (Eid ul-Fitr)' },
      { date: `2028-03-11`, name: 'Holi' },
      { date: `2028-04-14`, name: 'Ambedkar Jayanti & Good Friday' },
      { date: `2028-05-07`, name: 'Bakrid (Eid ul-Adha)' },
      { date: `2028-05-09`, name: 'Buddha Purnima' },
      { date: `2028-08-05`, name: 'Raksha Bandhan' },
      { date: `2028-08-14`, name: 'Janmashtami' },
      { date: `2028-08-15`, name: 'Independence Day' },
      { date: `2028-09-28`, name: 'Dussehra' },
      { date: `2028-10-02`, name: 'Gandhi Jayanti' },
      { date: `2028-10-17`, name: 'Diwali' },
      { date: `2028-11-03`, name: 'Guru Nanak Jayanti' },
      { date: `2028-12-25`, name: 'Christmas Day' },
    ],
  };

  if (country === 'IN') {
    return INDIA_HOLIDAYS[year] || INDIA_HOLIDAYS[2026] || [];
  }

  // If Nager.Date failed, return empty (shouldn't happen for supported countries)
  return [];
}

// ============================================================
// Single-Use Links
// ============================================================

async function handleCreateSingleUseLink(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { event_type_id, label, max_uses, expires_in_hours } = body;
  if (!event_type_id) return jsonResponse({ error: 'event_type_id is required' }, 400);

  // Verify event type belongs to user
  const et = await env.DB.prepare(
    'SELECT id, slug, name FROM event_types WHERE id = ? AND user_id = ?'
  ).bind(event_type_id, user.id).first();
  if (!et) return jsonResponse({ error: 'Event type not found' }, 404);

  // Get booking page slug for building the URL
  const page = await env.DB.prepare(
    'SELECT slug FROM booking_pages WHERE user_id = ?'
  ).bind(user.id).first();

  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const expiresAt = expires_in_hours
    ? formatDbTimestamp(new Date(Date.now() + expires_in_hours * 60 * 60 * 1000))
    : null;

  const result = await env.DB.prepare(
    'INSERT INTO single_use_links (user_id, event_type_id, token, label, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(user.id, event_type_id, token, label || null, max_uses || 1, expiresAt).first();

  // Build the full URL
  const origin = new URL(request.url).origin;
  result.url = `${origin}/booking/${page?.slug || ''}?link=${token}`;

  return jsonResponse(result, 201);
}

async function handleListSingleUseLinks(request, env, user) {
  const results = await env.DB.prepare(
    `SELECT sul.*, et.name as event_type_name, et.slug as event_type_slug
     FROM single_use_links sul
     JOIN event_types et ON sul.event_type_id = et.id
     WHERE sul.user_id = ?
     ORDER BY sul.created_at DESC`
  ).bind(user.id).all();

  return jsonResponse({ data: results.results });
}

async function handleRevokeSingleUseLink(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare(
    'SELECT id FROM single_use_links WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  await env.DB.prepare(
    'UPDATE single_use_links SET is_active = 0 WHERE id = ?'
  ).bind(id).run();

  return jsonResponse({ success: true });
}

async function handleResolveSingleUseLink(request, env, path) {
  const token = path.replace('/api/link/', '');
  const link = await env.DB.prepare(
    `SELECT sul.*, et.slug as event_type_slug, et.name as event_type_name, bp.slug as username
     FROM single_use_links sul
     JOIN event_types et ON sul.event_type_id = et.id
     JOIN booking_pages bp ON bp.user_id = sul.user_id
     WHERE sul.token = ?`
  ).bind(token).first();

  if (!link) return jsonResponse({ error: 'Link not found' }, 404);
  if (!link.is_active) return jsonResponse({ error: 'This link has been revoked' }, 410);
  if (link.use_count >= link.max_uses) return jsonResponse({ error: 'This link has already been used' }, 410);
  if (link.expires_at) {
    const exp = new Date(link.expires_at.includes('T') ? link.expires_at : link.expires_at.replace(' ', 'T') + 'Z');
    if (exp < new Date()) return jsonResponse({ error: 'This link has expired' }, 410);
  }

  return jsonResponse({
    username: link.username,
    event_type_slug: link.event_type_slug,
    event_type_name: link.event_type_name,
    token: link.token,
  });
}

// ============================================================
// Coupon Handlers
// ============================================================

async function handleCreateCoupon(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { code, discount_type, discount_value, max_uses, applies_to, expires_in_days } = body;
  if (!code || !code.trim()) return jsonResponse({ error: 'code is required' }, 400);
  if (!discount_value || discount_value <= 0) return jsonResponse({ error: 'discount_value must be positive' }, 400);

  const type = discount_type === 'fixed' ? 'fixed' : 'percent';
  if (type === 'percent' && discount_value > 100) return jsonResponse({ error: 'Percent discount cannot exceed 100' }, 400);

  const normalizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalizedCode.length < 2) return jsonResponse({ error: 'Code must be at least 2 characters' }, 400);

  const expiresAt = expires_in_days
    ? formatDbTimestamp(new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000))
    : null;

  try {
    const result = await env.DB.prepare(
      'INSERT INTO coupons (user_id, code, discount_type, discount_value, max_uses, applies_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *'
    ).bind(user.id, normalizedCode, type, discount_value, max_uses || null, JSON.stringify(applies_to || 'all'), expiresAt).first();
    return jsonResponse(result, 201);
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return jsonResponse({ error: 'A coupon with this code already exists' }, 409);
    throw err;
  }
}

async function handleListCoupons(request, env, user) {
  const results = await env.DB.prepare(
    'SELECT * FROM coupons WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return jsonResponse({ data: results.results });
}

async function handleUpdateCoupon(request, env, user, path) {
  const id = path.split('/').pop();
  const existing = await env.DB.prepare('SELECT * FROM coupons WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const fields = {};
  if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0;
  if (body.max_uses !== undefined) fields.max_uses = body.max_uses;
  if (body.discount_value !== undefined) fields.discount_value = body.discount_value;

  if (Object.keys(fields).length === 0) return jsonResponse({ error: 'No fields to update' }, 400);

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const result = await env.DB.prepare(
    `UPDATE coupons SET ${setClauses} WHERE id = ? AND user_id = ? RETURNING *`
  ).bind(...Object.values(fields), id, user.id).first();

  return jsonResponse(result);
}

async function handleDeleteCoupon(request, env, user, path) {
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM coupons WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return jsonResponse({ success: true });
}

async function handleValidateCoupon(request, env, url, path) {
  const code = path.replace('/api/validate-coupon/', '').toUpperCase();
  const username = url.searchParams.get('user');
  const eventTypeId = url.searchParams.get('event_type_id');

  if (!username) return jsonResponse({ error: 'user parameter required' }, 400);

  const page = await env.DB.prepare('SELECT user_id FROM booking_pages WHERE slug = ?').bind(username).first();
  if (!page) return jsonResponse({ error: 'User not found' }, 404);

  const coupon = await env.DB.prepare(
    'SELECT * FROM coupons WHERE user_id = ? AND code = ? AND is_active = 1'
  ).bind(page.user_id, code).first();

  if (!coupon) return jsonResponse({ error: 'Invalid coupon code' }, 404);
  if (coupon.max_uses && coupon.use_count >= coupon.max_uses) return jsonResponse({ error: 'Coupon has been fully redeemed' }, 410);
  if (coupon.expires_at) {
    const exp = new Date(coupon.expires_at.includes('T') ? coupon.expires_at : coupon.expires_at.replace(' ', 'T') + 'Z');
    if (exp < new Date()) return jsonResponse({ error: 'Coupon has expired' }, 410);
  }

  // Check if coupon applies to this event type
  let appliesToParsed = coupon.applies_to;
  try { appliesToParsed = JSON.parse(coupon.applies_to); } catch {}
  if (appliesToParsed !== 'all' && Array.isArray(appliesToParsed) && eventTypeId) {
    if (!appliesToParsed.includes(parseInt(eventTypeId))) {
      return jsonResponse({ error: 'Coupon does not apply to this event type' }, 400);
    }
  }

  return jsonResponse({
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    description: coupon.discount_type === 'percent'
      ? `${coupon.discount_value}% off`
      : `$${(coupon.discount_value / 100).toFixed(2)} off`,
  });
}

async function handleDashboardAI(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const { message, session_id } = body;
  if (!message) return jsonResponse({ error: 'message is required' }, 400);

  const aiApiKey = await getAIApiKey(env, user.id);
  if (!aiApiKey) {
    return jsonResponse({ error: 'AI not configured. Add your API key in Settings or contact the administrator.' }, 503);
  }

  const chatSessionId = session_id || crypto.randomUUID();

  try {
  // Load user context in parallel
  const [eventTypesRes, bookingsRes, bookingPage, calendarsRes, schedulesRes, zoomConn] = await Promise.all([
    env.DB.prepare('SELECT id, name, slug, description, duration_minutes, color, is_active, is_secret, redirect_url, allow_guests, group_max_attendees FROM event_types WHERE user_id = ?').bind(user.id).all(),
    env.DB.prepare("SELECT b.id, b.invitee_name, b.invitee_email, b.start_time, b.end_time, b.status, b.event_type_id FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = ? AND b.status IN ('confirmed', 'pending') ORDER BY b.start_time LIMIT 20").bind(user.id).all(),
    env.DB.prepare('SELECT slug, display_name, bio, brand_color, logo_url, hide_branding, custom_domain FROM booking_pages WHERE user_id = ?').bind(user.id).first(),
    env.DB.prepare('SELECT id, provider, email FROM calendar_connections WHERE user_id = ?').bind(user.id).all(),
    env.DB.prepare('SELECT id, name, timezone, rules, is_default FROM availability_schedules WHERE user_id = ?').bind(user.id).all(),
    env.DB.prepare('SELECT id FROM zoom_connections WHERE user_id = ?').bind(user.id).first(),
  ]);

  const eventTypes = eventTypesRes.results;
  const bookings = bookingsRes.results;
  const calendars = calendarsRes.results;
  const schedules = schedulesRes.results;
  const zoomConnected = !!zoomConn;

  // Build user context for the system prompt
  const appOrigin = env.APP_ORIGIN || 'https://calendo.dev';
  const userContext = `
## Current User Context
- **Name**: ${user.name}
- **Email**: ${user.email}
- **Booking page slug**: ${bookingPage?.slug || 'not set'}
- **Booking page URL**: ${bookingPage?.slug ? bookingPageUrl(appOrigin, bookingPage.slug) : 'not set'}
- **Connected calendars**: ${calendars.length === 0 ? 'None' : calendars.map(c => `${c.provider} (${c.email})`).join(', ')}
- **Zoom connected**: ${zoomConnected ? 'Yes' : 'No (to use Zoom meetings, the user connects Zoom in Settings → Connect Zoom)'}

### Event Types (${eventTypes.length} total)
${eventTypes.length === 0 ? 'No event types created yet.' : eventTypes.map(et =>
  `- ID ${et.id}: "${et.name}" — ${et.duration_minutes} min, ${et.is_active ? 'active' : 'INACTIVE'}, color ${et.color}, slug "${et.slug}", URL ${bookingPage?.slug ? eventTypeBookingUrl(appOrigin, bookingPage.slug, et.slug) : '(set a booking page slug first)'}${et.is_secret ? ' [SECRET]' : ''}${et.group_max_attendees ? ` (group, max ${et.group_max_attendees})` : ''}${et.redirect_url ? ` redirect→${et.redirect_url}` : ''}`
).join('\n')}

### Upcoming Bookings (${bookings.length})
${bookings.length === 0 ? 'No upcoming bookings.' : bookings.slice(0, 10).map(b =>
  `- ID ${b.id}: ${b.invitee_name} (${b.invitee_email}) on ${b.start_time} — ${b.status}`
).join('\n')}

### Availability Schedules (${schedules.length})
${schedules.map(s => `- ID ${s.id}: "${s.name}" (${s.timezone})${s.is_default ? ' [DEFAULT]' : ''}`).join('\n')}
`;

  const systemPrompt = `You are Calendo AI, the dashboard assistant for a scheduling platform. You help the logged-in user manage their account, answer questions about features, and take actions on their behalf.

${DASHBOARD_KNOWLEDGE_BASE}

${userContext}

## Rules
1. Be concise and helpful. 2-3 sentences for simple answers. More detail only when the user asks.
2. When you take an action (create, update, delete), confirm what you did with specific details.
3. For HIGH-RISK actions (deleting event types, cancelling bookings, deleting account), ask the user to confirm BEFORE calling the tool. Once the user confirms (even with typos like "confriemd", "yea", "do it", "yes pls"), proceed with the action — don't require exact spelling.
4. For account deletion, warn the user it's permanent and will delete ALL data. Only proceed after explicit confirmation.
5. Use the tools provided to fetch data and take actions. Don't make up data — always use tool results.
6. NEVER claim you changed something unless a tool actually returned a successful result for THAT specific change. Only report the exact fields a tool confirms (e.g. read the returned event_type object) — do not assume side effects. For example, renaming an event type does NOT change its slug/URL; only claim the slug changed if you explicitly updated it and the tool's returned row shows the new slug. If a tool returns an error, tell the user it failed and why — never report success.
7. CRITICAL: When sharing ANY link (booking page URL, event type URL, or any URL), you MUST include the full URL text in your response message so the user can see it. Also use the copy_to_clipboard tool. Example response: "Here's your booking link: https://calendo.dev/your-slug — I've copied it to your clipboard." NEVER respond with just "Copied!" without showing the URL.
7a. URLs: ALWAYS use the exact booking URLs given in the Current User Context above or returned by tools (e.g. get_booking_link) verbatim. NEVER invent, guess, or describe a URL format from memory — the product's URL format may have changed since your training. The current format is a clean short link like https://calendo.dev/<slug> and https://calendo.dev/<slug>/<event-slug>; do NOT tell users about any "?user=" query format.
8. If the user asks about something you can look up (bookings, event types, etc.), use the appropriate tool rather than relying only on the context above, since the context may be stale.
9. Keep a friendly, direct tone. No corporate speak.
10. If asked what model you are, be transparent: you are powered by Claude (by Anthropic). The specific model is Claude Sonnet 4.6. Calendo is built by a solo indie developer using the Claude API.
11. ONLY answer questions related to Calendo: scheduling, bookings, event types, availability, calendars, payments, team management, and account settings. For ANY other topic (math, science, news, general knowledge, coding, creative writing, etc.), respond with: "I'm Calendo AI — I can only help with scheduling and account management. Is there anything about your bookings or events I can help with?" Do NOT answer off-topic questions under any circumstances.`;

  // Get or create conversation
  let conversation = await env.DB.prepare(
    'SELECT * FROM ai_conversations WHERE session_id = ?'
  ).bind(chatSessionId).first();

  let messages = [];
  if (conversation) {
    messages = JSON.parse(conversation.messages || '[]');
  }

  messages.push({ role: 'user', content: message });

  // Keep last 20 messages for context
  const chatMessages = messages.slice(-20).map(m => ({ role: m.role, content: m.content }));

    const actionsTaken = [];
    let maxRounds = 5;
    let currentMessages = chatMessages;
    let finalText = '';

    // Tool use loop — Claude may call multiple tools across multiple rounds
    while (maxRounds-- > 0) {
      const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': aiApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          tools: DASHBOARD_TOOLS,
          messages: currentMessages,
        }),
      });

      if (!claudeResponse.ok) {
        const errText = await claudeResponse.text();
        console.error('Claude API error:', claudeResponse.status, errText);
        throw new Error(`Claude API ${claudeResponse.status}: ${errText.slice(0, 200)}`);
      }

      const claudeData = await claudeResponse.json();

      // Extract text and tool_use blocks
      const textBlocks = claudeData.content.filter(b => b.type === 'text');
      const toolBlocks = claudeData.content.filter(b => b.type === 'tool_use');

      if (textBlocks.length > 0) {
        finalText = textBlocks.map(b => b.text).join('\n');
      }

      // If no tool calls, we're done
      if (toolBlocks.length === 0 || claudeData.stop_reason !== 'tool_use') {
        break;
      }

      // Execute tool calls
      const toolResults = [];
      for (const toolCall of toolBlocks) {
        const result = await executeDashboardTool(toolCall.name, toolCall.input, env, user, appOrigin);
        actionsTaken.push({ type: toolCall.name, description: result.description });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result.data),
        });
      }

      // Build next round messages: add assistant response + tool results
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: claudeData.content },
        { role: 'user', content: toolResults },
      ];
    }

    if (!finalText) {
      finalText = 'I processed your request. Is there anything else you need?';
    }

    // Save conversation
    messages.push({ role: 'assistant', content: finalText });
    const messagesJson = JSON.stringify(messages.slice(-40));

    // Save conversation (only if user has a booking page, due to FK constraint)
    const bpRow = bookingPage ? await env.DB.prepare('SELECT id FROM booking_pages WHERE slug = ?').bind(bookingPage.slug).first() : null;
    if (bpRow) {
      if (conversation) {
        await env.DB.prepare(
          "UPDATE ai_conversations SET messages = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(messagesJson, conversation.id).run();
      } else {
        await env.DB.prepare(
          'INSERT INTO ai_conversations (booking_page_id, session_id, messages) VALUES (?, ?, ?)'
        ).bind(bpRow.id, chatSessionId, messagesJson).run();
      }
    }

    // Separate actions into write actions (for display) and frontend actions (for execution)
    const writeActions = actionsTaken.filter(a => !a.type.startsWith('get_') && a.type !== 'navigate_to' && a.type !== 'copy_to_clipboard' && a.type !== 'start_product_tour' && a.type !== 'connect_zoom');
    const frontendActions = actionsTaken.filter(a => a.type === 'navigate_to' || a.type === 'copy_to_clipboard' || a.type === 'upgrade_to_pro' || a.type === 'start_product_tour' || a.type === 'connect_zoom');

    return jsonResponse({
      session_id: chatSessionId,
      message: finalText,
      actions_taken: writeActions.length > 0 ? writeActions : undefined,
      frontend_actions: frontendActions.length > 0 ? frontendActions : undefined,
    });
  } catch (err) {
    console.error('Dashboard AI error:', err.message, err.stack);
    const freshSessionId = crypto.randomUUID();
    return jsonResponse({
      session_id: freshSessionId,
      message: classifyAiError(err),
    });
  }
}

async function executeDashboardTool(toolName, input, env, user, appOrigin) {
  switch (toolName) {
    case 'get_event_types': {
      const res = await env.DB.prepare('SELECT id, name, slug, description, duration_minutes, color, is_active, is_secret, redirect_url, allow_guests, group_max_attendees, payment_method, reconfirmation_hours FROM event_types WHERE user_id = ?').bind(user.id).all();
      return { data: res.results, description: `Listed ${res.results.length} event types` };
    }

    case 'get_bookings': {
      const filter = input.filter || 'upcoming';
      let query = 'SELECT b.id, b.invitee_name, b.invitee_email, b.start_time, b.end_time, b.status, b.event_type_id, b.guest_emails FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = ?';
      const now = new Date().toISOString();
      if (filter === 'upcoming') query += ` AND b.status IN ('confirmed', 'pending') AND b.start_time > '${now}'`;
      else if (filter === 'past') query += ` AND b.status IN ('confirmed', 'pending') AND b.start_time <= '${now}'`;
      else if (filter === 'cancelled') query += " AND b.status = 'cancelled'";
      query += ' ORDER BY b.start_time LIMIT 20';
      const res = await env.DB.prepare(query).bind(user.id).all();
      return { data: res.results, description: `Listed ${res.results.length} ${filter} bookings` };
    }

    case 'get_availability': {
      const res = await env.DB.prepare('SELECT id, name, timezone, rules, overrides, is_default FROM availability_schedules WHERE user_id = ?').bind(user.id).all();
      const schedules = res.results.map(s => ({
        ...s,
        rules: JSON.parse(s.rules || '[]'),
        overrides: JSON.parse(s.overrides || '[]'),
      }));
      return { data: schedules, description: `Listed ${schedules.length} availability schedules` };
    }

    case 'get_booking_link': {
      const bp = await env.DB.prepare('SELECT slug FROM booking_pages WHERE user_id = ?').bind(user.id).first();
      if (!bp) return { data: { error: 'No booking page found' }, description: 'No booking page' };
      if (input.event_type_id) {
        const et = await env.DB.prepare('SELECT slug, name FROM event_types WHERE id = ? AND user_id = ?').bind(input.event_type_id, user.id).first();
        if (!et) return { data: { error: 'Event type not found' }, description: 'Event type not found' };
        const url = eventTypeBookingUrl(appOrigin, bp.slug, et.slug);
        return { data: { url, event_name: et.name, instruction: 'IMPORTANT: You MUST include this exact URL in your response text so the user can see it.' }, description: `Got booking link for "${et.name}"` };
      }
      const url = bookingPageUrl(appOrigin, bp.slug);
      return { data: { url, instruction: 'IMPORTANT: You MUST include this exact URL in your response text so the user can see it.' }, description: 'Got main booking page URL' };
    }

    case 'create_poll': {
      const res = await handleCreatePoll(
        new Request('https://internal/api/polls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: input.title, description: input.description || null, options: input.options || [] }) }),
        env, user
      );
      const poll = await res.json();
      if (!res.ok) return { data: { error: poll.error || 'Failed to create poll' }, description: 'Create poll failed' };
      const url = `${appOrigin}/poll/?id=${poll.id}`;
      return { data: { id: poll.id, title: poll.title, options: poll.options, url, instruction: 'IMPORTANT: include this poll voting link in your response so the user can share it.' }, description: `Created poll "${poll.title}"` };
    }

    case 'list_polls': {
      const res = await handleListPolls(new Request('https://internal/api/polls'), env, user);
      const polls = await res.json();
      const list = (Array.isArray(polls) ? polls : []).map(p => ({ id: p.id, title: p.title, status: p.status, voter_count: p.voter_count, url: `${appOrigin}/poll/?id=${p.id}` }));
      return { data: list, description: `Listed ${list.length} polls` };
    }

    case 'finalize_poll': {
      const pollPath = `/api/polls/${input.poll_id}/finalize`;
      const res = await handleFinalizePoll(
        new Request('https://internal' + pollPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.option_id ? { option_id: input.option_id } : {}) }),
        env, user, pollPath
      );
      const out = await res.json();
      if (!res.ok) return { data: { error: out.error || 'Failed to finalize poll' }, description: 'Finalize poll failed' };
      return { data: out, description: 'Poll finalized' };
    }

    case 'get_connected_calendars': {
      const res = await env.DB.prepare('SELECT id, provider, email FROM calendar_connections WHERE user_id = ?').bind(user.id).all();
      return { data: res.results, description: `Listed ${res.results.length} connected calendars` };
    }

    case 'get_settings': {
      const bp = await env.DB.prepare('SELECT slug, display_name, bio, brand_color, logo_url, hide_branding, custom_domain FROM booking_pages WHERE user_id = ?').bind(user.id).first();
      return { data: bp || {}, description: 'Got booking page settings' };
    }

    case 'get_analytics': {
      const total = await env.DB.prepare('SELECT COUNT(*) as count FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = ?').bind(user.id).first();
      const thisMonth = await env.DB.prepare("SELECT COUNT(*) as count FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = ? AND b.start_time >= date('now', 'start of month')").bind(user.id).first();
      const cancelled = await env.DB.prepare("SELECT COUNT(*) as count FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = ? AND b.status = 'cancelled'").bind(user.id).first();
      const noShows = await env.DB.prepare("SELECT COUNT(*) as count FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE et.user_id = ? AND b.status = 'no_show'").bind(user.id).first();
      const rate = total.count > 0 ? Math.round((cancelled.count / total.count) * 100) : 0;
      const noShowRate = total.count > 0 ? Math.round((noShows.count / total.count) * 100) : 0;
      return {
        data: { total_bookings: total.count, this_month: thisMonth.count, cancellation_rate: `${rate}%`, no_show_count: noShows.count, no_show_rate: `${noShowRate}%` },
        description: 'Got analytics summary',
      };
    }

    case 'create_event_type': {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const color = input.color || '#2563eb';
      let schedId = input.availability_schedule_id || null;
      if (!schedId) {
        const scheduleRes = await env.DB.prepare('SELECT id FROM availability_schedules WHERE user_id = ? AND is_default = 1').bind(user.id).first();
        schedId = scheduleRes?.id || null;
      }
      const locType = input.location_type || 'google_meet';
      const allowGuests = input.allow_guests === false ? 0 : 1;
      const isSecret = input.is_secret ? 1 : 0;
      let redirectUrl = null;
      if (input.redirect_url) {
        try {
          const parsed = new URL(input.redirect_url);
          if (['http:', 'https:'].includes(parsed.protocol)) {
            redirectUrl = input.redirect_url;
          }
        } catch { /* invalid URL, ignore */ }
      }
      const paymentMethod = input.payment_method || 'stripe';
      const reconfirmationHours = input.reconfirmation_hours || null;
      await env.DB.prepare(
        `INSERT INTO event_types (user_id, name, slug, description, duration_minutes, color, location_type, availability_schedule_id, min_notice_hours, max_future_days, allow_guests, is_secret, redirect_url, payment_method, reconfirmation_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(user.id, input.name, slug, input.description || null, input.duration_minutes, color, locType, schedId, 4, 60, allowGuests, isSecret, redirectUrl, paymentMethod, reconfirmationHours).run();
      return { data: { ok: true, name: input.name, slug, duration_minutes: input.duration_minutes, color, location_type: locType, availability_schedule_id: schedId, allow_guests: !!allowGuests, is_secret: !!isSecret, redirect_url: redirectUrl, payment_method: paymentMethod, reconfirmation_hours: reconfirmationHours }, description: `Created event type "${input.name}"` };
    }

    case 'update_event_type': {
      const et = await env.DB.prepare('SELECT * FROM event_types WHERE id = ? AND user_id = ?').bind(input.event_type_id, user.id).first();
      if (!et) return { data: { error: 'Event type not found' }, description: 'Event type not found' };
      const updates = [];
      const values = [];
      if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name); }
      if (input.duration_minutes !== undefined) { updates.push('duration_minutes = ?'); values.push(input.duration_minutes); }
      if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description); }
      if (input.color !== undefined) { updates.push('color = ?'); values.push(input.color); }
      if (input.is_active !== undefined) { updates.push('is_active = ?'); values.push(input.is_active ? 1 : 0); }
      if (input.availability_schedule_id !== undefined) { updates.push('availability_schedule_id = ?'); values.push(input.availability_schedule_id); }
      if (input.location_type !== undefined) { updates.push('location_type = ?'); values.push(input.location_type); }
      if (input.buffer_before !== undefined) { updates.push('buffer_before = ?'); values.push(input.buffer_before); }
      if (input.buffer_after !== undefined) { updates.push('buffer_after = ?'); values.push(input.buffer_after); }
      if (input.min_notice_hours !== undefined) { updates.push('min_notice_hours = ?'); values.push(input.min_notice_hours); }
      if (input.max_bookings_per_day !== undefined) { updates.push('max_bookings_per_day = ?'); values.push(input.max_bookings_per_day || null); }
      if (input.allow_guests !== undefined) { updates.push('allow_guests = ?'); values.push(input.allow_guests ? 1 : 0); }
      if (input.is_secret !== undefined) { updates.push('is_secret = ?'); values.push(input.is_secret ? 1 : 0); }
      if (input.redirect_url !== undefined) {
        if (input.redirect_url === '' || input.redirect_url === null) {
          updates.push('redirect_url = ?'); values.push(null);
        } else {
          try {
            const parsed = new URL(input.redirect_url);
            if (['http:', 'https:'].includes(parsed.protocol)) {
              updates.push('redirect_url = ?'); values.push(input.redirect_url);
            }
          } catch { /* invalid URL, skip */ }
        }
      }
      if (input.payment_method !== undefined) { updates.push('payment_method = ?'); values.push(input.payment_method); }
      if (input.reconfirmation_hours !== undefined) { updates.push('reconfirmation_hours = ?'); values.push(input.reconfirmation_hours || null); }
      // Slug is NOT auto-derived from the name here — only changes if the caller
      // passes an explicit slug. Validate uniqueness within the user's event types.
      if (input.slug !== undefined) {
        const newSlug = generateSlug(input.slug);
        if (!newSlug) return { data: { error: 'Slug cannot be empty.' }, description: 'Invalid slug' };
        const clash = await env.DB.prepare('SELECT id FROM event_types WHERE user_id = ? AND slug = ? AND id != ?').bind(user.id, newSlug, input.event_type_id).first();
        if (clash) return { data: { error: `The slug "${newSlug}" is already used by another of your event types. Choose a different one.` }, description: 'Slug already in use' };
        updates.push('slug = ?'); values.push(newSlug);
      }
      if (updates.length === 0) return { data: { ok: true, message: 'No changes' }, description: 'No changes to event type' };
      updates.push("updated_at = datetime('now')");
      await env.DB.prepare(`UPDATE event_types SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, input.event_type_id, user.id).run();
      // Return the ACTUAL row so the model reports real state, never assumed changes
      // (e.g. it must not claim the slug changed unless this row shows it did).
      const updatedEt = await env.DB.prepare('SELECT name, slug, duration_minutes, location_type, is_active FROM event_types WHERE id = ? AND user_id = ?').bind(input.event_type_id, user.id).first();
      return { data: { ok: true, event_type: updatedEt }, description: `Updated event type "${updatedEt?.name || et.name}" (slug: ${updatedEt?.slug})` };
    }

    case 'delete_event_type': {
      const et = await env.DB.prepare('SELECT name FROM event_types WHERE id = ? AND user_id = ?').bind(input.event_type_id, user.id).first();
      if (!et) return { data: { error: 'Event type not found' }, description: 'Event type not found' };
      await env.DB.prepare('DELETE FROM event_types WHERE id = ? AND user_id = ?').bind(input.event_type_id, user.id).run();
      return { data: { ok: true, deleted: et.name }, description: `Deleted event type "${et.name}"` };
    }

    case 'cancel_booking': {
      const booking = await env.DB.prepare('SELECT b.id, b.invitee_name, b.start_time, b.status FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?').bind(input.booking_id, user.id).first();
      if (!booking) return { data: { error: 'Booking not found' }, description: 'Booking not found' };
      if (booking.status === 'cancelled') return { data: { error: 'Already cancelled' }, description: 'Booking already cancelled' };
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(input.booking_id).run();
      return { data: { ok: true, cancelled: booking.invitee_name, time: booking.start_time }, description: `Cancelled booking with ${booking.invitee_name}` };
    }

    case 'mark_no_show': {
      const booking = await env.DB.prepare('SELECT b.id, b.invitee_name, b.start_time, b.status FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?').bind(input.booking_id, user.id).first();
      if (!booking) return { data: { error: 'Booking not found' }, description: 'Booking not found' };
      if (booking.status === 'cancelled') return { data: { error: 'Cannot mark a cancelled booking as no-show' }, description: 'Booking is cancelled' };
      if (booking.status === 'no_show') return { data: { error: 'Already marked as no-show' }, description: 'Booking already marked as no-show' };
      const startTime = new Date(booking.start_time + (booking.start_time.includes('Z') ? '' : 'Z'));
      if (startTime > new Date()) return { data: { error: 'Cannot mark a future booking as no-show' }, description: 'Booking is in the future' };
      await env.DB.prepare("UPDATE bookings SET status = 'no_show', updated_at = datetime('now') WHERE id = ?").bind(input.booking_id).run();
      return { data: { ok: true, marked: booking.invitee_name, time: booking.start_time }, description: `Marked booking with ${booking.invitee_name} as no-show` };
    }

    case 'add_booking_notes': {
      const booking = await env.DB.prepare('SELECT b.id, b.invitee_name FROM bookings b JOIN event_types et ON b.event_type_id = et.id WHERE b.id = ? AND et.user_id = ?').bind(input.booking_id, user.id).first();
      if (!booking) return { data: { error: 'Booking not found' }, description: 'Booking not found' };
      const notes = (input.notes || '').trim() || null;
      await env.DB.prepare("UPDATE bookings SET notes = ?, updated_at = datetime('now') WHERE id = ?").bind(notes, input.booking_id).run();
      return { data: { ok: true, booking_id: input.booking_id, notes }, description: `${notes ? 'Updated' : 'Cleared'} notes on booking with ${booking.invitee_name}` };
    }

    case 'update_settings': {
      const bp = await env.DB.prepare('SELECT * FROM booking_pages WHERE user_id = ?').bind(user.id).first();
      if (!bp) return { data: { error: 'No booking page found' }, description: 'No booking page' };
      const updates = [];
      const values = [];
      if (input.display_name !== undefined) { updates.push('display_name = ?'); values.push(input.display_name); }
      if (input.slug !== undefined) { updates.push('slug = ?'); values.push(input.slug); }
      if (input.bio !== undefined) { updates.push('bio = ?'); values.push(input.bio); }
      if (input.brand_color !== undefined) { updates.push('brand_color = ?'); values.push(input.brand_color); }
      if (input.cancellation_policy !== undefined) { updates.push('cancellation_policy = ?'); values.push(input.cancellation_policy || null); }
      if (input.blocked_emails !== undefined) { updates.push('blocked_emails = ?'); values.push(input.blocked_emails || null); }
      if (updates.length === 0) return { data: { ok: true, message: 'No changes' }, description: 'No changes to settings' };
      updates.push("updated_at = datetime('now')");
      await env.DB.prepare(`UPDATE booking_pages SET ${updates.join(', ')} WHERE user_id = ?`).bind(...values, user.id).run();
      return { data: { ok: true, updated: Object.keys(input) }, description: `Updated settings: ${Object.keys(input).join(', ')}` };
    }

    case 'delete_account': {
      // Same atomic, complete deletion as the REST handler.
      await deleteAllUserData(env, user.id);
      return { data: { ok: true, action: 'redirect', url: '/auth/login.html?deleted=1' }, description: 'Account deleted permanently' };
    }

    case 'create_availability_schedule': {
      const tz = input.timezone || 'America/Los_Angeles';
      const rules = JSON.stringify(input.rules || []);
      const result = await env.DB.prepare(
        "INSERT INTO availability_schedules (user_id, name, timezone, rules, is_default) VALUES (?, ?, ?, ?, 0) RETURNING id"
      ).bind(user.id, input.name, tz, rules).first();
      return { data: { ok: true, id: result.id, name: input.name, timezone: tz }, description: `Created schedule "${input.name}"` };
    }

    case 'update_availability_schedule': {
      const sched = await env.DB.prepare('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?').bind(input.schedule_id, user.id).first();
      if (!sched) return { data: { error: 'Schedule not found' }, description: 'Schedule not found' };
      const updates = [];
      const values = [];
      if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name); }
      if (input.rules !== undefined) { updates.push('rules = ?'); values.push(JSON.stringify(input.rules)); }
      if (updates.length === 0) return { data: { ok: true, message: 'No changes' }, description: 'No changes' };
      updates.push("updated_at = datetime('now')");
      await env.DB.prepare(`UPDATE availability_schedules SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, input.schedule_id, user.id).run();
      return { data: { ok: true }, description: `Updated schedule "${sched.name}"` };
    }

    case 'delete_availability_schedule': {
      const sched = await env.DB.prepare('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?').bind(input.schedule_id, user.id).first();
      if (!sched) return { data: { error: 'Schedule not found' }, description: 'Schedule not found' };
      if (sched.is_default) return { data: { error: 'Cannot delete the default schedule' }, description: 'Cannot delete default schedule' };
      await env.DB.prepare('UPDATE event_types SET availability_schedule_id = NULL WHERE availability_schedule_id = ? AND user_id = ?').bind(input.schedule_id, user.id).run();
      await env.DB.prepare('DELETE FROM availability_schedules WHERE id = ? AND user_id = ?').bind(input.schedule_id, user.id).run();
      return { data: { ok: true }, description: `Deleted schedule "${sched.name}"` };
    }

    case 'update_date_overrides': {
      const sched = await env.DB.prepare('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?').bind(input.schedule_id, user.id).first();
      if (!sched) return { data: { error: 'Schedule not found' }, description: 'Schedule not found' };
      if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        return { data: { error: 'Date must be in YYYY-MM-DD format' }, description: 'Invalid date format' };
      }
      const overrides = JSON.parse(sched.overrides || '[]');
      if (input.action === 'remove') {
        const filtered = overrides.filter(o => o.date !== input.date);
        if (filtered.length === overrides.length) {
          return { data: { error: `No override found for ${input.date}` }, description: 'Override not found' };
        }
        await env.DB.prepare("UPDATE availability_schedules SET overrides = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(filtered), input.schedule_id, user.id).run();
        return { data: { ok: true, date: input.date, overrides: filtered }, description: `Removed override for ${input.date}` };
      }
      // action === 'add'
      const existing = overrides.findIndex(o => o.date === input.date);
      const available = input.available !== undefined ? input.available : false;
      let newOverride;
      if (available && input.start && input.end) {
        if (!/^\d{2}:\d{2}$/.test(input.start) || !/^\d{2}:\d{2}$/.test(input.end)) {
          return { data: { error: 'Start/end must be in HH:MM format' }, description: 'Invalid time format' };
        }
        if (input.start >= input.end) {
          return { data: { error: 'Start must be before end' }, description: 'Invalid time range' };
        }
        newOverride = { date: input.date, available: true, start: input.start, end: input.end };
      } else {
        newOverride = { date: input.date, available: false };
      }
      if (existing >= 0) {
        overrides[existing] = newOverride;
      } else {
        overrides.push(newOverride);
      }
      await env.DB.prepare("UPDATE availability_schedules SET overrides = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(overrides), input.schedule_id, user.id).run();
      const desc = newOverride.available ? `Set custom hours ${input.start}-${input.end} on ${input.date}` : `Blocked ${input.date}`;
      return { data: { ok: true, override: newOverride, overrides }, description: desc };
    }

    case 'update_holidays': {
      const sched = await env.DB.prepare('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?').bind(input.schedule_id, user.id).first();
      if (!sched) return { data: { error: 'Schedule not found' }, description: 'Schedule not found' };
      const holidays = JSON.parse(sched.holidays || '[]');

      if (input.action === 'load_preset') {
        const country = (input.country || 'US').toUpperCase();
        const year = input.year || new Date().getFullYear();
        const presets = await getHolidayPresets(country, year);
        let added = 0;
        for (const preset of presets) {
          const exists = holidays.some(h => h.date === preset.date);
          if (!exists) {
            holidays.push({ date: preset.date, name: preset.name, enabled: true });
            added++;
          }
        }
        await env.DB.prepare("UPDATE availability_schedules SET holidays = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(holidays), input.schedule_id, user.id).run();
        return { data: { ok: true, country, year, added, total: holidays.length, holidays }, description: `Loaded ${country} ${year} holidays (${added} new, ${holidays.length} total)` };
      }

      if (input.action === 'add') {
        if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          return { data: { error: 'Date must be in YYYY-MM-DD format' }, description: 'Invalid date format' };
        }
        const name = input.name || 'Holiday';
        const exists = holidays.some(h => h.date === input.date);
        if (exists) return { data: { error: `Holiday already exists for ${input.date}` }, description: 'Holiday already exists' };
        holidays.push({ date: input.date, name, enabled: true });
        await env.DB.prepare("UPDATE availability_schedules SET holidays = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(holidays), input.schedule_id, user.id).run();
        return { data: { ok: true, holiday: { date: input.date, name, enabled: true }, holidays }, description: `Added holiday "${name}" on ${input.date}` };
      }

      if (input.action === 'remove') {
        if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          return { data: { error: 'Date must be in YYYY-MM-DD format' }, description: 'Invalid date format' };
        }
        const filtered = holidays.filter(h => h.date !== input.date);
        if (filtered.length === holidays.length) {
          return { data: { error: `No holiday found for ${input.date}` }, description: 'Holiday not found' };
        }
        await env.DB.prepare("UPDATE availability_schedules SET holidays = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(filtered), input.schedule_id, user.id).run();
        return { data: { ok: true, date: input.date, holidays: filtered }, description: `Removed holiday on ${input.date}` };
      }

      if (input.action === 'toggle') {
        if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          return { data: { error: 'Date must be in YYYY-MM-DD format' }, description: 'Invalid date format' };
        }
        const idx = holidays.findIndex(h => h.date === input.date);
        if (idx < 0) return { data: { error: `No holiday found for ${input.date}` }, description: 'Holiday not found' };
        holidays[idx].enabled = input.enabled !== undefined ? input.enabled : !holidays[idx].enabled;
        await env.DB.prepare("UPDATE availability_schedules SET holidays = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(holidays), input.schedule_id, user.id).run();
        return { data: { ok: true, holiday: holidays[idx], holidays }, description: `${holidays[idx].enabled ? 'Enabled' : 'Disabled'} holiday "${holidays[idx].name}" on ${input.date}` };
      }

      return { data: { error: 'Invalid action. Use load_preset, add, remove, or toggle.' }, description: 'Invalid action' };
    }

    case 'set_meeting_limits': {
      const sched = await env.DB.prepare('SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?').bind(input.schedule_id, user.id).first();
      if (!sched) return { data: { error: 'Schedule not found' }, description: 'Schedule not found' };
      const limits = input.limits || [];
      if (!Array.isArray(limits)) return { data: { error: 'Limits must be an array' }, description: 'Invalid limits' };
      for (const limit of limits) {
        if (!limit.type || !['daily', 'weekly'].includes(limit.type)) {
          return { data: { error: 'Each limit must have type "daily" or "weekly"' }, description: 'Invalid limit type' };
        }
        if (!Number.isInteger(limit.max) || limit.max < 1) {
          return { data: { error: 'Each limit must have a positive integer max' }, description: 'Invalid limit max' };
        }
      }
      await env.DB.prepare("UPDATE availability_schedules SET meeting_limits = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(limits), input.schedule_id, user.id).run();
      const desc = limits.length === 0 ? 'Cleared meeting limits' : `Set ${limits.map(l => `${l.type}: ${l.max}`).join(', ')}`;
      return { data: { ok: true, meeting_limits: limits }, description: desc };
    }

    case 'update_calendar_settings': {
      const conn = await env.DB.prepare('SELECT id, provider, email, is_primary, check_conflicts, write_events FROM calendar_connections WHERE id = ? AND user_id = ?').bind(input.calendar_id, user.id).first();
      if (!conn) return { data: { error: 'Calendar connection not found' }, description: 'Calendar not found' };
      const results = [];

      if (input.set_primary) {
        await env.DB.prepare("UPDATE calendar_connections SET is_primary = 0, write_events = 0 WHERE user_id = ?").bind(user.id).run();
        await env.DB.prepare("UPDATE calendar_connections SET is_primary = 1, write_events = 1 WHERE id = ? AND user_id = ?").bind(input.calendar_id, user.id).run();
        results.push('Set as primary calendar');
      }

      if (input.check_conflicts !== undefined || input.write_events !== undefined) {
        const updates = [];
        const values = [];
        if (input.check_conflicts !== undefined) { updates.push('check_conflicts = ?'); values.push(input.check_conflicts ? 1 : 0); }
        if (input.write_events !== undefined) { updates.push('write_events = ?'); values.push(input.write_events ? 1 : 0); }
        updates.push("updated_at = datetime('now')");
        await env.DB.prepare(`UPDATE calendar_connections SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, input.calendar_id, user.id).run();
        if (input.check_conflicts !== undefined) results.push(`Conflict checking ${input.check_conflicts ? 'enabled' : 'disabled'}`);
        if (input.write_events !== undefined) results.push(`Event writing ${input.write_events ? 'enabled' : 'disabled'}`);
      }

      if (results.length === 0) return { data: { ok: true, message: 'No changes' }, description: 'No calendar changes' };

      const updated = await env.DB.prepare('SELECT id, provider, email, is_primary, check_conflicts, write_events FROM calendar_connections WHERE id = ? AND user_id = ?').bind(input.calendar_id, user.id).first();
      return { data: { ok: true, calendar: updated }, description: `Updated ${conn.email}: ${results.join(', ')}` };
    }

    case 'upgrade_to_pro': {
      if (isPro(user)) return { data: { error: 'Already on Pro plan' }, description: 'Already on Pro' };
      try {
        let customerId = user.stripe_customer_id;
        if (!customerId) {
          customerId = await createStripeCustomer(env, user);
          await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(customerId, user.id).run();
        }
        const checkoutUrl = await createSubscriptionCheckout(env, {
          customerId,
          successUrl: `${appOrigin}/dashboard/?upgrade=success`,
          cancelUrl: `${appOrigin}/dashboard/?upgrade=cancelled`,
        });
        return { data: { action: 'redirect', url: checkoutUrl }, description: checkoutUrl };
      } catch (err) {
        return { data: { error: err.message }, description: 'Failed to create checkout' };
      }
    }

    case 'submit_feedback': {
      const validCategories = ['feedback', 'bug', 'feature_request'];
      const cat = validCategories.includes(input.category) ? input.category : 'feedback';
      const msg = (input.message || '').trim();
      if (!msg) return { data: { error: 'Message is required' }, description: 'No message provided' };
      if (msg.length > 5000) return { data: { error: 'Message too long (max 5000 chars)' }, description: 'Message too long' };
      await env.DB.prepare(
        'INSERT INTO feedback (user_id, category, message) VALUES (?, ?, ?)'
      ).bind(user.id, cat, msg).run();
      const categoryLabel = { feedback: 'feedback', bug: 'bug report', feature_request: 'feature request' }[cat];
      return { data: { ok: true, category: cat }, description: `Submitted ${categoryLabel}` };
    }

    case 'navigate_to': {
      return { data: { action: 'navigate', tab: input.tab }, description: input.tab };
    }

    case 'copy_to_clipboard': {
      return { data: { action: 'copy', text: input.text }, description: input.text };
    }

    case 'start_product_tour': {
      return { data: { action: 'start_tour' }, description: 'Starting the product tour' };
    }

    case 'connect_zoom': {
      if (!isZoomOAuthConfigured(env)) {
        return { data: { error: 'Zoom integration is not configured on this server yet.' }, description: 'Zoom not configured' };
      }
      return { data: { action: 'connect_zoom' }, description: 'Opening Zoom connection' };
    }

    case 'trigger_password_reset': {
      const email = (input.email || '').trim().toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        return { data: { error: 'A valid email address is required' }, description: 'Invalid email' };
      }
      // Call the forgot-password endpoint internally
      const resetRequest = new Request(`${appOrigin}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const resetResponse = await handleForgotPassword(resetRequest, env, new URL(`${appOrigin}/api/auth/forgot-password`));
      return { data: { ok: true, message: 'If an account exists with this email, a password reset link has been sent.' }, description: `Triggered password reset for ${email}` };
    }

    case 'get_embed_code': {
      const bp = await env.DB.prepare('SELECT slug FROM booking_pages WHERE user_id = ?').bind(user.id).first();
      if (!bp) return { data: { error: 'No booking page found' }, description: 'No booking page' };
      const bookingUrl = bookingPageUrl(appOrigin, bp.slug);
      const mode = input.mode || 'inline';
      let code;
      if (mode === 'popup') {
        code = `<div id="calendo-popup" data-url="${bookingUrl}" data-mode="popup" data-text="Book a Meeting"></div>\n<script src="${appOrigin}/embed/calendo-embed.js"><\/script>`;
      } else if (mode === 'badge') {
        code = `<script src="${appOrigin}/embed.js" data-calendo-user="${bp.slug}" data-calendo-mode="badge"><\/script>`;
      } else {
        code = `<div id="calendo-inline" data-url="${bookingUrl}" data-mode="inline" data-height="700px"></div>\n<script src="${appOrigin}/embed/calendo-embed.js"><\/script>`;
      }
      return { data: { mode, code, instruction: 'IMPORTANT: You MUST include this embed code in your response so the user can copy it.' }, description: `Generated ${mode} embed code` };
    }

    case 'get_audit_log': {
      const limit = Math.min(input.limit || 20, 50);
      let whereClause = 'WHERE user_id = ?';
      const bindArgs = [user.id];
      if (input.action) {
        whereClause += ' AND action = ?';
        bindArgs.push(input.action);
      }
      const res = await env.DB.prepare(
        `SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT ?`
      ).bind(...bindArgs, limit).all();
      return { data: res.results || [], description: `Retrieved ${(res.results || []).length} audit log entries` };
    }

    case 'get_team_page_url': {
      const orgs = await env.DB.prepare(
        `SELECT o.id, o.name, o.slug
         FROM organizations o
         JOIN org_members om ON o.id = om.org_id
         WHERE om.user_id = ?`
      ).bind(user.id).all();
      const orgList = orgs.results || [];
      if (orgList.length === 0) {
        return { data: { error: 'You are not a member of any organization' }, description: 'No organizations found' };
      }
      const urls = orgList.map(org => ({
        name: org.name,
        slug: org.slug,
        url: `${appOrigin}/team/?org=${org.slug}`,
      }));
      return { data: { organizations: urls, instruction: 'IMPORTANT: You MUST include these URLs in your response text so the user can see them.' }, description: `Found ${urls.length} team page(s)` };
    }

    case 'manage_tracking': {
      const bp = await env.DB.prepare('SELECT ga_measurement_id, meta_pixel_id FROM booking_pages WHERE user_id = ?').bind(user.id).first();
      if (!bp) return { data: { error: 'No booking page found' }, description: 'No booking page' };
      if (input.action === 'get') {
        return { data: { ga_measurement_id: bp.ga_measurement_id || null, meta_pixel_id: bp.meta_pixel_id || null }, description: 'Got tracking settings' };
      }
      // action === 'set'
      const updates = [];
      const values = [];
      if (input.ga_measurement_id !== undefined) {
        updates.push('ga_measurement_id = ?');
        values.push(input.ga_measurement_id || null);
      }
      if (input.meta_pixel_id !== undefined) {
        updates.push('meta_pixel_id = ?');
        values.push(input.meta_pixel_id || null);
      }
      if (updates.length === 0) return { data: { ok: true, message: 'No changes' }, description: 'No tracking changes' };
      updates.push("updated_at = datetime('now')");
      await env.DB.prepare(`UPDATE booking_pages SET ${updates.join(', ')} WHERE user_id = ?`).bind(...values, user.id).run();
      return { data: { ok: true, ga_measurement_id: input.ga_measurement_id !== undefined ? (input.ga_measurement_id || null) : bp.ga_measurement_id, meta_pixel_id: input.meta_pixel_id !== undefined ? (input.meta_pixel_id || null) : bp.meta_pixel_id }, description: 'Updated tracking settings' };
    }

    case 'manage_slack': {
      if (input.action === 'get') {
        const u = await env.DB.prepare('SELECT slack_webhook_url FROM users WHERE id = ?').bind(user.id).first();
        return { data: { slack_webhook_url: u?.slack_webhook_url || null, configured: !!u?.slack_webhook_url }, description: 'Got Slack settings' };
      }
      if (input.action === 'remove') {
        await env.DB.prepare("UPDATE users SET slack_webhook_url = NULL, updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
        return { data: { ok: true, slack_webhook_url: null }, description: 'Removed Slack webhook' };
      }
      if (input.action === 'test') {
        const u = await env.DB.prepare('SELECT slack_webhook_url FROM users WHERE id = ?').bind(user.id).first();
        if (!u?.slack_webhook_url) return { data: { error: 'No Slack webhook URL configured' }, description: 'No Slack webhook' };
        try {
          const testPayload = { blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Calendo Connected!', emoji: true } }, { type: 'section', text: { type: 'mrkdwn', text: 'Your Slack webhook is working.' } }] };
          const resp = await fetch(u.slack_webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(testPayload) });
          if (!resp.ok) return { data: { error: `Slack returned ${resp.status}` }, description: 'Slack test failed' };
          return { data: { ok: true, message: 'Test message sent to Slack' }, description: 'Slack test sent' };
        } catch (err) {
          return { data: { error: `Failed to reach Slack: ${err.message}` }, description: 'Slack test failed' };
        }
      }
      // action === 'set'
      if (!input.webhook_url) return { data: { error: 'webhook_url is required' }, description: 'Missing webhook URL' };
      if (!input.webhook_url.startsWith('https://hooks.slack.com/')) {
        return { data: { error: 'Invalid Slack webhook URL. Must start with https://hooks.slack.com/' }, description: 'Invalid Slack URL' };
      }
      await env.DB.prepare("UPDATE users SET slack_webhook_url = ?, updated_at = datetime('now') WHERE id = ?").bind(input.webhook_url, user.id).run();
      return { data: { ok: true, slack_webhook_url: input.webhook_url }, description: 'Set Slack webhook URL' };
    }

    case 'manage_paypal': {
      if (input.action === 'get') {
        const u = await env.DB.prepare('SELECT paypal_client_id_encrypted, paypal_mode FROM users WHERE id = ?').bind(user.id).first();
        return { data: { has_paypal: !!u?.paypal_client_id_encrypted, mode: u?.paypal_mode || 'sandbox' }, description: 'Got PayPal status' };
      }
      if (input.action === 'remove') {
        await env.DB.prepare("UPDATE users SET paypal_client_id_encrypted = NULL, paypal_client_secret_encrypted = NULL, paypal_mode = 'sandbox', updated_at = datetime('now') WHERE id = ?").bind(user.id).run();
        return { data: { ok: true, has_paypal: false }, description: 'Removed PayPal credentials' };
      }
      // action === 'set'
      if (!input.client_id || !input.client_secret) {
        return { data: { error: 'client_id and client_secret are required' }, description: 'Missing PayPal credentials' };
      }
      const mode = input.mode || 'sandbox';
      const encryptedId = await encryptToken(input.client_id, env.ENCRYPTION_KEY);
      const encryptedSecret = await encryptToken(input.client_secret, env.ENCRYPTION_KEY);
      await env.DB.prepare(
        "UPDATE users SET paypal_client_id_encrypted = ?, paypal_client_secret_encrypted = ?, paypal_mode = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(encryptedId, encryptedSecret, mode, user.id).run();
      return { data: { ok: true, has_paypal: true, mode }, description: 'Saved PayPal credentials' };
    }

    case 'resend_verification': {
      if (user.email_verified) {
        return { data: { error: 'Email is already verified' }, description: 'Email already verified' };
      }
      // Invalidate existing tokens
      await env.DB.prepare('UPDATE email_verification_tokens SET used = 1 WHERE user_id = ? AND used = 0').bind(user.id).run();
      // Generate new token
      const token = crypto.randomUUID();
      const expiresAt = formatDbTimestamp(Date.now() + 24 * 60 * 60 * 1000);
      await env.DB.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').bind(user.id, token, expiresAt).run();
      // Send verification email
      const verifyUrl = `${appOrigin}/api/auth/verify-email?token=${token}`;
      const emailData = verificationEmail(verifyUrl);
      await sendEmail(env, { to: user.email, subject: emailData.subject, html: emailData.html, text: emailData.text, type: 'verification' });
      return { data: { ok: true, message: 'Verification email sent' }, description: 'Sent verification email' };
    }

    default:
      return { data: { error: 'Unknown tool' }, description: 'Unknown tool' };
  }
}
