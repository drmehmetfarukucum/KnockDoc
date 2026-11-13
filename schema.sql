-- D1 enforces foreign keys by default; do not disable them for this schema.

CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);

CREATE TABLE IF NOT EXISTS requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
  created_day TEXT NOT NULL,
  visitor_number INTEGER CHECK(visitor_number IS NULL OR visitor_number >= 1),
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('new', 'answered', 'done')),
  note TEXT NOT NULL,
  phone TEXT NOT NULL,
  full_name TEXT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  replied INTEGER,
  presence TEXT CHECK(presence IS NULL OR presence IN ('waiting', 'left')),
  presence_updated INTEGER,
  reply_version INTEGER NOT NULL DEFAULT 0 CHECK(reply_version >= 0),
  message_version INTEGER NOT NULL DEFAULT 0 CHECK(message_version >= 0),
  latest_message_at INTEGER,
  completed INTEGER,
  completed_from TEXT CHECK(completed_from IS NULL OR completed_from IN ('new', 'answered')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
);
CREATE INDEX IF NOT EXISTS requests_owner_seq ON requests(owner, seq);
CREATE INDEX IF NOT EXISTS requests_expiry ON requests(expires);

-- Anonymous daily queue codes belong to a browser session, not a verified person.
-- Counters have no owner reference so removing a session never reuses a number.
CREATE TABLE IF NOT EXISTS daily_visitor_counters (
  day TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL CHECK(last_number >= 0)
);
CREATE TABLE IF NOT EXISTS daily_visitors (
  day TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK(number >= 1),
  expires INTEGER NOT NULL,
  PRIMARY KEY(day, owner),
  UNIQUE(day, number)
);
CREATE INDEX IF NOT EXISTS daily_visitors_expiry ON daily_visitors(expires);

CREATE TABLE IF NOT EXISTS request_operations (
  owner TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  PRIMARY KEY(owner, operation_id)
);
CREATE INDEX IF NOT EXISTS request_operations_request ON request_operations(request_id);

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

-- App feedback is separate from clinical requests. Since v1.5.0 a new entry sends
-- a generic phone notification; its text and category never leave the app.
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

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  value TEXT NOT NULL CHECK(json_valid(value))
);
INSERT OR IGNORE INTO config(id, value) VALUES (1, '{"version":1,"schedule":[{"open":false,"start":"08:00","end":"17:00"},{"open":true,"start":"08:00","end":"17:00"},{"open":true,"start":"08:00","end":"17:00"},{"open":false,"start":"08:00","end":"17:00"},{"open":true,"start":"08:00","end":"17:00"},{"open":true,"start":"08:00","end":"17:00"},{"open":false,"start":"08:00","end":"17:00"}],"todayOverride":null,"statusDate":null,"statusMessage":"","returnAt":null,"workPhone":"","emergencyText":""}');

-- Physician authentication is separate from anonymous employee sessions.
CREATE TABLE IF NOT EXISTS doctor_sessions (
  hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL,
  authenticated INTEGER NOT NULL CHECK(authenticated IN (0,1)),
  credential_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doctor_sessions_expiry ON doctor_sessions(expires);

-- No raw network address or submitted credential is retained here.
CREATE TABLE IF NOT EXISTS doctor_login_limits (
  scope TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts>=1)
);
CREATE INDEX IF NOT EXISTS doctor_login_limits_expiry ON doctor_login_limits(expires);

-- A push endpoint is a device capability: only authenticated physician routes access it.
CREATE TABLE IF NOT EXISTS doctor_push_subscriptions (
  hash TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  credential_version TEXT NOT NULL,
  vapid_public_key TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  session_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doctor_push_by_owner ON doctor_push_subscriptions(credential_version, vapid_public_key, expires);
CREATE INDEX IF NOT EXISTS doctor_push_by_session ON doctor_push_subscriptions(session_hash);
