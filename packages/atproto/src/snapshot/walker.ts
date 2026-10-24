// The resumable, range-bounded MST walk (ADR 0004 §5.7 steps 4–7, §7 step 4).
//
// `step` continues an in-order walk of the signed MST under a verified commit,
// restricted to one key range (`prefixRange`), and returns the next ordered
// chunk of `(key, cid, recordBytes?)` entries with the key interval it covers.
// The state between steps is plain JSON: the frontier stack, the last key
// handled, and the head it walks. Memory per step is bounded by the stack and
// the fetch batch, never by the repository; there is no record-count ceiling.
//
// What the walk proves:
//   - It starts at `commit.data` and descends only through links in nodes it
//     has hash-checked, so every node and every record is signed.
//   - It expands only subtrees whose key bounds overlap the range; every other
//     subtree is never requested. Skipping is sound because MST keys are
//     sorted: a subtree between keys a and b holds only keys in (a, b).
//   - Every MST node must be well-formed: a dag-cbor map `{l, e}` with `l` a
//     dag-cbor link or null, and entries `{p, k, v, t}` (p a non-negative
//     integer at most the previous key's length and exactly the shared-prefix
//     length — canonical prefix compression —, k bytes, v a link, t a dag-cbor
//     link or null). Keys are atproto repo paths (`collection/rkey` charset,
//     ≤ 1024 bytes), strictly ascending within the node and strictly inside
//     the bounds the parent gives the subtree, so keys ascend across the whole
//     walk and across steps.
//   - Layers: all keys of a node share one layer (the leading zero bit-pairs
//     of sha256(key)); the root's layer is its keys'; a child sits exactly one
//     layer below its parent; a layer-0 node has no subtrees; only the root
//     may be keyless without a left link (the empty tree), and a keyless root
//     with a left link is refused (non-canonical, indeterminate height).
//   - Depth from the root is at most 256, and no node CID is expanded twice in
//     a step. (Across steps a repeated node is impossible: its keys would have
//     to fall in two disjoint bound intervals.)
//   - A node or record block the source does not return is `missing_block`;
//     nothing is ever treated as absent because a block is missing. A block
//     whose bytes do not hash to its CID is `cid_mismatch`.
//
// A record block is fetched only for an included key whose CID differs from
// `knownCid(key)`; unchanged records are emitted without bytes, so a
// re-snapshot costs in proportion to what changed. MST nodes are written to
// the BlockCache and read back from it in later steps.
//
// Budget: at most `maxFetches` calls to `source.get` (each with at most
// `batchSize` ≤ 100 CIDs) and at most `maxEntries` entries per step. A step
// always makes progress while its budget allows at least one fetch.

