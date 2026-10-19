-- Migration 0008: Single-use booking links
-- One-time links that expire after first booking

CREATE TABLE IF NOT EXISTS single_use_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,          -- random URL-safe token
    label TEXT,                          -- optional description ("for John re: project kickoff")
    max_uses INTEGER NOT NULL DEFAULT 1, -- how many times it can be used (1 = single-use)
    use_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,                     -- optional expiration timestamp
    used_at TEXT,                        -- when first used (NULL if unused)
    booking_id INTEGER,                 -- linked booking after use
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_single_use_links_token ON single_use_links(token);
CREATE INDEX IF NOT EXISTS idx_single_use_links_user ON single_use_links(user_id);

INSERT OR IGNORE INTO schema_version (version, description) VALUES (8, 'Single-use booking links');
