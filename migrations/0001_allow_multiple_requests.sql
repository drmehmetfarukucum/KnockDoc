-- Remove the previous one-open-request-per-employee-per-day restriction.
-- This changes no stored requests, sessions, operation mappings or credentials.
DROP INDEX IF EXISTS requests_one_active_daily;
