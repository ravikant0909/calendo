-- Add slot_interval column to event_types
-- Controls the time increment between slot start times (default 15 minutes)
-- Allowed values: 5, 10, 15, 20, 30, 60

ALTER TABLE event_types ADD COLUMN slot_interval INTEGER DEFAULT 15;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (4, 'Add slot_interval to event_types');
