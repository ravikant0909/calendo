-- Migration: Add cancellation policy and email blocklist to booking_pages

ALTER TABLE booking_pages ADD COLUMN cancellation_policy TEXT;
ALTER TABLE booking_pages ADD COLUMN blocked_emails TEXT;
