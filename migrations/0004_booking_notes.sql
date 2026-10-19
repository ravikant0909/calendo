-- Add internal meeting notes column to bookings (private, host-only)
ALTER TABLE bookings ADD COLUMN notes TEXT;

INSERT OR IGNORE INTO schema_version (version, description) VALUES (5, 'Add notes column to bookings');
