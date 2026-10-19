-- Migration 0020: Audit log table for tracking user actions
-- Provides a full activity history for security and debugging

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,              -- e.g. 'event_type.created', 'booking.cancelled'
    entity_type TEXT,                  -- e.g. 'event_type', 'booking', 'settings'
    entity_id INTEGER,                -- ID of the affected entity (nullable for some actions)
    details TEXT DEFAULT '{}',         -- JSON object with additional context
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
