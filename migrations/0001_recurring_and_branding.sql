-- Migration: Add recurring bookings columns and branding columns
-- Safe to re-run (uses IF NOT EXISTS pattern via try/catch in application)

-- Recurring bookings
ALTER TABLE bookings ADD COLUMN recurrence_rule TEXT;
ALTER TABLE bookings ADD COLUMN recurrence_end_date TEXT;
ALTER TABLE bookings ADD COLUMN recurrence_parent_id INTEGER REFERENCES bookings(id);

CREATE INDEX IF NOT EXISTS idx_bookings_recurrence_parent ON bookings(recurrence_parent_id);

-- Custom branding
ALTER TABLE booking_pages ADD COLUMN logo_url TEXT;
ALTER TABLE booking_pages ADD COLUMN hide_branding INTEGER DEFAULT 0;
