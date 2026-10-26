-- Persist ordering dependencies for scrobble/follow create-delete races.
CREATE TABLE operation_dependencies (
 operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
 predecessor_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
 PRIMARY KEY(operation_id,predecessor_id),
 CHECK(operation_id != predecessor_id)
);
CREATE INDEX operation_dependencies_predecessor ON operation_dependencies(predecessor_id);
PRAGMA user_version = 2;
