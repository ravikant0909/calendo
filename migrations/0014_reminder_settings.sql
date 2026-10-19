-- Migration 0014: Reminder settings per event type
ALTER TABLE event_types ADD COLUMN reminder_settings TEXT NOT NULL DEFAULT '{"email_24h":true,"email_1h":true,"sms_24h":false,"sms_1h":false}';
-- JSON object controlling which reminders are sent:
-- email_24h, email_1h, sms_24h, sms_1h (all boolean)

INSERT OR IGNORE INTO schema_version (version, description) VALUES (14, 'Configurable reminder settings per event type');
