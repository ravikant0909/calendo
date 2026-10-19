-- Move user state from browser localStorage to server-side DB
ALTER TABLE users ADD COLUMN onboarding_completed INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN schedule_setup_dismissed INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN ai_session_id TEXT;
ALTER TABLE users ADD COLUMN ai_chat_history TEXT;
