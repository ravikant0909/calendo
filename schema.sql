-- Schema for Calendo database
-- Run this in Cloudflare D1 console
-- Database: calendo

-- ============================================
-- SCHEMA VERSION TRACKING
-- ============================================

-- Track schema migrations for safe upgrades
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema');

-- ============================================
-- USERS & AUTHENTICATION
-- ============================================

-- Registered Calendo users (hosts who create event types)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    timezone TEXT DEFAULT 'America/Los_Angeles',
    locale TEXT DEFAULT 'en',
    email_verified INTEGER DEFAULT 0,
    slack_webhook_url TEXT,
    ai_api_key_encrypted TEXT,
    paypal_client_id_encrypted TEXT,
    paypal_client_secret_encrypted TEXT,
    paypal_mode TEXT NOT NULL DEFAULT 'sandbox',
    onboarding_completed INTEGER DEFAULT 0,
    schedule_setup_dismissed INTEGER DEFAULT 0,
    product_tour_completed INTEGER DEFAULT 0,
    ai_session_id TEXT,
    ai_chat_history TEXT,
    checklist_state TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);

-- Session tokens for authenticated users
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                    -- UUID session token
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,             -- opaque bearer token
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Password reset tokens for forgot-password flow
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

-- API keys for programmatic access
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,                     -- user-provided label, e.g. "Zapier integration"
    key_hash TEXT NOT NULL UNIQUE,          -- SHA-256 hash of the actual key
    key_prefix TEXT,                        -- first 8 chars for identification, e.g. "cal_live_"
    scopes TEXT DEFAULT '["read"]',         -- JSON array of allowed scopes
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,                        -- NULL means never expires
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ============================================
-- ORGANIZATIONS & TEAMS
-- ============================================

-- Organizations allow team-based scheduling (shared event types, round-robin, etc.)
CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,              -- URL-friendly identifier, e.g. "acme-corp"
    logo_url TEXT,
    owner_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_id);

-- Organization membership with roles
CREATE TABLE IF NOT EXISTS org_members (
    org_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',    -- 'owner', 'admin', 'member'
    round_robin_weight INTEGER NOT NULL DEFAULT 1,  -- higher = more bookings
    round_robin_skip INTEGER NOT NULL DEFAULT 0,    -- 1 = skip in rotation
    round_robin_max_daily INTEGER,                  -- daily cap per member
    can_edit_event_types INTEGER NOT NULL DEFAULT 0, -- editor permission
    can_manage_bookings INTEGER NOT NULL DEFAULT 0,  -- manager permission
    can_view_analytics INTEGER NOT NULL DEFAULT 1,   -- viewer permission (default on)
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, user_id),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

-- Pending invitations for users not yet on the platform
CREATE TABLE IF NOT EXISTS org_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',    -- role to assign on acceptance
    invited_by INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,             -- acceptance token
    accepted_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON org_invitations(email);
CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token);
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON org_invitations(org_id);

