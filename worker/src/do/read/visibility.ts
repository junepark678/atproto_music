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
//   running, blocked or failed `scrobble.delete` operation. A pending or
//   failed local intent hides whatever is projected for its targets.
// - Succeeded removals (migration 12, outbox/removal-fence.ts): every
//   current removal settles only with an ordered completion boundary
//   `removal_done_rev`, a revision at or after which its targets were proven
//   absent: the commit of a write whose swapCommit/swapRecord the PDS
//   enforced, the head of a stable head/read/head bracket around an absent
//   read (or a head read after an earlier completion), or a verified absence
//   after the send fence. A projected target at a revision <= that boundary
//   is the removed (or an already superseded) incarnation, whatever its CID:
//   a delayed proof of an intermediate version this index never saw stays
//   hidden, and so does one restored before the write. A target projected
//   above the boundary is a later incarnation and is visible, at the same or
//   a new CID, even when its proof arrived before local settlement. Neither
//   settlement time nor CIDs order anything. The boundary is owner-PDS
//   metadata of this receipt only: it never writes record_state or verified
//   membership, and a successful `record_not_ours` receipt has none.
// - Receipts settled under migration 11 (a server-checked `removal_head_rev`,
//   no `removal_done_rev`) keep its rule: hidden at or below that head, or
//   below the reported `removal_commit_rev`.
// - Receipts settled before migration 11 (no `removal_head_rev`) keep their
//   recorded rules: they hide a projection at the CID the delete used as
//   `swapRecord` or at a batch removal's pre-write evidence CIDs
//   (`listen_removal_cids`), until verified membership records an absence of
//   the entry (or single record) newer than their fence `removal_fence_rev`
//   (migration 10), after which any present row is a later incarnation.
//   Proof-confirmed absence removes the projection row, so this query-time
//   overlay never writes a false `record_state=absent` claim.
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

/**
 * Legacy receipts only (no server-checked head): the removal operation aliased
 * `d` has been outlived by the scrobble row aliased `s`: verified membership
 * proves the entry (or single record) absent at a revision newer than the
 * removal's fence, so the row is a later incarnation. A NULL fence (nothing
 * verified when it was admitted or written) is outlived by any verified
 * absence.
 */
function outlived(d: string, s: string): string {
  return `EXISTS (SELECT 1 FROM verified_membership vm
      WHERE vm.record_uri = coalesce(${s}.record_uri, ${s}.uri) AND vm.listen_id = coalesce(${s}.listen_id, '*')
        AND vm.last_absent_revision IS NOT NULL
        AND (${d}.removal_fence_rev IS NULL OR vm.last_absent_revision > ${d}.removal_fence_rev))`;
}

/**
 * The succeeded removal aliased `d` still suppresses the projected row `s`.
 * With an ordered completion boundary (migration 12): `s` was verified at or
 * below it. Settled under migration 11 (a server-checked head, no boundary):
 * at or below that head (or below the reported commit). Without either
 * (settled before migration 11): `legacyMatch` (its CID evidence) and not
 * outlived.
 */
function removedBy(d: string, s: string, legacyMatch: string): string {
  return `(CASE WHEN ${d}.removal_done_rev IS NOT NULL THEN ${s}.revision <= ${d}.removal_done_rev
    WHEN ${d}.removal_head_rev IS NOT NULL
      THEN (${s}.revision <= ${d}.removal_head_rev
        OR (${d}.removal_commit_rev IS NOT NULL AND ${s}.revision < ${d}.removal_commit_rev))
      ELSE ((${legacyMatch}) AND NOT ${outlived(d, s)}) END)`;
}
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
 * running, blocked, or failed. After PDS success, it hides only projections
 * of the incarnation it removed (`removedBy`): one verified at or below its
 * server-checked head, or for a legacy receipt one at its evidence CIDs not
 * yet outlived; a later recreation at the same rkey is visible. A failed PDS
 * write is still not a public record; the operation endpoint is the place to
 * report its failure. The verified projection is unchanged until remote proof
 * confirms the deletion.
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
          OR (d.state = 'succeeded' AND ${removedBy(
            'd',
            sa,
            `d.swap_cid = ${sa}.cid
            OR EXISTS (SELECT 1 FROM listen_removal_cids e WHERE e.operation_id = d.id AND e.cid = ${sa}.cid)`,
          )})
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM listen_removals AS lr
      LEFT JOIN operations AS ro ON ro.id = lr.operation_id
      WHERE lr.did = ${sa}.did AND lr.record_uri = ${sa}.record_uri
        AND (lr.listen_id = ${sa}.listen_id OR lr.listen_id = '*')
        AND (ro.id IS NULL OR ro.state IN ('queued','running','blocked','failed')
          OR (ro.state = 'succeeded' AND ${removedBy(
            'ro',
            sa,
            `lr.removed_cid = ${sa}.cid
            OR EXISTS (SELECT 1 FROM listen_removal_cids le WHERE le.operation_id = ro.id AND le.cid = ${sa}.cid)`,
          )}))
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
            AND (sd.state IN ('queued','running','blocked','failed')
              OR (sd.state = 'succeeded' AND ${removedBy('sd', 'one', 'sd.swap_cid = one.cid')}))
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
