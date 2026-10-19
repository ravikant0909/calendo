-- Add checklist_state column for persisting testing checklist progress
ALTER TABLE users ADD COLUMN checklist_state TEXT DEFAULT NULL;
