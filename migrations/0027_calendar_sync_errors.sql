-- Log calendar sync errors so the developer can diagnose silent failures
CREATE TABLE IF NOT EXISTS calendar_sync_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL, -- 'google' or 'outlook'
  error_type TEXT NOT NULL, -- 'token_refresh', 'api_error', 'token_expired'
  error_message TEXT,
  connection_id INTEGER REFERENCES calendar_connections(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_errors_user ON calendar_sync_errors(user_id, created_at);
