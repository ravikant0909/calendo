-- Migration 0016: Team permissions
-- Add granular permission columns to org_members

ALTER TABLE org_members ADD COLUMN can_edit_event_types INTEGER NOT NULL DEFAULT 0;
-- 1 = can create/edit/delete shared event types (editor role)

ALTER TABLE org_members ADD COLUMN can_manage_bookings INTEGER NOT NULL DEFAULT 0;
-- 1 = can cancel, reschedule, add notes to team bookings (manager role)

ALTER TABLE org_members ADD COLUMN can_view_analytics INTEGER NOT NULL DEFAULT 1;
-- 1 = can view team analytics and booking data (viewer role, default on)

INSERT OR IGNORE INTO schema_version (version, description) VALUES (16, 'Granular team permissions');
