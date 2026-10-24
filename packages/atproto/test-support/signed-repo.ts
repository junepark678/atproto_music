// A real, signed atproto v3 repository for tests (ADR 0004 §7, §10.3). TEST-ONLY.
//
// - The MST is built by @atcute/mst's NodeWrangler over a memory block store, so
//   node layout, key heights and prefix compression are the library's, not ours.
// - Records and commits are canonical dag-cbor (@atcute/cbor); CIDs are CIDv1
//   sha2-256 (@atcute/cid).
// - Commits are `{did, version: 3, data, rev, prev: null, sig}`, signed over the
//   dag-cbor of the unsigned map by a deterministic TestKey (keys.ts).
// - Nothing is fabricated: every CID handed to a test is the hash of bytes this
//   module produced, and every rev is a TID this module assigned.
//
// The corruption helpers at the bottom each change exactly one verification
// invariant of a CAR (ADR 0004 §7.7), mirroring the Rust golden corruptions in
// tests/goldens/signed_cars/manifest.json.

import { type Bytes, decode, encode, toBytes } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { type BlockMap, findRpathAndBuildProof, MemoryBlockStore, MSTNode, NodeStore, NodeWrangler } from '@atcute/mst';
import type { Clock } from '@atmusic/core/deps';
import type { Curve, TestKey } from './keys';

// ---------------------------------------------------------------------------
// Primitives: CIDs, varints, CARs, TIDs
// ---------------------------------------------------------------------------

/** CIDv1 dag-cbor sha2-256 of `bytes`, as a base32 string. */
export function cborCid(bytes: Uint8Array): string {
  return CID.toString(CID.createSync(CID.CODEC_DCBOR, bytes));
}

/** CID string of the dag-cbor encoding of `value` (a record, node or commit). */
export function cidOf(value: unknown): string {
  return cborCid(encode(value));
}

export function encodeVarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`varint out of range: ${n}`);
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function decodeVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (let i = offset; i < bytes.length && i < offset + 9; i++) {
    const b = bytes[i]!;
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return [value, i + 1];
    scale *= 0x80;
  }
  throw new RangeError('truncated or overlong varint');
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface CarSection {
  cid: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Offset of the section's length varint. */
  start: number;
  /** Offset one past the section's last byte. */
  end: number;
}

export interface ParsedCar {
  roots: string[];
  /** Byte offset where the first section starts. */
  headerEnd: number;
  sections: CarSection[];
}

/** Serialize a CARv1: header `{version: 1, roots}`, then `varint(len) ‖ cid ‖ bytes` per block, in order. */
export function encodeCar(roots: readonly string[], blocks: Iterable<readonly [cid: string, bytes: Uint8Array]>) {
  const header = encode({ version: 1, roots: roots.map((r) => CID.toCidLink(CID.fromString(r))) });
  const parts: Uint8Array[] = [encodeVarint(header.length), header];
  for (const [cid, bytes] of blocks) {
    const cidBytes = CID.fromString(cid).bytes;
    parts.push(encodeVarint(cidBytes.length + bytes.length), cidBytes, bytes);
  }
  return concatBytes(parts);
}

/**
 * Parse the CAR this module wrote (or a corruption of it) without checking
 * hashes. Throws on a malformed header or a section that overruns the input.
 * Test-support only; production code uses verify/car-bounds.ts.
 */
export function parseCar(car: Uint8Array): ParsedCar {
  const [headerLen, headerStart] = decodeVarint(car, 0);
  if (headerStart + headerLen > car.length) throw new RangeError('CAR header overruns input');
  const header = decode(car.subarray(headerStart, headerStart + headerLen)) as {
    version?: unknown;
    roots?: Array<{ $link: string }>;
  };
  if (header.version !== 1 || !Array.isArray(header.roots)) throw new TypeError('not a CARv1 header');
  const roots = header.roots.map((r) => r.$link);
  const sections: CarSection[] = [];
  let at = headerStart + headerLen;
  const headerEnd = at;
  while (at < car.length) {
    const start = at;
    const [len, bodyStart] = decodeVarint(car, at);
    const end = bodyStart + len;
    if (end > car.length) throw new RangeError(`CAR section at ${start} overruns input`);
    const [cid, rest] = CID.decodeFirst(car.subarray(bodyStart, end));
    sections.push({ cid: CID.toString(cid), bytes: new Uint8Array(rest), start, end });
    at = end;
  }
  return { roots, headerEnd, sections };
}

