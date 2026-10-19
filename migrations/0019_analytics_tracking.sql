-- Migration 0019: Add analytics tracking support
-- Adds Google Analytics and Meta Pixel IDs to booking_pages,
-- and UTM parameter columns to bookings table

-- Tracking pixel/analytics IDs on the booking page
ALTER TABLE booking_pages ADD COLUMN ga_measurement_id TEXT;
ALTER TABLE booking_pages ADD COLUMN meta_pixel_id TEXT;

-- UTM parameters captured at booking time
ALTER TABLE bookings ADD COLUMN utm_source TEXT;
ALTER TABLE bookings ADD COLUMN utm_medium TEXT;
ALTER TABLE bookings ADD COLUMN utm_campaign TEXT;
ALTER TABLE bookings ADD COLUMN utm_term TEXT;
ALTER TABLE bookings ADD COLUMN utm_content TEXT;
