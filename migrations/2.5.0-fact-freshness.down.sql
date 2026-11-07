-- What Next cloud (Railway Postgres) - rollback of v2.5.0 fact freshness.
-- Step 1 of a rollback is redeploying v2.4.x: it never reads these columns,
-- so it runs with them in place. Run this only to remove them as well.
-- It drops the freshness values written since v2.5.0 (source, last_verified_at,
-- volatility, ttl_days); facts themselves are untouched.
BEGIN;
ALTER TABLE facts DROP COLUMN IF EXISTS ttl_days;
ALTER TABLE facts DROP COLUMN IF EXISTS volatility;
ALTER TABLE facts DROP COLUMN IF EXISTS last_verified_at;
ALTER TABLE facts DROP COLUMN IF EXISTS source;
COMMIT;
