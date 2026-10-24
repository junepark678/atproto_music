// Public visibility, as SQL fragments every reader composes (ADR 0004 §5.3,
// §5.6, §5.8; docs/profiles.md). One definition, so history, feeds, lookup,
// stats, profiles, follow lists and export cannot disagree:
//
// - A user is visible when `active = 1` and no suppression row exists. Users
//   start inactive until a complete snapshot (completeSnapshot), and
//   deactivation sets active = 0 at once (markInactive). Disconnect deletes
//   the users row and keeps a suppression marker; the NOT EXISTS keeps that
//   rule explicit even for a row that somehow survived.
// - A scrobble is visible when its owner is visible. Only verified present,
//   valid rows exist in `scrobbles` (excluded and absent records are deleted
//   and live in record_state), so no per-row state filter is needed.
// - A follow edge is visible when both its actor and its subject are visible
//   users. Other owners' follows of a disconnected or inactive DID stay
//   stored but hidden.
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

/** `FROM` source of visible scrobbles: `scrobbles <s> JOIN users <u>` on a visible owner. */
export function visibleScrobblesFrom(s = 's', u = 'u'): string {
  const sa = ident(s);
  const ua = ident(u);
  return `scrobbles ${sa} JOIN users ${ua} ON ${ua}.did = ${sa}.did AND ${activeUser(ua)}`;
}

/** The follows row aliased `f` is a visible edge: actor and subject are both visible users. */
export function visibleFollowEdge(f = 'f'): string {
  const a = ident(f);
  return `(${visibleDid(`${a}.actor`, `${a}_actor`)} AND ${visibleDid(`${a}.subject`, `${a}_subject`)})`;
}
