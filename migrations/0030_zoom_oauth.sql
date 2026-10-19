-- Per-user Zoom OAuth. Replaces the old single shared Server-to-Server Zoom
-- credential (privacy leak: every user's Zoom meeting was created in the platform
-- owner's account). Each user now connects their OWN Zoom account; meetings are
-- created with their token in their account. One Zoom account per user.
CREATE TABLE IF NOT EXISTS zoom_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    token_expires_at TEXT,
    zoom_user_id TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zoom_connections_user ON zoom_connections(user_id);
