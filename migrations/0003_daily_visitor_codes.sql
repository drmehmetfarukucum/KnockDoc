-- Apply once before the daily-code application release. Existing requests,
-- operation mappings, sessions, answers and credentials remain unchanged.
ALTER TABLE requests ADD COLUMN visitor_number INTEGER CHECK(visitor_number IS NULL OR visitor_number >= 1);
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
-- The first request sequence establishes each session's daily order, including
-- completed requests. Expiry stays equal to the last request's existing expiry.
INSERT INTO daily_visitors(day,owner,number,expires)
SELECT created_day,owner,
  ROW_NUMBER() OVER (PARTITION BY created_day ORDER BY first_seq),expires
FROM (
  SELECT created_day,owner,MIN(seq) AS first_seq,MAX(expires) AS expires
  FROM requests GROUP BY created_day,owner
);
INSERT INTO daily_visitor_counters(day,last_number)
SELECT day,MAX(number) FROM daily_visitors GROUP BY day;
UPDATE requests SET visitor_number=(
  SELECT number FROM daily_visitors WHERE day=requests.created_day AND owner=requests.owner
);
