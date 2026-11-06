// The shared read-model fixture as real signed repositories on a fake network
// (ADR 0004 §10.3). TEST-ONLY.
//
// `createFixtureKit()` wires Alice, Bob and Carol, each on a separate fake PDS
// host, into one fixture network: fake PLC documents, DoH TXT and well-known
// handle records, a relay and a Jetstream that receives every commit.
//
// `seedReadModels(kit)` publishes tests/fixtures/read_models.json exactly:
// - local records (Alice's and Bob's) through their PDS's createRecord, as the
//   SPA outbox would;
// - Carol's r10 only as an external writer: committed straight into her repo,
//   never through an app write endpoint;
// - r08 created, then deleted (with swapRecord) after the Alice→Bob follow;
// - the follow at its deterministic rkey `'f' + sha256hex(subject)`.
// CIDs and revisions come from the signer; nothing here invents one.

import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import { FakeDoh } from './fake-doh';
import { type FakeJetstream, type FakeJetstreamOptions, fakeJetstream, type JetstreamEvent } from './fake-jetstream';
import { FakePds } from './fake-pds';
import { FakePlc } from './fake-plc';
import { FakeRelay } from './fake-relay';
import { type FixtureKeys, fixtureKeys, type TestKey } from './keys';
import { type FixtureTransport, routerTransport } from './router-transport';
import { type CommitResult, SignedRepo } from './signed-repo';

/** The fixture lexicon prefix. Never published (ADR 0004 §15). */
export const FIXTURE_PREFIX = 'com.example.atmusic';

export const FIXTURE_COLLECTIONS = {
  scrobble: `${FIXTURE_PREFIX}.scrobble`,
  follow: `${FIXTURE_PREFIX}.follow`,
  settings: `${FIXTURE_PREFIX}.settings`,
} as const;

export type FixtureUser = 'Alice' | 'Bob' | 'Carol';
export const FIXTURE_USERS: readonly FixtureUser[] = ['Alice', 'Bob', 'Carol'];

/** One fake PDS host per account. */
export const FIXTURE_PDS_HOSTS: Readonly<Record<FixtureUser, string>> = {
  Alice: 'pds-alice.example.test',
  Bob: 'pds-bob.example.test',
  Carol: 'pds-carol.example.test',
};

/** The fixture has no follow timestamp; this is the one the Rust oracle exporter uses. */
export const FOLLOW_CREATED_AT = '2025-01-01T00:00:00Z';

export interface KitUser {
  name: FixtureUser;
  did: string;
  handle: string;
  key: TestKey;
  host: string;
  origin: string;
  token: string;
}

export interface FixtureKit {
  clock: FixedClock;
  prefix: string;
  collections: typeof FIXTURE_COLLECTIONS;
  keys: FixtureKeys;
  users: Record<FixtureUser, KitUser>;
  repos: Record<FixtureUser, SignedRepo>;
  pds: Record<FixtureUser, FakePds>;
  plc: FakePlc;
  doh: FakeDoh;
  relay: FakeRelay;
  jetstream: FakeJetstream;
  /** handle → DID for `https://<handle>/.well-known/atproto-did`; mutable. */
  handles: Map<string, string>;
  transport: FixtureTransport;
  user(did: string): KitUser;
  /** createRecord through the account's PDS over the transport (an app write). */
  createRecord(name: FixtureUser, collection: string, rkey: string, record: unknown): Promise<WriteResponse>;
  /** deleteRecord through the account's PDS over the transport, with optional swapRecord. */
  deleteRecord(name: FixtureUser, collection: string, rkey: string, swapRecord?: string): Promise<WriteResponse>;
  /** A commit made by some other app, straight into the repo; it reaches Jetstream like any commit. */
  externalPut(name: FixtureUser, collection: string, rkey: string, record: unknown): Promise<CommitResult>;
  externalDelete(name: FixtureUser, collection: string, rkey: string): Promise<CommitResult>;
  /** Rotate the account key in the PLC document and on the PDS (re-signing the head unless `resign: false`). */
  rotateKey(name: FixtureUser, key: TestKey, o?: { resign?: boolean }): Promise<CommitResult | null>;
  /** Clear every fake's call log and the transport's. */
  resetCalls(): void;
}

