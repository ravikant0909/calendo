-- Track which coupon a booking used, so coupon use_count can be incremented
-- when the booking actually confirms (payment success or free-coupon confirm)
-- instead of at checkout creation, where abandoned checkouts burned
-- limited-use coupons.
ALTER TABLE bookings ADD COLUMN coupon_id INTEGER REFERENCES coupons(id);
