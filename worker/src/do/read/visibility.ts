// Public visibility, as SQL fragments every reader composes (ADR 0004 §5.3,
// §5.6, §5.8; docs/profiles.md). One definition, so history, feeds, lookup,
// stats, profiles, follow lists and export cannot disagree:
//
// - A user is visible when `active = 1` and no suppression row exists. Users
//   start inactive until a complete snapshot (completeSnapshot), and
//   deactivation sets active = 0 at once (markInactive). Disconnect deletes
//   the users row and keeps a suppression marker; the NOT EXISTS keeps that
//   rule explicit even for a row that somehow survived.
// - A scrobble is visible when its owner is visible and it has no queued,
//   running, blocked or failed `scrobble.delete` operation. After a PDS success,
//   the row stays hidden while the verified projection still contains the CID
//   that the delete used as `swapRecord`; a successful `record_not_ours` receipt
//   has no such CID and cannot hide another writer's record. Proof-confirmed
//   absence removes the projection row, so this query-time overlay never writes
//   a false `record_state=absent` claim.
// - A follow edge is visible when its actor is a visible user and its subject
//   is not hidden: the subject has no suppression row and no users row with
//   active = 0 (the Rust oracle, crates/storage/src/repositories/follows.rs
//   VISIBLE, public.rs public_counts and export.rs). A subject DID with no
//   users row at all (an account never indexed here) stays visible, so
//   counts, follow lists and the export keep the owner's indexed follow
//   records. Other owners' follows of a disconnected (suppressed) or inactive
//   DID stay stored but hidden.
//
// Fragments interpolate only aliases and column names checked against a
// strict identifier pattern; values are always bound parameters.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function ident(alias: string): string {
  if (!IDENT.test(alias)) throw new RangeError(`invalid SQL alias ${JSON.stringify(alias)}`);
  return alias;
}

function column(name: string): string {
  if (!COLUMN.test(name)) throw new RangeError(`invalid SQL column ${JSON.stringify(name)}`);
  return name;
}

/** The users row aliased `alias` is publicly visible. */
export function activeUser(alias = 'u'): string {
  const a = ident(alias);
  return `(${a}.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = ${a}.did))`;
}

/** The DID in `didColumn` belongs to a visible user (a correlated EXISTS over `users`). */
export function visibleDid(didColumn: string, alias = 'v'): string {
  const a = ident(alias);
  return `EXISTS (SELECT 1 FROM users ${a} WHERE ${a}.did = ${column(didColumn)} AND ${activeUser(a)})`;
}

/**
 * `FROM` source of publicly visible scrobbles. A local delete intent hides its
 * target as soon as it is durably admitted, and remains hidden while queued,
 * running, blocked, or failed. After PDS success, it stays hidden only while
 * the projected CID still matches the persisted swap CID; this prevents an old
 * successful delete receipt from hiding a later recreation at the same rkey.
 * A failed PDS write is still not a public record; the operation endpoint is
 * the place to report its failure. The verified projection is unchanged until
 * remote proof confirms the deletion.
 */
export function visibleScrobblesFrom(s = 's', u = 'u'): string {
  const sa = ident(s);
  const ua = ident(u);
  return `scrobbles ${sa} JOIN users ${ua}
    ON ${ua}.did = ${sa}.did AND ${activeUser(ua)}
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = ${sa}.did AND d.rkey = ${sa}.rkey
        AND d.collection = CASE WHEN ${sa}.record_uri IS NOT NULL
          THEN substr(${sa}.record_uri, length('at://' || ${sa}.did || '/') + 1,
            instr(substr(${sa}.record_uri, length('at://' || ${sa}.did || '/') + 1), '/') - 1)
          ELSE substr(${sa}.uri, length('at://' || ${sa}.did || '/') + 1,
            instr(substr(${sa}.uri, length('at://' || ${sa}.did || '/') + 1), '/') - 1) END
        AND d.kind = 'scrobble.delete'
        AND (NOT EXISTS (SELECT 1 FROM batch_delete_listens bd WHERE bd.operation_id = d.id)
          OR EXISTS (SELECT 1 FROM batch_delete_listens bd WHERE bd.operation_id = d.id
            AND (bd.listen_id = '*' OR bd.listen_id = ${sa}.listen_id)))
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = ${sa}.cid)
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM listen_removals AS lr
      LEFT JOIN operations AS ro ON ro.id = lr.operation_id
      WHERE lr.did = ${sa}.did AND lr.record_uri = ${sa}.record_uri AND lr.listen_id = ${sa}.listen_id
        AND (ro.id IS NULL OR ro.state IN ('queued','running','blocked','failed')
          OR (ro.state = 'succeeded' AND lr.removed_cid = ${sa}.cid))
    )
    AND (${sa}.listen_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM scrobbles AS one
      WHERE one.did = ${sa}.did AND one.record_uri IS NULL
        AND one.artist_key = ${sa}.artist_key AND one.track_key = ${sa}.track_key
        AND one.listened_at >= substr(${sa}.listened_at,1,19)
        AND one.listened_at < substr(${sa}.listened_at,1,19) || 'Z'
        AND NOT EXISTS (
          SELECT 1 FROM operations AS sd
          WHERE sd.did = one.did AND sd.rkey = one.rkey AND sd.kind = 'scrobble.delete'
            AND sd.collection = substr(one.uri, length('at://' || one.did || '/') + 1,
              instr(substr(one.uri, length('at://' || one.did || '/') + 1), '/') - 1)
            AND (sd.state IN ('queued','running','blocked','failed') OR (sd.state = 'succeeded' AND sd.swap_cid = one.cid))
        )
    ))`;
}

/**
 * The follows row aliased `f` is a visible edge: the actor is a visible user and
 * the subject is neither suppressed nor a known inactive user (an unknown
 * subject DID stays visible, as in the Rust oracle).
 */
export function visibleFollowEdge(f = 'f'): string {
  const a = ident(f);
  const sub = `${a}_subject`;
  return (
    `(${visibleDid(`${a}.actor`, `${a}_actor`)}` +
    ` AND NOT EXISTS (SELECT 1 FROM suppression ${sub}_x WHERE ${sub}_x.did = ${a}.subject)` +
    ` AND NOT EXISTS (SELECT 1 FROM users ${sub} WHERE ${sub}.did = ${a}.subject AND ${sub}.active = 0))`
  );
}
