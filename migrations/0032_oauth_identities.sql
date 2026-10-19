-- OAuth login identities. Login used to match an OAuth user to a Calendo account
-- by email string alone, so anyone who could make a provider assert a victim's
-- email (e.g. a self-made Microsoft Entra tenant with mail=victim@corp.com) got
-- the victim's account. Accounts are now bound to the provider's stable subject
-- id; email is only used to link when the provider has verified it.
CREATE TABLE IF NOT EXISTS oauth_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,          -- 'google' | 'microsoft'
    subject TEXT NOT NULL,           -- provider's stable user id (Google id, Microsoft object id)
    email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE (provider, subject),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);