import { BytesWrapper, CidLinkWrapper, decode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { type VerifiedCommit, VerifyError } from '../verify/types';
import { type BlockCache, type BlockSource, parseBlockCid, verifyBlock } from './block-source';
import { inRange, type KeyRange, overlaps } from './range';

export const WALK_STATE_VERSION = 1;
/** Maximum node depth below the root (the root is depth 0). */
export const MAX_MST_DEPTH = 256;
/** Maximum CIDs per `source.get` (the getBlocks batch limit). */
export const MAX_BATCH = 100;
/** Longest MST key, in bytes (the Rust oracle's bound). */
export const MAX_KEY_BYTES = 1024;
/** Stack items one fetch look-ahead may visit. */
const MAX_LOOKAHEAD_ITEMS = 20_000;

/** A subtree still to be expanded: its node CID, the open key bounds its keys must lie in, layer and depth. */
export interface NodeItem {
  t: 'n';
  cid: string;
  lo: string | null;
  hi: string | null;
  /** Layer the node must have; null only for the root (taken from its keys). */
  layer: number | null;
  depth: number;
}

/** An in-range leaf still to be handled. */
export interface LeafItem {
  t: 'e';
  key: string;
  cid: string;
}

export type StackItem = NodeItem | LeafItem;

/** JSON-serialisable walk frontier. The stack's last element is the next item in key order. */
export interface WalkState {
  v: typeof WALK_STATE_VERSION;
  headCid: string;
  headRev: string;
  dataCid: string;
  range: KeyRange;
  stack: StackItem[];
  /** Greatest in-range key handled so far (emitted or skipped); null before the first. */
  lastKey: string | null;
}

export interface WalkEntry {
  /** `collection/rkey` */
  key: string;
  cid: string;
  /** The CID-verified record block; present only when `knownCid(key)` differed from `cid`. */
  recordBytes?: Uint8Array;
}

export interface StepOptions {
  /** Maximum `source.get` calls in this step (≥ 1). */
  maxFetches: number;
  /** Maximum entries returned by this step (≥ 1). */
  maxEntries: number;
  /** The CID currently stored for `key`, or null; equal CIDs are not fetched. */
  knownCid(key: string): string | null;
  /**
   * Which in-range keys to emit (default: all). Others are walked past and
   * covered by the interval, but neither emitted nor fetched.
   */
  include?(key: string): boolean;
  /** CIDs per `source.get`, 1..100 (default 100). */
  batchSize?: number;
}

export interface StepResult {
  /** Ordered by key; every key lies in `interval`. */
  entries: WalkEntry[];
  /**
   * The keys this step covered: every in-range key k with lo < k ≤ hi (lo null
   * = from the start of the range; hi null = through the end of the range).
   * Every signed key in it that `include` admits is in `entries`. Null when
   * the step covered no key (budget spent before reaching one, and not done).
   */
  interval: [lo: string | null, hi: string | null] | null;
  state: WalkState;
  done: boolean;
  /** `source.get` calls made. */
  fetches: number;
}

const invalid = (msg: string) => new VerifyError('mst_invalid', msg);

/** The state that walks `range` of the MST under `commit`, after key `after` (exclusive) when given. */
export function initialState(commit: VerifiedCommit, range: KeyRange, o: { after?: string | null } = {}): WalkState {
  if (!(range[0] < range[1])) throw new RangeError('empty key range');
  return {
    v: WALK_STATE_VERSION,
    headCid: commit.cid,
    headRev: commit.rev,
    dataCid: commit.dataCid,
    range: [range[0], range[1]],
    stack: [{ t: 'n', cid: commit.dataCid, lo: null, hi: null, layer: null, depth: 0 }],
    lastKey: o.after ?? null,
  };
}

// ---------------------------------------------------------------------------
// State shape checks (the frontier comes back from storage)
// ---------------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function checkState(state: WalkState): void {
  const s = state as unknown as Record<string, unknown>;
  const range = s.range as unknown;
  if (
    s.v !== WALK_STATE_VERSION ||
    !isStr(s.headCid) ||
    !isStr(s.headRev) ||
    !isStr(s.dataCid) ||
    !Array.isArray(range) ||
    range.length !== 2 ||
    !isStr(range[0]) ||
    !isStr(range[1]) ||
    !(range[0] < range[1]) ||
    !Array.isArray(s.stack) ||
    !isNullableStr(s.lastKey)
  ) {
    throw new TypeError('malformed walk state');
  }
  for (const item of s.stack as unknown[]) {
    const i = item as Record<string, unknown> | null;
    const ok =
      i !== null &&
      typeof i === 'object' &&
      ((i.t === 'n' &&
        isStr(i.cid) &&
        isNullableStr(i.lo) &&
        isNullableStr(i.hi) &&
        (i.layer === null || isNat(i.layer)) &&
        isNat(i.depth)) ||
        (i.t === 'e' && isStr(i.key) && isStr(i.cid)));
    if (!ok) throw new TypeError('malformed walk state stack item');
  }
}

// ---------------------------------------------------------------------------
// MST nodes
// ---------------------------------------------------------------------------

interface DecodedNode {
  left: string | null;
  keys: string[];
  values: string[];
  /** right[i] is the subtree after keys[i]. */
  right: (string | null)[];
}

const isLink = (v: unknown): v is CidLinkWrapper => v instanceof CidLinkWrapper;
const isMap = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof CidLinkWrapper) &&
  !(v instanceof BytesWrapper);

/** A subtree link: a dag-cbor sha2-256 CID (an MST node can be nothing else). */
function nodeLink(owner: string, v: CidLinkWrapper): string {
  const cid = v.$link;
  let parsed: CID.Cid;
  try {
    parsed = parseBlockCid(cid);
  } catch {
    throw invalid(`MST node ${owner}: subtree link ${cid} is not a supported CID`);
  }
  if (parsed.codec !== CID.CODEC_DCBOR) throw invalid(`MST node ${owner}: subtree link ${cid} is not dag-cbor`);
  return cid;
}