export interface WriteResponse {
  uri?: string;
  cid?: string;
  commit?: { cid: string; rev: string };
}

export interface KitOptions {
  clock?: FixedClock;
  jetstream?: Omit<FakeJetstreamOptions, 'clock'>;
}

export async function createFixtureKit(o: KitOptions = {}): Promise<FixtureKit> {
  const clock = o.clock ?? fixedClock();
  const keys = await fixtureKeys();
  const keyOf: Record<FixtureUser, TestKey> = { Alice: keys.alice, Bob: keys.bob, Carol: keys.carol };
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const relay = new FakeRelay();
  const jetstream = fakeJetstream({ ...o.jetstream, clock });
  const handles = new Map<string, string>();

  const users = {} as Record<FixtureUser, KitUser>;
  const repos = {} as Record<FixtureUser, SignedRepo>;
  const pds = {} as Record<FixtureUser, FakePds>;
  for (const name of FIXTURE_USERS) {
    const { did, handle } = fixture.users[name];
    const host = FIXTURE_PDS_HOSTS[name];
    const repo = new SignedRepo(did, keyOf[name], { clock });
    const server = new FakePds(host, { clock });
    const account = await server.addAccount(repo, { handle });
    server.onCommit((_did, commit) => {
      jetstream.appendCommit(commit);
    });
    plc.register(did, { signingKey: keyOf[name], pds: server.origin, handle });
    doh.setTxt(`_atproto.${handle}`, [`did=${did}`]);
    handles.set(handle, did);
    users[name] = { name, did, handle, key: keyOf[name], host, origin: server.origin, token: account.token };
    repos[name] = repo;
    pds[name] = server;
  }
  const transport = routerTransport({
    pds: FIXTURE_USERS.map((n) => pds[n]),
    plc,
    doh,
    relay,
    jetstream,
    handles,
  });

  const xrpcWrite = async (name: FixtureUser, nsid: string, body: Record<string, unknown>) => {
    const u = users[name];
    const res = await transport(
      new Request(`${u.origin}/xrpc/${nsid}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: u.did, ...body }),
      }),
    );
    const json = (await res.json()) as WriteResponse & { error?: string; message?: string };
    if (res.status !== 200) throw new Error(`${nsid} for ${name} failed: ${res.status} ${json.error}: ${json.message}`);
    return json;
  };

  return {
    clock,
    prefix: FIXTURE_PREFIX,
    collections: FIXTURE_COLLECTIONS,
    keys,
    users,
    repos,
    pds,
    plc,
    doh,
    relay,
    jetstream,
    handles,
    transport,
    user(did) {
      const u = FIXTURE_USERS.map((n) => users[n]).find((x) => x.did === did);
      if (!u) throw new Error(`no fixture user ${did}`);
      return u;
    },
    createRecord: (name, collection, rkey, record) =>
      xrpcWrite(name, 'com.atproto.repo.createRecord', { collection, rkey, record }),
    deleteRecord: (name, collection, rkey, swapRecord) =>
      xrpcWrite(name, 'com.atproto.repo.deleteRecord', {
        collection,
        rkey,
        ...(swapRecord === undefined ? {} : { swapRecord }),
      }),
    async externalPut(name, collection, rkey, record) {
      const commit = await repos[name].put(collection, rkey, record);
      jetstream.appendCommit(commit);
      return commit;
    },
    async externalDelete(name, collection, rkey) {
      const commit = await repos[name].delete(collection, rkey);
      jetstream.appendCommit(commit);
      return commit;
    },
    async rotateKey(name, key, ro = {}) {
      plc.rotateKey(users[name].did, key);
      users[name] = { ...users[name], key };
      return pds[name].rotateKey(users[name].did, key, ro);
    },
    resetCalls() {
      transport.calls.reset();
      plc.calls.reset();
      doh.calls.reset();
      relay.calls.reset();
      jetstream.calls.reset();
      for (const n of FIXTURE_USERS) pds[n].calls.reset();
    },
  };
}

/** Deterministic follow rkey: `'f' + lowercase hex SHA-256` of the exact subject DID bytes. */
export async function followRkey(subject: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject)));
  return `f${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface SeededRecord {
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  /** The record's CID (for a deleted record: the CID it had while it existed). */
  cid: string;
  /** Rev of the commit that wrote it (for a deleted record: the deleting commit). */
  rev: string;
  state: 'present' | 'deleted';
  source: 'local' | 'external';
  record: unknown;
}

export interface SeedResult {
  /** URI → `{cid, rev, state, …}` for every scrobble and follow the fixture lists. */
  records: Map<string, SeededRecord>;
  /** Every Jetstream event the seeding produced, in seq order. */
  events: JetstreamEvent[];
  /** Repository heads after seeding. */
  heads: Record<FixtureUser, { cid: string; rev: string }>;
}

type FixtureScrobble = (typeof fixture.scrobbles)[number];

/**
 * Publish tests/fixtures/read_models.json into `kit`. Call logs are reset
 * afterwards (unless `keepCalls`), so tests count only their own remote calls.
 */
export async function seedReadModels(kit: FixtureKit, o: { keepCalls?: boolean } = {}): Promise<SeedResult> {
  const firstSeq = kit.jetstream.events.length;
  const records = new Map<string, SeededRecord>();
  const deletions: FixtureScrobble[] = [];

  for (const s of fixture.scrobbles) {
    const owner = kit.user(s.owner).name;
    const collection = s.record.$type;
    if (collection !== kit.collections.scrobble) throw new Error(`unexpected $type ${collection}`);
    if (s.uri !== `at://${s.owner}/${collection}/${s.rkey}`) throw new Error(`fixture URI mismatch for ${s.rkey}`);
    let cid: string;
    let rev: string;
    if (s.source === 'local') {
      const res = await kit.createRecord(owner, collection, s.rkey, s.record);
      cid = res.cid!;
      rev = res.commit!.rev;
    } else if (s.source === 'external') {
      const commit = await kit.externalPut(owner, collection, s.rkey, s.record);
      cid = commit.ops[0]!.cid!;
      rev = commit.rev;
    } else {
      throw new Error(`unknown fixture source ${s.source}`);
    }
    if (s.state === 'deleted') deletions.push(s);
    else if (s.state !== 'confirmed') throw new Error(`unknown fixture state ${s.state}`);
    kit.relay.add(collection, s.owner);
    records.set(s.uri, {
      uri: s.uri,
      did: s.owner,
      collection,
      rkey: s.rkey,
      cid,
      rev,
      state: 'present',
      source: s.source,
      record: s.record,
    });
  }

  for (const f of fixture.follows) {
    if (f.state !== 'confirmed') throw new Error(`unknown follow state ${f.state}`);
    const actor = kit.user(f.actor).name;
    const collection = kit.collections.follow;
    const rkey = await followRkey(f.subject);
    const record = { $type: collection, subject: f.subject, createdAt: FOLLOW_CREATED_AT };
    const res = await kit.createRecord(actor, collection, rkey, record);
    kit.relay.add(collection, f.actor);
    const uri = `at://${f.actor}/${collection}/${rkey}`;
    records.set(uri, {
      uri,
      did: f.actor,
      collection,
      rkey,
      cid: res.cid!,
      rev: res.commit!.rev,
      state: 'present',
      source: 'local',
      record,
    });
  }

  for (const s of deletions) {
    const seeded = records.get(s.uri)!;
    const owner = kit.user(s.owner).name;
    const res = await kit.deleteRecord(owner, seeded.collection, s.rkey, seeded.cid);
    records.set(s.uri, { ...seeded, rev: res.commit!.rev, state: 'deleted' });
  }

  const heads = {} as SeedResult['heads'];
  for (const n of FIXTURE_USERS) {
    const h = kit.repos[n].head!;
    heads[n] = { cid: h.cid, rev: h.rev };
  }
  const events = kit.jetstream.events.slice(firstSeq);
  if (!o.keepCalls) kit.resetCalls();
  return { records, events, heads };
}
