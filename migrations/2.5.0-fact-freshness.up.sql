-- What Next cloud (Railway Postgres) - v2.5.0 fact freshness.
-- Additive only: four nullable columns on facts. No data is changed.
-- The server runs this itself on boot (initSchema, FACT_FRESHNESS_MIGRATION);
-- this file is the same statements for running or reviewing by hand.
BEGIN;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS volatility TEXT;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS ttl_days INTEGER;
COMMIT;
