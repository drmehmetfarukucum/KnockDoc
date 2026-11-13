-- Apply once after 0004. Existing requests and their retention remain unchanged.
ALTER TABLE requests ADD COLUMN message_version INTEGER NOT NULL DEFAULT 0 CHECK(message_version >= 0);
ALTER TABLE requests ADD COLUMN latest_message_at INTEGER;

-- Short employee additions are tied to the existing request and its retention.
CREATE TABLE IF NOT EXISTS request_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE(request_id, operation_id)
);
CREATE INDEX IF NOT EXISTS request_messages_request_seq ON request_messages(request_id, seq);

-- App feedback is separate from clinical requests and never triggers a page.
CREATE TABLE IF NOT EXISTS app_feedback (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('suggestion','bug','other')),
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  UNIQUE(owner, operation_id)
);
CREATE INDEX IF NOT EXISTS app_feedback_expiry ON app_feedback(expires);
CREATE INDEX IF NOT EXISTS app_feedback_owner_seq ON app_feedback(owner, seq);

