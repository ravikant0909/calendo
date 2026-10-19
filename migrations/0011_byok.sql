-- Migration 0011: BYOK (Bring Your Own API Key)
-- Users can provide their own LLM API key

ALTER TABLE users ADD COLUMN ai_api_key_encrypted TEXT;
-- Encrypted (same AES-GCM as calendar tokens) Claude/OpenAI API key
-- If set, AI features use this instead of the shared key

INSERT OR IGNORE INTO schema_version (version, description) VALUES (11, 'BYOK - user AI API key');
