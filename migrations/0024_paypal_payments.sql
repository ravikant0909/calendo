-- Add PayPal payment method support
-- event_types: payment_method column to choose between stripe and paypal
ALTER TABLE event_types ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'stripe';

-- payments: paypal_order_id column for tracking PayPal orders
ALTER TABLE payments ADD COLUMN paypal_order_id TEXT;

-- users: encrypted PayPal credentials (per-user, like AI key)
ALTER TABLE users ADD COLUMN paypal_client_id_encrypted TEXT;
ALTER TABLE users ADD COLUMN paypal_client_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN paypal_mode TEXT NOT NULL DEFAULT 'sandbox';

CREATE INDEX IF NOT EXISTS idx_payments_paypal ON payments(paypal_order_id);
