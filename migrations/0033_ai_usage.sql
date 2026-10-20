-- Daily AI message counter. The AI agent bills the platform's Anthropic key, so
-- free users get a daily allowance; users with their own key or Pro skip it.
-- kind: 'dashboard' (host's AI agent) | 'public' (invitee chat on a booking page,
-- counted against the host).
CREATE TABLE IF NOT EXISTS ai_usage (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,               -- UTC date, YYYY-MM-DD
    kind TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, kind),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
