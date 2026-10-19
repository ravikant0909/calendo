-- Migration 0018: Add guest_emails column to bookings and allow_guests to event_types
-- Allows invitees to add additional guests when booking

-- Add guest_emails column to bookings table (JSON array of email strings)
ALTER TABLE bookings ADD COLUMN guest_emails TEXT DEFAULT '[]';

-- Add allow_guests flag to event_types (default enabled)
ALTER TABLE event_types ADD COLUMN allow_guests INTEGER NOT NULL DEFAULT 1;
