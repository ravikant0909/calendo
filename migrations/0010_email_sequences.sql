-- Migration 0010: Automated email sequences
-- Customizable pre/post meeting emails

CREATE TABLE IF NOT EXISTS email_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type_id INTEGER,               -- NULL = applies to all event types
    trigger_type TEXT NOT NULL,           -- 'before_meeting', 'after_meeting', 'after_booking'
    delay_minutes INTEGER NOT NULL,      -- minutes before/after the trigger
    subject TEXT NOT NULL,
    body TEXT NOT NULL,                   -- email body (plain text with {{variables}})
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_sequences_user ON email_sequences(user_id);

-- Track sent sequence emails to avoid duplicates
CREATE TABLE IF NOT EXISTS email_sequence_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sequence_id) REFERENCES email_sequences(id) ON DELETE CASCADE,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sequence_log_unique ON email_sequence_log(sequence_id, booking_id);

INSERT OR IGNORE INTO schema_version (version, description) VALUES (10, 'Automated email sequences');
