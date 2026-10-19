-- Add meeting_limits column to availability_schedules
-- JSON array of meeting limit entries:
-- [{"type": "daily", "max": 5}, {"type": "weekly", "max": 20}]
ALTER TABLE availability_schedules ADD COLUMN meeting_limits TEXT NOT NULL DEFAULT '[]';
