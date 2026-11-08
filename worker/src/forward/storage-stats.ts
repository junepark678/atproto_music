// Cached logical-size reporting for forwarding's durable local state. The
// aggregate scans run only from the forward extension timer, at most once per
// five minutes; admin status reads the small counters cache instead.

import type { Db } from '../do/db';

export const FORWARD_STORAGE_STATS_REFRESH_MS = 5 * 60_000;

const COUNTER_NAME = 'forward_storage';
const TABLES = [
  {
    key: 'forward_admissions',
    columns: ['did', 'identity_key', 'path', 'source_service'],
    marker: true,
  },
  {
    key: 'love_incarnations',
    columns: ['uri', 'incarnation_key', 'state', 'path', 'source_service'],
    marker: true,
  },
  {
    key: 'love_delete_bridges',
    columns: ['did', 'uri', 'incarnation_key', 'expected_cid', 'operation_id', 'state'],
    marker: true,
  },
  {
    key: 'love_import_bridges',
    columns: ['did', 'operation_id', 'uri', 'incarnation_key', 'source_service', 'state'],
    marker: true,
  },
  {
    key: 'forward_outbox',
    columns: ['id', 'link_id', 'did', 'kind', 'dedupe_key', 'payload_json', 'state', 'last_error'],
    marker: false,
  },
] as const;

type TableKey = (typeof TABLES)[number]['key'];
type StorageStats = {
  refreshedAtMs: number | null;
  refreshIntervalMs: number;
  markers: { rows: number | null; logicalBytesEstimate: number | null };
  forwardOutbox: { rows: number | null; logicalBytesEstimate: number | null };
  tables: Record<TableKey, { rows: number | null; logicalBytesEstimate: number | null }>;
};

function readCounter(db: Db, label: string): number | null {
  return (
    db.one<{ value: number }>('SELECT value FROM counters WHERE name=? AND label=?', COUNTER_NAME, label)?.value ?? null
  );
}

function writeCounter(db: Db, label: string, value: number): void {
  db.run(
    `INSERT INTO counters(name,label,value) VALUES (?,?,?)
     ON CONFLICT(name,label) DO UPDATE SET value=excluded.value`,
    COUNTER_NAME,
    label,
    value,
  );
}

/** Refreshes full aggregates only on the low-frequency forwarding timer. */
export function refreshForwardStorageStats(db: Db, now: number): boolean {
  const lastRefresh = readCounter(db, 'refreshed_at_ms');
  if (lastRefresh !== null && now >= lastRefresh && now - lastRefresh < FORWARD_STORAGE_STATS_REFRESH_MS) return false;

  return db.tx(() => {
    const checked = readCounter(db, 'refreshed_at_ms');
    if (checked !== null && now >= checked && now - checked < FORWARD_STORAGE_STATS_REFRESH_MS) return false;

    for (const table of TABLES) {
      const bytes = table.columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`).join(' + ');
      const values = db.one<{ rows: number; logical_bytes_estimate: number }>(
        `SELECT count(*) AS rows,coalesce(sum(${bytes}),0) AS logical_bytes_estimate FROM ${table.key}`,
      );
      if (values === null) throw new Error(`missing forwarding storage stats for ${table.key}`);
      writeCounter(db, `${table.key}_rows`, values.rows);
      writeCounter(db, `${table.key}_logical_bytes_estimate`, values.logical_bytes_estimate);
    }
    writeCounter(db, 'refreshed_at_ms', now);
    return true;
  });
}

/** A cache-only status read; no marker or outbox table scan occurs here. */
export function readForwardStorageStats(db: Db): StorageStats {
  const tables = Object.fromEntries(
    TABLES.map((table) => [
      table.key,
      {
        rows: readCounter(db, `${table.key}_rows`),
        logicalBytesEstimate: readCounter(db, `${table.key}_logical_bytes_estimate`),
      },
    ]),
  ) as StorageStats['tables'];
  const markerTables = TABLES.filter((table) => table.marker).map((table) => tables[table.key]);
  const markerRows = markerTables.every((stats) => stats.rows !== null)
    ? markerTables.reduce((total, stats) => total + (stats.rows ?? 0), 0)
    : null;
  const markerBytes = markerTables.every((stats) => stats.logicalBytesEstimate !== null)
    ? markerTables.reduce((total, stats) => total + (stats.logicalBytesEstimate ?? 0), 0)
    : null;
  return {
    refreshedAtMs: readCounter(db, 'refreshed_at_ms'),
    refreshIntervalMs: FORWARD_STORAGE_STATS_REFRESH_MS,
    markers: { rows: markerRows, logicalBytesEstimate: markerBytes },
    forwardOutbox: tables.forward_outbox,
    tables,
  };
}
