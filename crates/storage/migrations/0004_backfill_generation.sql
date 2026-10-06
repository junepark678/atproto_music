-- Only a global counter survives account removal; no owner data is retained here.
CREATE TABLE backfill_generation (
 singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
 last_generation INTEGER NOT NULL CHECK(typeof(last_generation) = 'integer' AND last_generation >= 0)
);
INSERT INTO backfill_generation(singleton,last_generation)
 SELECT 1,coalesce(max(generation),0) FROM repo_backfills;
PRAGMA user_version = 4;
