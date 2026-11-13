-- Apply once to existing installations before deploying the presence UI/API.
-- Requests, sessions, operation mappings and physician credentials are preserved.
ALTER TABLE requests ADD COLUMN presence TEXT CHECK(presence IS NULL OR presence IN ('waiting', 'left'));
ALTER TABLE requests ADD COLUMN presence_updated INTEGER;
ALTER TABLE requests ADD COLUMN reply_version INTEGER NOT NULL DEFAULT 0 CHECK(reply_version >= 0);
-- Existing answered (including completed) requests remain eligible for feedback
-- after reopening, while all feedback initially remains unspecified.
UPDATE requests SET reply_version=version WHERE reply<>'';
