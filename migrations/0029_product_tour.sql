-- First-login product tour: track whether a user has seen the guided walkthrough
-- so we only auto-launch it once (they can always replay it from Help / the AI).
ALTER TABLE users ADD COLUMN product_tour_completed INTEGER DEFAULT 0;