/** CAR blocks as a CID → bytes map (last one wins for a repeated CID). */
export function carBlocks(car: Uint8Array): BlockMap {
  const map: BlockMap = new Map();
  for (const s of parseCar(car).sections) map.set(s.cid, s.bytes);
  return map;
}

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** A TID (atproto timestamp identifier) from microseconds since the epoch and a 10-bit clock id. */
export function tidFromMicros(micros: number, clockId = 0): string {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new RangeError(`TID micros out of range: ${micros}`);
  if (!Number.isInteger(clockId) || clockId < 0 || clockId > 1023) throw new RangeError('TID clock id is 10 bits');
  let v = (BigInt(micros) << 10n) | BigInt(clockId);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = TID_ALPHABET[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/** Microseconds encoded in a TID. */
export function tidMicros(tid: string): number {
  if (!TID_RE.test(tid)) throw new SyntaxError(`not a TID: ${tid}`);
  let v = 0n;
  for (const c of tid) v = (v << 5n) | BigInt(TID_ALPHABET.indexOf(c));
  return Number(v >> 10n);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface UnsignedCommit {
  did: string;
  version: number;
  data: CID.CidLink;
  rev: string;
  prev: null;
}

export interface CommitInfo {
  cid: string;
  rev: string;
  /** MST root CID. */
  data: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** did:key of the key that signed it. */
  signedBy: string;
}

/** The exact bytes a commit signature covers: dag-cbor of the commit without `sig`. */
export function unsignedCommitBytes(commit: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const { sig: _sig, ...unsigned } = commit;
  return encode(unsigned);
}

async function signCommit(unsigned: Record<string, unknown>, key: TestKey) {
  const sig = await key.sign(encode(unsigned));
  const bytes = encode({ ...unsigned, sig: toBytes(sig) });
  return { bytes, cid: cborCid(bytes) };
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export type RepoAction = 'create' | 'update' | 'delete';

export interface RepoOp {
  action: RepoAction;
  collection: string;
  rkey: string;
  /** `collection/rkey`, the MST key. */
  path: string;
  /** New record CID; null for a delete. */
  cid: string | null;
  /** Previous record CID; null for a create. */
  prev: string | null;
  /** The record as written (JSON form); absent for a delete. */
  record?: unknown;
}

export interface CommitResult {
  did: string;
  /** Commit CID (the repository head after this commit). */
  cid: string;
  rev: string;
  /** MST root CID. */
  data: string;
  /** Rev of the previous commit, or null for the first. */
  since: string | null;
  ops: RepoOp[];
  /** Blocks this commit added: commit, new MST nodes, new record blocks. */
  blocks: BlockMap;
  /** `blocks` as a CAR rooted at the commit (firehose-style diff). */
  car: Uint8Array<ArrayBuffer>;
}

export type WriteOp =
  | { action: 'put'; collection: string; rkey: string; record: unknown }
  | { action: 'delete'; collection: string; rkey: string };

export interface CommitOptions {
  /** Explicit rev (a TID). Defaults to the next TID from the repo clock. */
  rev?: string;
}

export interface SignedRepoOptions {
  /** Drives TID revs. Defaults to a fixed 2026-01-15T12:00:00Z. */
  clock?: Clock;
  /** TID clock id (0..1023). */
  clockId?: number;
}

const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

export interface MstEntry {
  key: string;
  cid: string;
}

export class SignedRepo {
  readonly store = new MemoryBlockStore();
  private readonly wrangler = new NodeWrangler(new NodeStore(this.store));
  private readonly commits: CommitInfo[] = [];
  private readonly clock: Clock;
  private readonly clockId: number;
  private root: string | null = null;
  /**
   * Tail of the per-repo write chain. Every mutation (writes, gc) runs after
   * the previous one settles, so overlapping callers never start from the
   * same root or reuse a rev.
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly did: string,
    public key: TestKey,
    opts: SignedRepoOptions = {},
  ) {
    this.clock = opts.clock ?? { nowMs: () => FIXTURE_NOW_MS };
    this.clockId = opts.clockId ?? 0;
  }

  /** Current head, or null before the first commit. */
  get head(): CommitInfo | null {
    return this.commits.at(-1) ?? null;
  }

  /** Every commit in order (older ones stay readable until `gc`). */
  get history(): readonly CommitInfo[] {
    return this.commits;
  }

  commitInfo(cid: string): CommitInfo {
    const c = this.commits.find((x) => x.cid === cid);
    if (!c) throw new Error(`unknown commit ${cid} for ${this.did}`);
    return c;
  }

  private requireHead(at?: string): CommitInfo {
    if (at !== undefined) return this.commitInfo(at);
    const h = this.head;
    if (!h) throw new Error(`${this.did} has no commit yet`);
    return h;
  }

  private nextRev(): string {
    const head = this.head;
    let micros = this.clock.nowMs() * 1000;
    if (head && TID_RE.test(head.rev)) micros = Math.max(micros, tidMicros(head.rev) + 1);
    return tidFromMicros(micros, this.clockId);
  }

  /** Swap the signing key; later commits are signed with it (key rotation). */
  rotateKey(key: TestKey): void {
    this.key = key;
  }

  /** One signed commit with a single create/update. */
  put(collection: string, rkey: string, record: unknown, o?: CommitOptions): Promise<CommitResult> {
    return this.writes([{ action: 'put', collection, rkey, record }], o);
  }

  /** One signed commit with a single delete (a delete of an absent key is still a commit, with no op). */
  delete(collection: string, rkey: string, o?: CommitOptions): Promise<CommitResult> {
    return this.writes([{ action: 'delete', collection, rkey }], o);
  }

  /** A signed commit of the current tree with no writes (initial commit, re-sign after rotation). */
  commit(o?: CommitOptions): Promise<CommitResult> {
    return this.writes([], o);
  }

  /** Run `fn` after every earlier mutation of this repo has settled (a promise-chain mutex). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /**
   * Apply `ops` in order and sign them as one commit. Concurrent calls are
   * serialized: each commit builds on the previous one's tree and gets a
   * strictly greater rev.
   */
  writes(ops: readonly WriteOp[], o: CommitOptions = {}): Promise<CommitResult> {
    return this.exclusive(() => this.applyWrites(ops, o));
  }

  private async applyWrites(ops: readonly WriteOp[], o: CommitOptions): Promise<CommitResult> {
    const prevHead = this.head;
    let root = this.root;
    const applied: RepoOp[] = [];
    for (const op of ops) {
      const path = `${op.collection}/${op.rkey}`;
      const prev = root === null ? null : await this.lookup(root, path);
      if (op.action === 'put') {
        const bytes = encode(op.record);
        const cid = cborCid(bytes);
        await this.store.put(cid, bytes);
        root = await this.wrangler.putRecord(root, path, CID.toCidLink(CID.fromString(cid)));
        if (prev !== cid) {
          applied.push({
            action: prev === null ? 'create' : 'update',
            collection: op.collection,
            rkey: op.rkey,
            path,
            cid,
            prev,
            record: op.record,
          });
        }
      } else if (prev !== null && root !== null) {
        root = await this.wrangler.deleteRecord(root, path);
        applied.push({ action: 'delete', collection: op.collection, rkey: op.rkey, path, cid: null, prev });
      }
    }
    if (root === null) {
      const empty = await new NodeStore(this.store).put(MSTNode.empty());
      root = (await empty.cid()).$link;
    }
    const rev = o.rev ?? this.nextRev();
    const unsigned = { did: this.did, version: 3, data: CID.toCidLink(CID.fromString(root)), rev, prev: null };
    const { bytes, cid } = await signCommit(unsigned, this.key);
    await this.store.put(cid, bytes);
    this.root = root;
    this.commits.push({ cid, rev, data: root, bytes, signedBy: this.key.didKey });

    // Diff: everything reachable now that was not reachable from the previous head.
    const before = prevHead ? await this.reachable(prevHead.data) : new Set<string>();
    const blocks: BlockMap = new Map([[cid, bytes]]);
    for (const c of await this.reachable(root)) {
      if (!before.has(c)) blocks.set(c, (await this.store.get(c))!);
    }
    return {
      did: this.did,
      cid,
      rev,
      data: root,
      since: prevHead?.rev ?? null,
      ops: applied,
      blocks,
      car: encodeCar([cid], blocks),
    };
  }

  private async lookup(root: string, path: string): Promise<string | null> {
    const [value] = await findRpathAndBuildProof(new NodeStore(this.store), root, path);
    return value?.$link ?? null;
  }

  /** MST node CIDs and record CIDs reachable from an MST root (the commit is not included). */
  async reachable(root: string): Promise<Set<string>> {
    const out = new Set<string>();
    const ns = new NodeStore(this.store);
    const visit = async (cid: string): Promise<void> => {
      if (out.has(cid)) return;
      out.add(cid);
      const node = await ns.get(cid);
      for (const t of node.subtrees) if (t) await visit(t.$link);
      for (const v of node.values) out.add(v.$link);
    };
    await visit(root);
    return out;
  }

  /** Every MST leaf in key order. */
  async entries(o: { at?: string } = {}): Promise<MstEntry[]> {
    const head = this.requireHead(o.at);
    const ns = new NodeStore(this.store);
    const out: MstEntry[] = [];
    const walk = async (cid: string | null): Promise<void> => {
      if (cid === null) return;
      const node = await ns.get(cid);
      for (let i = 0; i < node.keys.length; i++) {
        await walk(node.subtrees[i]?.$link ?? null);
        out.push({ key: node.keys[i]!, cid: node.values[i]!.$link });
      }
      await walk(node.subtrees[node.keys.length]?.$link ?? null);
    };
    await walk(head.data);
    return out;
  }

  /** Records of one collection in rkey order, with their JSON values. */
  async list(collection: string, o: { at?: string } = {}) {
    const prefix = `${collection}/`;
    const out: Array<{ rkey: string; cid: string; value: unknown }> = [];
    for (const e of await this.entries(o)) {
      if (!e.key.startsWith(prefix)) continue;
      const bytes = await this.store.get(e.cid);
      if (!bytes) throw new Error(`record block ${e.cid} missing (garbage collected?)`);
      out.push({ rkey: e.key.slice(prefix.length), cid: e.cid, value: decode(bytes) });
    }
    return out;
  }

  /** The current record at `collection/rkey`, or null. */
  async getRecord(collection: string, rkey: string, o: { at?: string } = {}) {
    const head = this.requireHead(o.at);
    const cid = await this.lookup(head.data, `${collection}/${rkey}`);
    if (cid === null) return null;
    const bytes = await this.store.get(cid);
    if (!bytes) throw new Error(`record block ${cid} missing (garbage collected?)`);
    return { cid, bytes, value: decode(bytes) as unknown };
  }

  /**
   * A `com.atproto.sync.getRecord` CAR: the commit, the MST path from the root
   * to the key, and the record block when present. For an absent key the path
   * is the complete exclusion proof.
   */
  async getRecordCar(collection: string, rkey: string, o: { at?: string } = {}): Promise<Uint8Array<ArrayBuffer>> {
    const head = this.requireHead(o.at);
    const [value, proof] = await findRpathAndBuildProof(new NodeStore(this.store), head.data, `${collection}/${rkey}`);
    const blocks: Array<[string, Uint8Array]> = [[head.cid, head.bytes]];
    for (const cid of proof) blocks.push([cid, (await this.store.get(cid))!]);
    if (value) {
      const bytes = await this.store.get(value.$link);
      if (!bytes) throw new Error(`record block ${value.$link} missing (garbage collected?)`);
      blocks.push([value.$link, bytes]);
    }
    return encodeCar([head.cid], blocks);
  }

  /** Blocks by CID from the repo's store (`com.atproto.sync.getBlocks`). */
  async getBlocks(cids: readonly string[]): Promise<{ blocks: BlockMap; missing: string[] }> {
    const blocks: BlockMap = new Map();
    const missing: string[] = [];
    for (const cid of cids) {
      const b = await this.store.get(cid);
      if (b) blocks.set(cid, b);
      else missing.push(cid);
    }
    return { blocks, missing };
  }

  /**
   * The whole repository at a commit (`com.atproto.sync.getRepo`): the commit
   * first, then each MST node before its subtrees, records interleaved in key
   * order, so the last block is the record with the greatest key.
   */
  async fullCar(o: { at?: string } = {}): Promise<Uint8Array<ArrayBuffer>> {
    const head = this.requireHead(o.at);
    const ns = new NodeStore(this.store);
    const blocks: Array<[string, Uint8Array]> = [[head.cid, head.bytes]];
    const seen = new Set<string>([head.cid]);
    const add = async (cid: string) => {
      if (seen.has(cid)) return;
      seen.add(cid);
      const b = await this.store.get(cid);
      if (!b) throw new Error(`block ${cid} missing (garbage collected?)`);
      blocks.push([cid, b]);
    };
    const walk = async (cid: string | null): Promise<void> => {
      if (cid === null) return;
      await add(cid);
      const node = await ns.get(cid);
      for (let i = 0; i < node.keys.length; i++) {
        await walk(node.subtrees[i]?.$link ?? null);
        await add(node.values[i]!.$link);
      }
      await walk(node.subtrees[node.keys.length]?.$link ?? null);
    };
    await walk(head.data);
    return encodeCar([head.cid], blocks);
  }

  /**
   * Drop every block not reachable from the current head (what a PDS does after
   * a write). Older commits can no longer be served; getBlocks for their nodes
   * then reports BlockNotFound.
   */
  gc(): Promise<string[]> {
    return this.exclusive(() => this.collect());
  }

  private async collect(): Promise<string[]> {
    const head = this.requireHead();
    const keep = await this.reachable(head.data);
    keep.add(head.cid);
    const dropped = [...this.store.blocks.keys()].filter((c) => !keep.has(c));
    await this.store.deleteMany(dropped);
    return dropped;
  }
}

// ---------------------------------------------------------------------------
// Corruption helpers: each changes exactly one verification invariant.
// ---------------------------------------------------------------------------

/** Curve orders, for the malleable high-S twin. */
const CURVE_ORDER: Record<Curve, bigint> = {
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  p256: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
};

/** The Rust golden oversize: one byte over 8 MiB. */
export const OVERSIZE_CAR_BYTES = 8 * 1024 * 1024 + 1;

export type CorruptionKind =
  | 'signature'
  | 'signature_high_s'
  | 'block_byte'
  | 'mst_node_byte'
  | 'mst_structure'
  | 'did'
  | 'version'
  | 'rev'
  | 'root'
  | 'truncate'
  | 'oversize'
  | 'record_cid_swap'
  | 'drop_block';

function rootOf(parsed: ParsedCar): string {
  const root = parsed.roots[0];
  if (!root) throw new Error('CAR has no root');
  return root;
}

function sectionOf(parsed: ParsedCar, cid: string): CarSection {
  const s = parsed.sections.find((x) => x.cid === cid);
  if (!s) throw new Error(`CAR has no block ${cid}`);
  return s;
}

function rebuild(parsed: ParsedCar, replace: Map<string, [newCid: string, bytes: Uint8Array]>, roots?: string[]) {
  return encodeCar(
    roots ?? parsed.roots,
    parsed.sections.map((s): [string, Uint8Array] => replace.get(s.cid) ?? [s.cid, s.bytes]),
  );
}

function flipLastBit0(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  out[out.length - 1] = (out[out.length - 1] ?? 0) ^ 0x01;
  return out;
}

/** Re-encode the root commit after `mutate`; re-sign with `key` when given, else keep `sig`. */
async function rewriteCommit(
  car: Uint8Array,
  mutate: (commit: Record<string, unknown>) => void,
  key: TestKey | null,
  extra: Map<string, [string, Uint8Array]> = new Map(),
) {
  const parsed = parseCar(car);
  const root = rootOf(parsed);
  const commit = decode(sectionOf(parsed, root).bytes) as Record<string, unknown>;
  mutate(commit);
  let bytes: Uint8Array<ArrayBuffer>;
  if (key) {
    const { sig: _sig, ...unsigned } = commit;
    bytes = (await signCommit(unsigned, key)).bytes;
  } else {
    bytes = encode(commit);
  }
  const cid = cborCid(bytes);
  extra.set(root, [cid, bytes]);
  return rebuild(parsed, extra, [cid, ...parsed.roots.slice(1)]);
}

function sigBytes(commit: Record<string, unknown>): Uint8Array {
  const buf = (commit.sig as { buf?: Uint8Array } | undefined)?.buf;
  if (buf?.length !== 64) throw new Error('commit has no 64-byte sig');
  return buf;
}

/** The root commit of a CAR (decoded), for helpers and assertions. */
export function carCommit(car: Uint8Array): Record<string, unknown> & { data: CID.CidLink; sig: Bytes } {
  const parsed = parseCar(car);
  return decode(sectionOf(parsed, rootOf(parsed)).bytes);
}

/** Bit 0 of the first signature byte flipped; commit re-hashed and the root updated. Breaks only the signature. */
export function corruptSignature(car: Uint8Array) {
  return rewriteCommit(
    car,
    (c) => {
      const sig = new Uint8Array(sigBytes(c));
      sig[0] = (sig[0] ?? 0) ^ 0x01;
      c.sig = toBytes(sig);
    },
    null,
  );
}

/** Signature replaced by its malleable twin (s → n − s): valid ECDSA, forbidden by atproto (low-S only). */
export function corruptSignatureHighS(car: Uint8Array, curve: Curve) {
  return rewriteCommit(
    car,
    (c) => {
      const sig = new Uint8Array(sigBytes(c));
      let s = 0n;
      for (const b of sig.subarray(32)) s = (s << 8n) | BigInt(b);
      let high = CURVE_ORDER[curve] - s;
      for (let i = 63; i >= 32; i--) {
        sig[i] = Number(high & 0xffn);
        high >>= 8n;
      }
      c.sig = toBytes(sig);
    },
    null,
  );
}

/** Bit 0 of the last byte of block `cid` flipped; its CID is unchanged. Breaks only that block's hash. */
export function corruptBlockByte(car: Uint8Array, cid: string): Uint8Array<ArrayBuffer> {
  const parsed = parseCar(car);
  const s = sectionOf(parsed, cid);
  return rebuild(parsed, new Map([[cid, [cid, flipLastBit0(s.bytes)]]]));
}

/** Bit 0 of the last byte of the MST root node (`commit.data`) flipped; CID unchanged. */
export function corruptMstNodeByte(car: Uint8Array): Uint8Array<ArrayBuffer> {
  return corruptBlockByte(car, carCommit(car).data.$link);
}

/**
 * The MST root node's first entry claims prefix length 1 with no previous key.
 * The node is re-hashed and `commit.data` re-signed with `key`, so hashes and
 * signature are valid and only the MST invariant fails.
 */
export async function corruptMstStructure(car: Uint8Array, key: TestKey) {
  const parsed = parseCar(car);
  const dataCid = carCommit(car).data.$link;
  const node = decode(sectionOf(parsed, dataCid).bytes) as { e: Array<{ p: number }> };
  const first = node.e[0];
  if (!first) throw new Error('MST root node has no entries');
  first.p = 1;
  const bytes = encode(node);
  const cid = cborCid(bytes);
  return rewriteCommit(
    car,
    (c) => {
      c.data = CID.toCidLink(CID.fromString(cid));
    },
    key,
    new Map([[dataCid, [cid, bytes]]]),
  );
}

/** Commit `did` replaced and re-signed with the same key. Breaks only the DID binding. */
export function corruptDid(car: Uint8Array, key: TestKey, did = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz') {
  return rewriteCommit(
    car,
    (c) => {
      c.did = did;
    },
    key,
  );
}

/** Commit `version` 2 instead of 3, re-signed. */
export function corruptVersion(car: Uint8Array, key: TestKey, version = 2) {
  return rewriteCommit(
    car,
    (c) => {
      c.version = version;
    },
    key,
  );
}

/** Commit `rev` '1111111111111' (13 characters outside the TID alphabet), re-signed. */
export function corruptRev(car: Uint8Array, key: TestKey, rev = '1111111111111') {
  return rewriteCommit(
    car,
    (c) => {
      c.rev = rev;
    },
    key,
  );
}

/** Header root replaced by a well-formed dag-cbor CID with no block in the CAR; all blocks unchanged. */
export function corruptRoot(car: Uint8Array): Uint8Array<ArrayBuffer> {
  const parsed = parseCar(car);
  const ghost = cidOf({ corruption: 'root', of: rootOf(parsed) });
  return rebuild(parsed, new Map(), [ghost, ...parsed.roots.slice(1)]);
}

/**
 * Cut the CAR inside its final section (default: keep half of that section).
 * Every earlier byte is unchanged, so only well-formedness breaks; for a
 * `fullCar` the final block is the greatest-key record.
 */
export function corruptTruncate(car: Uint8Array, keepOfLastSection?: number): Uint8Array<ArrayBuffer> {
  const parsed = parseCar(car);
  const last = parsed.sections.at(-1);
  if (!last) throw new Error('CAR has no sections to truncate');
  const len = last.end - last.start;
  const keep = keepOfLastSection ?? Math.floor(len / 2);
  if (keep < 1 || keep >= len) throw new RangeError(`keep must be in 1..${len - 1}`);
  return new Uint8Array(car.subarray(0, last.start + keep));
}

/**
 * Append one unreferenced, correctly hashed dag-cbor padding block so the CAR
 * is exactly `totalBytes` long (default 8 MiB + 1, one over the Rust cap).
 */
export async function corruptOversize(car: Uint8Array, totalBytes = OVERSIZE_CAR_BYTES) {
  const room = totalBytes - car.length;
  const cborHead = (n: number) => (n < 24 ? 1 : n < 0x100 ? 2 : n < 0x10000 ? 3 : n < 0x100000000 ? 5 : 9);
  const sectionLen = (n: number) => {
    const body = 36 + cborHead(n) + n;
    return encodeVarint(body).length + body;
  };
  let n = Math.max(0, room - 36 - 9 - 9);
  while (n > 0 && sectionLen(n) > room) n--;
  while (sectionLen(n + 1) <= room) n++;
  if (sectionLen(n) !== room) throw new RangeError(`cannot pad to exactly ${totalBytes} bytes`);
  const bytes = encode(toBytes(new Uint8Array(n)));
  const cid = CID.toString(await CID.create(CID.CODEC_DCBOR, bytes));
  const parsed = parseCar(car);
  const out = encodeCar(parsed.roots, [
    ...parsed.sections.map((s): [string, Uint8Array] => [s.cid, s.bytes]),
    [cid, bytes],
  ]);
  if (out.length !== totalBytes) throw new Error(`oversize CAR is ${out.length} bytes, wanted ${totalBytes}`);
  return out;
}

/**
 * Replace the block of record `cid` with a different, correctly hashed record
 * block. The signed MST still commits to `cid`, whose block is now absent.
 */
export function corruptRecordCidSwap(car: Uint8Array, cid: string, replacement: unknown) {
  const parsed = parseCar(car);
  sectionOf(parsed, cid);
  const bytes = encode(replacement);
  const swapped = cborCid(bytes);
  if (swapped === cid) throw new Error('replacement record encodes to the same CID');
  return rebuild(parsed, new Map([[cid, [swapped, bytes]]]));
}

/** Remove block `cid` (e.g. the deepest MST path node of a proof). */
export function dropBlock(car: Uint8Array, cid: string): Uint8Array<ArrayBuffer> {
  const parsed = parseCar(car);
  sectionOf(parsed, cid);
  return encodeCar(
    parsed.roots,
    parsed.sections.filter((s) => s.cid !== cid).map((s): [string, Uint8Array] => [s.cid, s.bytes]),
  );
}
