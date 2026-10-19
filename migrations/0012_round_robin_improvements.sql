-- Migration 0012: Round robin improvements
-- Add priority weight and skip rules to org members

ALTER TABLE org_members ADD COLUMN round_robin_weight INTEGER NOT NULL DEFAULT 1;
-- Weight for round-robin distribution (higher = more bookings). Default 1.

ALTER TABLE org_members ADD COLUMN round_robin_skip INTEGER NOT NULL DEFAULT 0;
-- 1 = temporarily skip this member from round-robin rotation

ALTER TABLE org_members ADD COLUMN round_robin_max_daily INTEGER;
-- Max bookings per day for this member in round-robin. NULL = unlimited.

INSERT OR IGNORE INTO schema_version (version, description) VALUES (12, 'Round robin member weights and skip rules');
