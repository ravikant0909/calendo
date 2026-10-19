-- Migration: Add invitee_phone to bookings table for SMS notifications
-- Also adds sms_reminders_enabled to event_types

ALTER TABLE bookings ADD COLUMN invitee_phone TEXT;

-- Index for finding bookings with phone numbers (for SMS reminders)
CREATE INDEX IF NOT EXISTS idx_bookings_invitee_phone ON bookings(invitee_phone);
