-- Migration 0015: Routing form analytics
-- Track form submissions and conversion to bookings

CREATE TABLE IF NOT EXISTS routing_form_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routing_form_id INTEGER NOT NULL,
    answers TEXT,                         -- JSON of submitted answers
    routed_to_event_type_id INTEGER,     -- which event type was selected by routing rules
    booking_id INTEGER,                  -- NULL until a booking is created (conversion)
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (routing_form_id) REFERENCES routing_forms(id) ON DELETE CASCADE,
    FOREIGN KEY (routed_to_event_type_id) REFERENCES event_types(id) ON DELETE SET NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_submissions_form ON routing_form_submissions(routing_form_id);

INSERT OR IGNORE INTO schema_version (version, description) VALUES (15, 'Routing form submission analytics');
