// Cached logical-size reporting for forwarding's durable local state. The
// extension timer advances a persisted keyset scan by at most one bounded
// page per table; admin status reads only the published counters cache.

import type { Db } from '../do/db';

export const FORWARD_STORAGE_STATS_REFRESH_MS = 5 * 60_000;
export const FORWARD_STORAGE_STATS_SLICE_SIZE = 100;

const COUNTER_NAME = 'forward_storage';
const TABLES = [
  {
    key: 'forward_admissions',
    primaryKey: ['did', 'identity_key'],
    columns: ['did', 'identity_key', 'path', 'source_service'],
    marker: true,
  },
  {
    key: 'love_incarnations',
    primaryKey: ['uri'],
    columns: ['uri', 'incarnation_key', 'state', 'path', 'source_service'],
    marker: true,
  },
  {
    key: 'love_delete_bridges',
    primaryKey: ['did', 'uri', 'incarnation_key', 'operation_id'],
    columns: ['did', 'uri', 'incarnation_key', 'expected_cid', 'operation_id', 'state'],
    marker: true,
  },
  {
    key: 'love_import_bridges',
    primaryKey: ['did', 'operation_id'],
    columns: ['did', 'operation_id', 'uri', 'incarnation_key', 'source_service', 'state'],
    marker: true,
  },
  {
    key: 'forward_outbox',
    primaryKey: ['id'],
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

type ProgressRow = {
  cursor_json: string | null;
  rows_seen: number;
  logical_bytes_seen: number;
  complete: number;
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

function scanTablePage(db: Db, table: (typeof TABLES)[number], progress: ProgressRow): boolean {
  const columns = [...table.primaryKey];
  const cursor = progress.cursor_json === null ? null : (JSON.parse(progress.cursor_json) as string[]);
  if (cursor !== null && cursor.length !== columns.length)
    throw new Error(`invalid forwarding scan cursor for ${table.key}`);

  const bytes = table.columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`).join(' + ');
  const keyset = cursor === null ? '' : `WHERE (${columns.join(',')}) > (${columns.map(() => '?').join(',')})`;
  const rows = db.all<Record<string, string> & { logical_bytes_estimate: number }>(
    `SELECT ${columns.join(',')},(${bytes}) AS logical_bytes_estimate FROM ${table.key}
     ${keyset} ORDER BY ${columns.join(',')} LIMIT ?`,
    ...(cursor ?? []),
    FORWARD_STORAGE_STATS_SLICE_SIZE + 1,
  );
  const consumed = rows.slice(0, FORWARD_STORAGE_STATS_SLICE_SIZE);
  const hasMore = rows.length > FORWARD_STORAGE_STATS_SLICE_SIZE;
  const last = consumed.at(-1);
  const nextCursor = last === undefined ? cursor : columns.map((column) => last[column]);
  const rowsSeen = progress.rows_seen + consumed.length;
  const bytesSeen = progress.logical_bytes_seen + consumed.reduce((sum, row) => sum + row.logical_bytes_estimate, 0);

  db.run(
    `UPDATE forward_storage_scan SET cursor_json=?,rows_seen=?,logical_bytes_seen=?,complete=? WHERE table_key=?`,
    nextCursor === null ? null : JSON.stringify(nextCursor),
    rowsSeen,
    bytesSeen,
    hasMore ? 0 : 1,
    table.key,
  );
  return !hasMore;
}

/** Advances a bounded keyset cycle; returns true only when a complete snapshot is published. */
export function refreshForwardStorageStats(db: Db, now: number): boolean {
  const lastRefresh = readCounter(db, 'refreshed_at_ms');
  if (lastRefresh !== null && now >= lastRefresh && now - lastRefresh < FORWARD_STORAGE_STATS_REFRESH_MS) return false;

  return db.tx(() => {
    const checked = readCounter(db, 'refreshed_at_ms');
    if (checked !== null && now >= checked && now - checked < FORWARD_STORAGE_STATS_REFRESH_MS) return false;

    for (const table of TABLES) {
      db.run('INSERT OR IGNORE INTO forward_storage_scan(table_key) VALUES (?)', table.key);
      const progress = db.one<ProgressRow>(
        'SELECT cursor_json,rows_seen,logical_bytes_seen,complete FROM forward_storage_scan WHERE table_key=?',
        table.key,
      );
      if (progress === null) throw new Error(`missing forwarding scan progress for ${table.key}`);
      if (progress.complete === 0) scanTablePage(db, table, progress);
    }

    const remaining = db.one<{ n: number }>('SELECT count(*) AS n FROM forward_storage_scan WHERE complete=0')?.n;
    if (remaining === undefined) throw new Error('missing forwarding scan state');
    if (remaining !== 0) return false;

    for (const table of TABLES) {
      const progress = db.one<{ rows_seen: number; logical_bytes_seen: number }>(
        'SELECT rows_seen,logical_bytes_seen FROM forward_storage_scan WHERE table_key=?',
        table.key,
      );
      if (progress === null) throw new Error(`missing completed forwarding scan for ${table.key}`);
      writeCounter(db, `${table.key}_rows`, progress.rows_seen);
      writeCounter(db, `${table.key}_logical_bytes_estimate`, progress.logical_bytes_seen);
    }
    writeCounter(db, 'refreshed_at_ms', now);
    db.run('UPDATE forward_storage_scan SET cursor_json=NULL,rows_seen=0,logical_bytes_seen=0,complete=0');
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
