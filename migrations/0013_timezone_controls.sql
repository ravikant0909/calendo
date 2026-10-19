-- Migration 0013: Timezone controls for event types
ALTER TABLE event_types ADD COLUMN locked_timezone TEXT;
-- If set, booking page uses this timezone instead of letting invitee choose.
-- NULL = invitee picks their own timezone (default behavior).

INSERT OR IGNORE INTO schema_version (version, description) VALUES (13, 'Locked timezone for event types');