/** The atproto repo-path charset: `[A-Za-z0-9_~.:-]+/[A-Za-z0-9_~.:-]+`, as bytes. */
function keyChar(b: number): boolean {
  return (
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x30 && b <= 0x3a) || // 0-9 and ':'
    b === 0x2d || // '-'
    b === 0x2e || // '.'
    b === 0x5f || // '_'
    b === 0x7e // '~'
  );
}

function keyString(owner: string, bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_KEY_BYTES) {
    throw invalid(`MST node ${owner}: key of ${bytes.length} bytes`);
  }
  let slash = -1;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x2f && slash === -1) slash = i;
    else if (!keyChar(b)) throw invalid(`MST node ${owner}: key byte 0x${b.toString(16)} is not a repo-path character`);
  }
  if (slash <= 0 || slash === bytes.length - 1) throw invalid(`MST node ${owner}: key is not collection/rkey`);
  return String.fromCharCode(...bytes);
}

function decodeNode(cid: string, bytes: Uint8Array): DecodedNode {
  let node: unknown;
  try {
    node = decode(bytes);
  } catch (e) {
    throw invalid(`MST node ${cid} is not dag-cbor: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isMap(node) || !Array.isArray(node.e) || !('l' in node)) throw invalid(`MST node ${cid} is not a node`);
  const l = node.l;
  if (l !== null && !isLink(l)) throw invalid(`MST node ${cid}: l is not a link or null`);
  const out: DecodedNode = { left: l === null ? null : nodeLink(cid, l), keys: [], values: [], right: [] };
  let prev: Uint8Array = new Uint8Array(0);
  node.e.forEach((entry: unknown, i) => {
    if (!isMap(entry)) throw invalid(`MST node ${cid}: e[${i}] is not a map`);
    const { p, k, v, t } = entry;
    if (typeof p !== 'number' || !Number.isSafeInteger(p) || p < 0 || p > prev.length) {
      throw invalid(`MST node ${cid}: e[${i}].p is not a prefix length of the previous key`);
    }
    if (!(k instanceof BytesWrapper)) throw invalid(`MST node ${cid}: e[${i}].k is not bytes`);
    if (!isLink(v)) throw invalid(`MST node ${cid}: e[${i}].v is not a link`);
    if (!('t' in entry) || (t !== null && !isLink(t)))
      throw invalid(`MST node ${cid}: e[${i}].t is not a link or null`);
    const suffix = k.buf;
    if (suffix.length > 0 && p < prev.length && suffix[0] === prev[p]) {
      throw invalid(`MST node ${cid}: e[${i}].p is shorter than the shared prefix (non-canonical compression)`);
    }
    if (p + suffix.length > MAX_KEY_BYTES) throw invalid(`MST node ${cid}: e[${i}] key is too long`);
    const keyBytes = new Uint8Array(p + suffix.length);
    keyBytes.set(prev.subarray(0, p), 0);
    keyBytes.set(suffix, p);
    const key = keyString(cid, keyBytes);
    const last = out.keys.at(-1);
    if (last !== undefined && !(key > last)) throw invalid(`MST node ${cid}: keys out of order at ${key}`);
    out.keys.push(key);
    out.values.push(v.$link);
    out.right.push(t === null ? null : nodeLink(cid, t as CidLinkWrapper));
    prev = keyBytes;
  });
  return out;
}

/** MST layer of a key: leading zero bit-pairs of sha256(key). */
export function keyLayer(key: string): number {
  const bytes = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) bytes[i] = key.charCodeAt(i);
  const hash = CID.createSync(CID.CODEC_RAW, bytes).digest.contents;
  let zeros = 0;
  for (const byte of hash) {
    zeros += Math.clz32(byte) - 24;
    if (byte !== 0) break;
  }
  return zeros >>> 1;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

function checkPositive(name: string, v: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new RangeError(`${name} must be an integer in [1, ${max}]`);
}

/**
 * Advance the walk by one bounded chunk. Pure in `state` (a new state is
 * returned); writes fetched MST nodes to `cache`. Throws VerifyError
 * (`missing_block`, `cid_mismatch`, `mst_invalid`, `car_malformed`) or the
 * source's own errors; on a throw nothing of the step is returned, and the
 * previous state remains a valid resume point.
 */
export async function step(
  state: WalkState,
  source: BlockSource,
  cache: BlockCache,
  opts: StepOptions,
): Promise<StepResult> {
  checkState(state);
  checkPositive('maxFetches', opts.maxFetches);
  checkPositive('maxEntries', opts.maxEntries);
  const batchSize = opts.batchSize ?? MAX_BATCH;
  checkPositive('batchSize', batchSize, MAX_BATCH);

  const range: KeyRange = [state.range[0], state.range[1]];
  const stack: StackItem[] = state.stack.map((i) => ({ ...i }));
  const startKey = state.lastKey;
  let lastKey = state.lastKey;
  const entries: WalkEntry[] = [];
  let fetches = 0;

  // Blocks available to this step: fetched now, or read (and re-verified) from the cache.
  const local = new Map<string, Uint8Array>();
  const notCached = new Set<string>();
  const available = (cid: string): Uint8Array | null => {
    const hit = local.get(cid);
    if (hit !== undefined) return hit;
    if (notCached.has(cid)) return null;
    const bytes = cache.get(cid);
    if (bytes === null) {
      notCached.add(cid);
      return null;
    }
    verifyBlock(cid, bytes);
    local.set(cid, bytes);
    return bytes;
  };

  const includeMemo = new Map<string, boolean>();
  const included = (key: string): boolean => {
    let v = includeMemo.get(key);
    if (v === undefined) {
      v = opts.include ? opts.include(key) : true;
      includeMemo.set(key, v);
    }
    return v;
  };
  const knownMemo = new Map<string, string | null>();
  const known = (key: string): string | null => {
    if (!knownMemo.has(key)) knownMemo.set(key, opts.knownCid(key));
    return knownMemo.get(key)!;
  };
  /** A leaf whose record block must be fetched. */
  const needsRecord = (leaf: LeafItem): boolean => included(leaf.key) && known(leaf.key) !== leaf.cid;

  const decoded = new Map<string, DecodedNode>();
  const expanded = new Set<string>();

  /**
   * The validated in-order children of a node item that can hold an
   * unhandled in-range key: subtrees whose bounds overlap the range, and
   * in-range leaves.
   */
  function childrenOf(item: NodeItem, bytes: Uint8Array): StackItem[] {
    if (item.depth > MAX_MST_DEPTH) throw invalid(`MST node ${item.cid} is deeper than ${MAX_MST_DEPTH}`);
    let node = decoded.get(item.cid);
    if (node === undefined) {
      node = decodeNode(item.cid, bytes);
      decoded.set(item.cid, node);
    }

    let nodeLayer: number | null = null;
    for (const key of node.keys) {
      const layer = keyLayer(key);
      if (nodeLayer === null) nodeLayer = layer;
      else if (layer !== nodeLayer) throw invalid(`MST node ${item.cid}: keys of layers ${nodeLayer} and ${layer}`);
    }
    let layer: number;
    if (item.layer === null) {
      if (nodeLayer === null) {
        if (node.left !== null) throw invalid(`MST root ${item.cid} has no keys but a subtree`);
        return []; // the empty tree
      }
      layer = nodeLayer;
    } else {
      layer = item.layer;
      if (nodeLayer !== null && nodeLayer !== layer) {
        throw invalid(`MST node ${item.cid} has layer ${nodeLayer}, expected ${layer}`);
      }
      if (nodeLayer === null && node.left === null) throw invalid(`MST node ${item.cid} is empty`);
    }
    if (node.left !== null || node.right.some((s) => s !== null)) {
      if (layer === 0) throw invalid(`MST node ${item.cid} is at layer 0 but has a subtree`);
      if (item.depth + 1 > MAX_MST_DEPTH) throw invalid(`MST node ${item.cid}: subtree deeper than ${MAX_MST_DEPTH}`);
    }
    for (const key of node.keys) {
      if ((item.lo !== null && !(key > item.lo)) || (item.hi !== null && !(key < item.hi))) {
        throw invalid(`MST node ${item.cid}: key ${key} lies outside its subtree's bounds`);
      }
    }

    const children: StackItem[] = [];
    const subtree = (cid: string | null, lo: string | null, hi: string | null) => {
      if (cid === null || !overlaps(range, lo, hi)) return;
      if (lastKey !== null && hi !== null && !(hi > lastKey)) return;
      children.push({ t: 'n', cid, lo, hi, layer: layer - 1, depth: item.depth + 1 });
    };
    subtree(node.left, item.lo, node.keys[0] ?? item.hi);
    node.keys.forEach((key, i) => {
      if (inRange(range, key) && (lastKey === null || key > lastKey)) {
        children.push({ t: 'e', key, cid: node.values[i]! });
      }
      subtree(node.right[i]!, key, node.keys[i + 1] ?? item.hi);
    });
    return children;
  }

  function expand(item: NodeItem, bytes: Uint8Array): void {
    if (expanded.has(item.cid)) throw invalid(`MST node ${item.cid} is linked twice (repeated node CID)`);
    expanded.add(item.cid);
    const children = childrenOf(item, bytes);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }

  /**
   * The CIDs the walk will need next, in key order: a look-ahead over the
   * stack that also descends through nodes already at hand, so one fetch can
   * serve several levels and many leaves. It stops at `batchSize` CIDs and at
   * the entries this step may still emit.
   */
  function collectNeeded(): { nodes: Set<string>; records: Set<string> } {
    const nodes = new Set<string>();
    const records = new Set<string>();
    let horizon = opts.maxEntries - entries.length;
    const work: StackItem[] = stack.slice();
    let scan = MAX_LOOKAHEAD_ITEMS;
    while (work.length > 0 && nodes.size + records.size < batchSize && scan-- > 0) {
      const item = work.pop()!;
      if (item.t === 'n') {
        const bytes = available(item.cid);
        if (bytes === null) {
          nodes.add(item.cid);
          continue;
        }
        const children = childrenOf(item, bytes);
        for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!);
        continue;
      }
      if (!included(item.key)) continue;
      if (horizon-- <= 0) break;
      if (needsRecord(item) && available(item.cid) === null) records.add(item.cid);
    }
    return { nodes, records };
  }

  walk: while (stack.length > 0 && entries.length < opts.maxEntries) {
    // Handle every item whose block is at hand.
    for (;;) {
      if (stack.length === 0 || entries.length >= opts.maxEntries) break walk;
      const top = stack[stack.length - 1]!;
      if (top.t === 'n') {
        const bytes = available(top.cid);
        if (bytes === null) break;
        stack.pop();
        expand(top, bytes);
        continue;
      }
      let recordBytes: Uint8Array | undefined;
      if (needsRecord(top)) {
        const bytes = available(top.cid);
        if (bytes === null) break;
        recordBytes = bytes;
      }
      stack.pop();
      if (lastKey !== null && !(top.key > lastKey)) throw invalid(`MST key ${top.key} does not follow ${lastKey}`);
      lastKey = top.key;
      if (included(top.key))
        entries.push(recordBytes ? { key: top.key, cid: top.cid, recordBytes } : { key: top.key, cid: top.cid });
    }

    // The next item needs a block: fetch a batch, if the budget allows.
    if (fetches >= opts.maxFetches) break;
    const { nodes, records } = collectNeeded();
    const wanted = [...nodes, ...records];
    if (wanted.length === 0) throw new Error('walker invariant: the next item needs a block but none was collected');
    const got = await source.get(wanted);
    fetches++;
    for (const cid of wanted) {
      const bytes = got.get(cid);
      if (bytes === undefined) {
        throw new VerifyError(
          'missing_block',
          `${nodes.has(cid) ? 'MST node' : 'record block'} ${cid} is missing from the block source`,
        );
      }
      verifyBlock(cid, bytes);
      local.set(cid, bytes);
      notCached.delete(cid);
      if (nodes.has(cid)) cache.put(cid, bytes);
    }
  }

  const done = stack.length === 0;
  const progressed = lastKey !== startKey;
  return {
    entries,
    interval: done ? [startKey, null] : progressed ? [startKey, lastKey] : null,
    state: { ...state, range, stack, lastKey },
    done,
    fetches,
  };
}