-- ============================================
-- BOOKING PAGES (user's public profile)
-- ============================================

-- The public-facing page where invitees see a user's event types
-- e.g. calendo.com/jane or custom-domain.com
CREATE TABLE IF NOT EXISTS booking_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    slug TEXT NOT NULL UNIQUE,              -- URL path, e.g. "jane-smith"
    display_name TEXT NOT NULL,
    bio TEXT,
    avatar_url TEXT,
    brand_color TEXT DEFAULT '#0069ff',
    custom_css TEXT,
    custom_domain TEXT,                     -- e.g. "book.example.com"
    welcome_message TEXT,
    logo_url TEXT,                          -- custom logo for booking page
    hide_branding INTEGER DEFAULT 0,       -- hide "Powered by Calendo" badge
    cancellation_policy TEXT,              -- custom cancellation policy text shown on booking/cancel pages
    blocked_emails TEXT,                   -- newline-separated list of blocked emails/domains (e.g. "spam@x.com\n@baddomain.com")
    ga_measurement_id TEXT,                -- Google Analytics 4 Measurement ID (e.g. "G-XXXXXXXXXX")
    meta_pixel_id TEXT,                    -- Meta (Facebook) Pixel ID for conversion tracking
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_pages_slug ON booking_pages(slug);
CREATE INDEX IF NOT EXISTS idx_booking_pages_user ON booking_pages(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_pages_domain ON booking_pages(custom_domain);

-- Branding columns (added via ALTER for existing databases)
-- booking_pages.logo_url TEXT
-- booking_pages.hide_branding INTEGER DEFAULT 0
-- booking_pages.cancellation_policy TEXT
-- booking_pages.blocked_emails TEXT
-- booking_pages.ga_measurement_id TEXT
-- booking_pages.meta_pixel_id TEXT

-- ============================================
-- AVAILABILITY SCHEDULES
-- ============================================

-- Reusable availability templates (a user can have multiple: "Work Hours", "Office Hours", etc.)
CREATE TABLE IF NOT EXISTS availability_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,                     -- e.g. "Work Hours", "Evening Consulting"
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    -- JSON array of weekly rules:
    -- [{"day": 1, "start": "09:00", "end": "17:00"}, {"day": 1, "start": "18:00", "end": "20:00"}, ...]
    -- day: 0=Sunday, 1=Monday, ..., 6=Saturday
    rules TEXT NOT NULL DEFAULT '[]',
    -- JSON array of date-specific overrides:
    -- [{"date": "2026-03-15", "available": false}, {"date": "2026-03-20", "start": "10:00", "end": "14:00"}]
    overrides TEXT NOT NULL DEFAULT '[]',
    -- JSON array of holiday entries to auto-block:
    -- [{"date": "2026-12-25", "name": "Christmas Day"}, ...]
    holidays TEXT NOT NULL DEFAULT '[]',
    -- JSON array of meeting limits:
    -- [{"type": "daily", "max": 5}, {"type": "weekly", "max": 20}]
    meeting_limits TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER DEFAULT 0,           -- 1 if this is the user's default schedule
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_availability_user ON availability_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_availability_default ON availability_schedules(user_id, is_default);

-- ============================================
-- EVENT TYPES
-- ============================================

-- Configurable meeting templates that invitees book
-- e.g. "30-Minute Call", "Product Demo", "Coffee Chat"
CREATE TABLE IF NOT EXISTS event_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    org_id INTEGER,                         -- NULL for personal event types
    name TEXT NOT NULL,                     -- "30-Minute Meeting"
    slug TEXT NOT NULL,                     -- "30-minute-meeting" (unique per user)
    description TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    color TEXT DEFAULT '#0069ff',

    -- Location
    location_type TEXT DEFAULT 'google_meet', -- 'google_meet', 'zoom', 'phone', 'in_person', 'custom'
    location_config TEXT DEFAULT '{}',       -- JSON with type-specific config (address, phone number, etc.)

    -- Custom questions asked during booking
    -- JSON array: [{"id":"q1","label":"What topics?","type":"text","required":true}, ...]
    questions TEXT DEFAULT '[]',

    -- Visibility & status
    is_active INTEGER DEFAULT 1,            -- 0 to disable without deleting
    is_secret INTEGER DEFAULT 0,            -- 1 = only accessible via direct link, hidden from booking page

    -- Booking rules
    requires_confirmation INTEGER DEFAULT 0, -- 1 = host must manually confirm each booking
    max_bookings_per_day INTEGER,            -- NULL = unlimited
    slot_interval INTEGER DEFAULT 15,        -- minutes between slot start times (5, 10, 15, 20, 30, 60)
    buffer_before INTEGER DEFAULT 0,         -- minutes of buffer before this meeting
    buffer_after INTEGER DEFAULT 0,          -- minutes of buffer after this meeting
    min_notice_hours INTEGER DEFAULT 4,      -- minimum hours in advance to book
    max_future_days INTEGER DEFAULT 60,      -- how far ahead invitees can book

    -- Linked availability schedule
    availability_schedule_id INTEGER,

    -- Team scheduling mode (NULL for personal, 'round-robin', 'collective')
    round_robin_mode TEXT,

    -- Paid bookings (Stripe or PayPal)
    price_cents INTEGER,                    -- price in smallest currency unit (NULL or 0 = free)
    currency TEXT DEFAULT 'usd',            -- ISO 4217 currency code
    payment_method TEXT NOT NULL DEFAULT 'stripe', -- 'stripe' or 'paypal'

    -- Group events
    sort_order INTEGER DEFAULT 0,           -- display order on booking page
    group_max_attendees INTEGER,            -- NULL = individual (1:1), >1 = group event with max attendees per slot
    locked_timezone TEXT,                  -- NULL = invitee chooses, set = force this timezone
    reminder_settings TEXT NOT NULL DEFAULT '{"email_24h":true,"email_1h":true,"sms_24h":false,"sms_1h":false}',

    -- Post-booking redirect URL (NULL = show default confirmation page)
    redirect_url TEXT,

    -- Guest settings
    allow_guests INTEGER NOT NULL DEFAULT 1, -- 1 = invitees can add guests when booking

    -- Reconfirmation: send email N hours before asking invitee to confirm attendance
    reconfirmation_hours INTEGER,            -- NULL = disabled, e.g. 24 or 48

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL,
    FOREIGN KEY (availability_schedule_id) REFERENCES availability_schedules(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_event_types_user ON event_types(user_id);
CREATE INDEX IF NOT EXISTS idx_event_types_org ON event_types(org_id);
CREATE INDEX IF NOT EXISTS idx_event_types_slug ON event_types(user_id, slug);
CREATE INDEX IF NOT EXISTS idx_event_types_active ON event_types(is_active);

-- ============================================
-- BOOKINGS
-- ============================================

-- Actual scheduled meetings between host and invitee
CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type_id INTEGER NOT NULL,
    uid TEXT NOT NULL UNIQUE,               -- public unique ID for URLs (e.g. UUID or nanoid)
    invitee_email TEXT NOT NULL,
    invitee_name TEXT NOT NULL,
    invitee_phone TEXT,                     -- optional phone for SMS notifications
    invitee_timezone TEXT,
    start_time TEXT NOT NULL,               -- ISO 8601 UTC, e.g. "2026-03-15T14:00:00Z"
    end_time TEXT NOT NULL,                 -- ISO 8601 UTC
    status TEXT NOT NULL DEFAULT 'confirmed', -- 'pending', 'confirmed', 'cancelled', 'rescheduled', 'no_show', 'completed'
    location TEXT,                          -- resolved meeting location (Zoom link, address, etc.)

    -- Answers to custom questions from event_type.questions
    -- JSON object: {"q1": "Discuss roadmap", "q2": "Engineering"}
    answers TEXT DEFAULT '{}',

    -- Cancellation
    cancel_token TEXT UNIQUE,               -- secret token sent to invitee for self-service cancel
    cancelled_at TEXT,
    cancelled_by TEXT,                      -- 'host' or 'invitee'
    cancellation_reason TEXT,

    -- Rescheduling
    reschedule_uid TEXT,                    -- points to the new booking uid if rescheduled

    -- Team assignment (for round-robin/collective org event types)
    assigned_user_id INTEGER,              -- member assigned to handle this booking

    -- Internal meeting notes (private, host-only)
    notes TEXT,

    -- Calendar sync
    calendar_event_id TEXT,                 -- external calendar event ID (Google/Outlook)

    -- Guest emails (additional attendees added by invitee)
    -- JSON array of email strings: ["guest1@example.com", "guest2@example.com"]
    guest_emails TEXT DEFAULT '[]',

    -- Reconfirmation tracking
    reconfirmed INTEGER,                     -- NULL = not sent, 0 = pending, 1 = confirmed
    reconfirmation_sent_at TEXT,             -- when reconfirmation email was sent

    -- Recurring bookings
    recurrence_rule TEXT,                   -- null, 'weekly', 'biweekly', 'monthly'
    recurrence_end_date TEXT,              -- ISO date YYYY-MM-DD for recurring end
    recurrence_parent_id INTEGER,          -- parent booking id for recurring series

    -- UTM tracking parameters captured at booking time
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,

    -- Coupon applied at checkout; use_count is incremented on confirmation
    coupon_id INTEGER REFERENCES coupons(id),

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (event_type_id) REFERENCES event_types(id),
    FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (recurrence_parent_id) REFERENCES bookings(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_uid ON bookings(uid);
CREATE INDEX IF NOT EXISTS idx_bookings_event_type ON bookings(event_type_id);
CREATE INDEX IF NOT EXISTS idx_bookings_invitee_email ON bookings(invitee_email);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON bookings(start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_cancel_token ON bookings(cancel_token);
CREATE INDEX IF NOT EXISTS idx_bookings_reschedule ON bookings(reschedule_uid);

-- Recurring booking columns (added via ALTER for existing databases)
-- bookings.recurrence_rule TEXT (null, 'weekly', 'biweekly', 'monthly')
-- bookings.recurrence_end_date TEXT
-- bookings.recurrence_parent_id INTEGER REFERENCES bookings(id)

-- ============================================
-- CALENDAR CONNECTIONS
-- ============================================

-- External calendar integrations (Google, Outlook, Apple) for conflict checking and event creation
CREATE TABLE IF NOT EXISTS calendar_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,                 -- 'google', 'outlook', 'apple', 'caldav'
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    token_expires_at TEXT,
    calendar_id TEXT,                       -- specific calendar within the provider
    email TEXT,                             -- calendar account email
    is_primary INTEGER DEFAULT 0,           -- 1 = main calendar for this provider
    check_conflicts INTEGER DEFAULT 1,      -- 1 = check this calendar for busy times
    write_events INTEGER DEFAULT 1,         -- 1 = create booking events on this calendar
    last_synced_at TEXT,
    watch_channel_id TEXT,                  -- Google Calendar push notification channel ID
    watch_resource_id TEXT,                 -- Google Calendar push notification resource ID
    watch_expiration TEXT,                  -- ISO 8601 UTC expiration of the watch channel
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_user ON calendar_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_provider ON calendar_connections(user_id, provider);

-- Per-user Zoom OAuth connection (each user connects their own Zoom account, so
-- "Zoom" meetings are created in THEIR account, not a shared one). One per user.
CREATE TABLE IF NOT EXISTS zoom_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    token_expires_at TEXT,
    zoom_user_id TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zoom_connections_user ON zoom_connections(user_id);

-- OAuth login identities: accounts bound to the provider's stable subject id
-- (see migrations/0032_oauth_identities.sql).
CREATE TABLE IF NOT EXISTS oauth_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE (provider, subject),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

-- ============================================
-- WEBHOOKS
-- ============================================

-- User-configured webhooks for booking lifecycle events
CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,                      -- endpoint to POST to
    -- JSON array of event names:
    -- ["booking.created", "booking.cancelled", "booking.rescheduled"]
    events TEXT NOT NULL DEFAULT '["booking.created"]',
    secret TEXT,                            -- HMAC secret for signature verification
    is_active INTEGER DEFAULT 1,
    last_triggered_at TEXT,
    failure_count INTEGER DEFAULT 0,        -- consecutive failures, disable after threshold
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active);

-- ============================================
-- WORKFLOW ACTIONS (automated emails/SMS around bookings)
-- ============================================

-- Automated actions triggered by booking events
-- e.g. "Send reminder email 24h before", "Send follow-up 1h after"
CREATE TABLE IF NOT EXISTS workflow_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type_id INTEGER NOT NULL,
    trigger TEXT NOT NULL,                  -- 'before_event', 'after_event', 'on_booking', 'on_cancel'
    action_type TEXT NOT NULL,              -- 'email', 'sms', 'webhook'
    -- JSON config for the action:
    -- email: {"subject": "Reminder", "body": "Your meeting is in {{hours}} hours", "to": "invitee"}
    -- sms: {"body": "Reminder: meeting at {{time}}", "to": "{{invitee_phone}}"}
    config TEXT NOT NULL DEFAULT '{}',
    delay_minutes INTEGER DEFAULT 0,        -- positive = after trigger, negative = before event
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_actions_event_type ON workflow_actions(event_type_id);
CREATE INDEX IF NOT EXISTS idx_workflow_actions_trigger ON workflow_actions(trigger);

-- ============================================
-- ROUTING FORMS
-- ============================================

-- Dynamic forms that route invitees to different event types based on answers
-- e.g. "What department?" -> routes to Sales vs Support calendar
CREATE TABLE IF NOT EXISTS routing_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    -- JSON array of form fields:
    -- [{"id":"f1","label":"Department","type":"select","options":["Sales","Support","Engineering"],"required":true}]
    fields TEXT NOT NULL DEFAULT '[]',
    -- JSON array of routing rules (evaluated in order, first match wins):
    -- [{"conditions":[{"field":"f1","op":"eq","value":"Sales"}],"action":"redirect","target_event_type_id":5}]
    rules TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_routing_forms_user ON routing_forms(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_forms_slug ON routing_forms(user_id, slug);

-- Routing form submission analytics
CREATE TABLE IF NOT EXISTS routing_form_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routing_form_id INTEGER NOT NULL,
    answers TEXT,
    routed_to_event_type_id INTEGER,
    booking_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (routing_form_id) REFERENCES routing_forms(id) ON DELETE CASCADE,
    FOREIGN KEY (routed_to_event_type_id) REFERENCES event_types(id) ON DELETE SET NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_submissions_form ON routing_form_submissions(routing_form_id);

-- ============================================
-- PAYMENTS
-- ============================================

-- Stripe and PayPal payment tracking for paid event types
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,          -- amount in smallest currency unit
    currency TEXT NOT NULL DEFAULT 'usd',
    stripe_payment_intent_id TEXT UNIQUE,
    paypal_order_id TEXT,                    -- PayPal order ID for PayPal payments
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'succeeded', 'failed', 'refunded'
    refunded_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe ON payments(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_paypal ON payments(paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ============================================
-- AI CONVERSATIONS
-- ============================================

-- AI-powered scheduling assistant conversations on booking pages
-- Allows invitees to chat with an AI to find the right time/event type
CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_page_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,               -- browser session identifier
    -- JSON array of messages:
    -- [{"role":"user","content":"I need a 30min call","ts":"..."}, {"role":"assistant","content":"...","ts":"..."}]
    messages TEXT NOT NULL DEFAULT '[]',
    resolved_booking_id INTEGER,            -- set when the conversation results in a booking
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (booking_page_id) REFERENCES booking_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (resolved_booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_page ON ai_conversations(booking_page_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_session ON ai_conversations(session_id);

-- ============================================
-- NOTIFICATION LOG
-- ============================================

-- Log of all notifications sent (email, SMS, push) for auditing and deduplication
CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    type TEXT NOT NULL,                     -- 'confirmation', 'reminder', 'cancellation', 'reschedule', 'follow_up'
    channel TEXT NOT NULL,                  -- 'email', 'sms', 'push'
    recipient TEXT NOT NULL,               -- email address or phone number
    subject TEXT,                           -- email subject line
    status TEXT NOT NULL DEFAULT 'sent',    -- 'sent', 'delivered', 'failed', 'bounced'
    error TEXT,                            -- error message if failed
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_log_booking ON notification_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_type ON notification_log(type);
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON notification_log(status);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent ON notification_log(sent_at);

-- ============================================
-- MEETING POLLS (Doodle-style scheduling polls)
-- ============================================

-- Polls created by authenticated users
CREATE TABLE IF NOT EXISTS meeting_polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',     -- 'open', 'finalized', 'closed'
    deadline TEXT,                           -- optional deadline for voting
    finalized_option_id INTEGER,            -- winning option after finalization
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_polls_user ON meeting_polls(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_polls_status ON meeting_polls(status);

-- Time options for each poll
CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    date TEXT NOT NULL,                     -- YYYY-MM-DD
    start_time TEXT NOT NULL,               -- HH:MM
    end_time TEXT NOT NULL,                 -- HH:MM
    FOREIGN KEY (poll_id) REFERENCES meeting_polls(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id);

-- Votes cast by participants
CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    voter_name TEXT NOT NULL,
    voter_email TEXT NOT NULL,
    vote TEXT NOT NULL DEFAULT 'yes',       -- 'yes', 'maybe', 'no'
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (poll_id) REFERENCES meeting_polls(id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_email ON poll_votes(voter_email);

-- ============================================
-- USER FEEDBACK
-- ============================================

-- Feedback, bug reports, and feature requests from authenticated users
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'feedback',  -- 'feedback', 'bug', 'feature_request'
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

-- ============================================
-- SINGLE-USE BOOKING LINKS
-- ============================================

CREATE TABLE IF NOT EXISTS single_use_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    label TEXT,
    max_uses INTEGER NOT NULL DEFAULT 1,
    use_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    used_at TEXT,
    booking_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_single_use_links_token ON single_use_links(token);
CREATE INDEX IF NOT EXISTS idx_single_use_links_user ON single_use_links(user_id);

-- ============================================
-- COUPON CODES
-- ============================================

CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    discount_type TEXT NOT NULL DEFAULT 'percent',
    discount_value INTEGER NOT NULL,
    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    applies_to TEXT DEFAULT 'all',
    expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_user_code ON coupons(user_id, code);
CREATE INDEX IF NOT EXISTS idx_coupons_user ON coupons(user_id);

-- ============================================
-- AUDIT LOG
-- ============================================

-- Tracks user actions for security, debugging, and activity history
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,              -- e.g. 'event_type.created', 'booking.cancelled'
    entity_type TEXT,                  -- e.g. 'event_type', 'booking', 'settings'
    entity_id INTEGER,                -- ID of the affected entity (nullable for some actions)
    details TEXT DEFAULT '{}',         -- JSON object with additional context
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- ============================================
-- EMAIL SEQUENCES
-- ============================================

CREATE TABLE IF NOT EXISTS email_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type_id INTEGER,
    trigger_type TEXT NOT NULL,
    delay_minutes INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_sequences_user ON email_sequences(user_id);

CREATE TABLE IF NOT EXISTS email_sequence_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sequence_id) REFERENCES email_sequences(id) ON DELETE CASCADE,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sequence_log_unique ON email_sequence_log(sequence_id, booking_id);

CREATE TABLE IF NOT EXISTS calendar_sync_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    error_type TEXT NOT NULL,
    error_message TEXT,
    connection_id INTEGER REFERENCES calendar_connections(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_errors_user ON calendar_sync_errors(user_id, created_at);
