-- Migration 0017: Redirect URL for event types
-- After booking, redirect invitees to a custom URL instead of the default confirmation page
ALTER TABLE event_types ADD COLUMN redirect_url TEXT;

INSERT OR IGNORE INTO schema_version (version, description) VALUES (17, 'Post-booking redirect URL for event types');
