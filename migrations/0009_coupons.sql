-- Migration 0009: Coupon codes for paid event types
CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,                    -- e.g. "WELCOME20"
    discount_type TEXT NOT NULL DEFAULT 'percent', -- 'percent' or 'fixed'
    discount_value INTEGER NOT NULL,       -- percent (0-100) or fixed amount in cents
    max_uses INTEGER,                      -- NULL = unlimited
    use_count INTEGER NOT NULL DEFAULT 0,
    applies_to TEXT DEFAULT 'all',         -- 'all' or JSON array of event_type_ids
    expires_at TEXT,                       -- optional expiration
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_user_code ON coupons(user_id, code);
CREATE INDEX IF NOT EXISTS idx_coupons_user ON coupons(user_id);

INSERT OR IGNORE INTO schema_version (version, description) VALUES (9, 'Coupon codes for paid events');
