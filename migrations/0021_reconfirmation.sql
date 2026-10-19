-- Migration 0019: Add reconfirmation support
-- Allows hosts to require invitees to reconfirm attendance before a meeting

-- Add reconfirmation_hours to event_types (NULL = disabled, e.g. 24 or 48)
ALTER TABLE event_types ADD COLUMN reconfirmation_hours INTEGER;

-- Add reconfirmed flag and sent timestamp to bookings
ALTER TABLE bookings ADD COLUMN reconfirmed INTEGER;
ALTER TABLE bookings ADD COLUMN reconfirmation_sent_at TEXT;
