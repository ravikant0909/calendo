-- Demo booking page at /demo (needs "DEMO_SLUGS": "demo" in wrangler.json vars).
-- Bookings on it are validated but never saved, and no emails go out.
-- The host can't log in: the password hash is not a valid hash, and the
-- .invalid email address can't receive a reset link.
--
-- Apply: npx wrangler d1 execute calendo --remote --file scripts/seed-demo.sql
-- Safe to re-run: every insert is skipped if the row already exists.

INSERT INTO users (email, password_hash, name, timezone, email_verified, onboarding_completed)
SELECT 'demo-host@calendo.invalid', '!disabled', 'Calendo Demo', 'America/New_York', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'demo-host@calendo.invalid');

INSERT INTO booking_pages (user_id, slug, display_name, bio, welcome_message)
SELECT id, 'demo', 'Calendo Demo',
  'A sample booking page. Pick a meeting type and a time.',
  'Try it: pick a meeting type and book any open time. Nothing is saved.'
FROM users WHERE email = 'demo-host@calendo.invalid'
  AND NOT EXISTS (SELECT 1 FROM booking_pages WHERE slug = 'demo');

INSERT INTO availability_schedules (user_id, name, timezone, rules, is_default)
SELECT id, 'Working Hours', 'America/New_York',
  '[{"day":1,"start":"09:00","end":"17:00"},{"day":2,"start":"09:00","end":"17:00"},{"day":3,"start":"09:00","end":"17:00"},{"day":4,"start":"09:00","end":"17:00"},{"day":5,"start":"09:00","end":"17:00"}]',
  1
FROM users WHERE email = 'demo-host@calendo.invalid'
  AND NOT EXISTS (SELECT 1 FROM availability_schedules s JOIN users u ON s.user_id = u.id WHERE u.email = 'demo-host@calendo.invalid');

INSERT INTO event_types (user_id, name, slug, description, duration_minutes, location_type, location_config, min_notice_hours, sort_order, color)
SELECT u.id, v.name, v.slug, v.description, v.duration, 'google_meet', '{}', 2, v.sort_order, v.color
FROM users u,
  (SELECT '15-minute quick chat' AS name, 'quick-chat' AS slug, 'A short call to say hello.' AS description, 15 AS duration, 0 AS sort_order, '#10b981' AS color
   UNION ALL SELECT '30-minute intro call', 'intro-call', 'Get to know each other and see if we are a fit.', 30, 1, '#2563eb'
   UNION ALL SELECT '60-minute consultation', 'consultation', 'A longer working session.', 60, 2, '#8b5cf6') v
WHERE u.email = 'demo-host@calendo.invalid'
  AND NOT EXISTS (SELECT 1 FROM event_types e WHERE e.user_id = u.id AND e.slug = v.slug);
