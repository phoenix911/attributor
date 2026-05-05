-- Weekly cleanup. Run via:
--   npm run db:cleanup:remote
-- Or schedule with `wrangler triggers` once you want it automated.
-- Keeps last 14 days of clicks + 90 days of match outcomes.

DELETE FROM clicks  WHERE landing_at < (strftime('%s','now') - 14 * 86400) * 1000;
DELETE FROM matches WHERE matched_at < (strftime('%s','now') - 90 * 86400) * 1000;
