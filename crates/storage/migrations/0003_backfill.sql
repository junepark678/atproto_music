-- Durable per-DID recovery. A completed snapshot never clears a relay-wide gap by itself.
CREATE TABLE repo_backfills (
 did TEXT PRIMARY KEY NOT NULL REFERENCES users(did) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('pending','running','complete','failed')),
 backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK(backfill_complete IN (0,1)),
 revision TEXT,
 pds TEXT,
 reactivate INTEGER NOT NULL DEFAULT 0 CHECK(reactivate IN (0,1)),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
 updated_at TEXT NOT NULL,
 failure_code TEXT
);
CREATE INDEX repo_backfills_pending ON repo_backfills(state,updated_at,did);
CREATE TABLE relay_recovery (
 relay TEXT PRIMARY KEY NOT NULL,
 pending_gap INTEGER NOT NULL DEFAULT 1 CHECK(pending_gap IN (0,1)),
 connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0,1)),
 last_event_at TEXT,
 prior_sequence INTEGER CHECK(prior_sequence >= 0),
 reason TEXT,
 updated_at TEXT NOT NULL
);
PRAGMA user_version = 3;
