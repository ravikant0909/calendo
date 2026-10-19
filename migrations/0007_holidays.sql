-- Migration 0007: Add holiday support to availability schedules
-- Adds a holidays JSON column to store enabled holiday dates

ALTER TABLE availability_schedules ADD COLUMN holidays TEXT NOT NULL DEFAULT '[]';
-- JSON array of holiday entries:
-- [{"date": "2026-12-25", "name": "Christmas Day"}, {"date": "2026-01-01", "name": "New Year's Day"}, ...]
-- These dates are treated as unavailable (same as override with available: false)

INSERT OR IGNORE INTO schema_version (version, description) VALUES (7, 'Add holiday support to availability schedules');
