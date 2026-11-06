// Live gate: per-PDS compatibility (ADR 0004 §10.4, §13 item 8; W6-05).
//
// Usage: npx tsx scripts/live/pds_compat_check.ts
//
// For each of the two dedicated identities (PDS A and PDS B) it records:
// - the PDS implementation (ATMUSIC_LIVE_PDS_{A,B}_IMPLEMENTATION, operator
//   declared, required) and version (`/xrpc/_health`; unreadable fails);
// - that the DID document names the declared PDS (fresh resolution);
// - getRecord inclusion proof: an existing record, found through describeRepo
//   and listRecords, is fetched with com.atproto.sync.getRecord and verified
//   by the production verifier (CAR bounds, commit signature under the
//   current #atproto key, MST inclusion, record CID equal to the listed CID);
// - getRecord exclusion proof: a never-written rkey in `<prefix>.scrobble`
//   must come back as a signed CAR that proves absence (a 404 means the PDS
//   offers no exclusion proofs; deletes then reconcile through a snapshot);
// - when there is no exclusion proof, the snapshot fallback itself: the
//   production snapshot verifier (getRepo, signed root commit, complete range
//   walk of `<prefix>.scrobble`) must prove that never-written rkey absent;
// - getBlocks: the current commit block (getLatestCommit) is requested and
//   must come back hash-verified (unsupported means the getRepo fallback);
// - getRepoStatus: 200 with this DID and an `active` flag.
//
// Inclusion proofs and getRepoStatus are mandatory for the AppView; exclusion
// proofs and getBlocks have fallbacks (snapshot, then getRepo) and are
// recorded, not required, but a PDS without exclusion proofs must pass the
// snapshot absence check. The gate passes when both PDSs were measured and
// the mandatory capabilities hold on each. Nothing is written to any repo.
//
// Without the prerequisites (owned NSID, deployed origin and version, two
// identities on independent PDSs, Jetstream coverage) it prints a `blocked`
// result naming each missing variable and exits 2 without a network request.

import { parseRecordUri } from '@atmusic/core/syntax';
import {
  checkDeployment,
  checkIdentityPds,
  ENV,
  expect,
  field,
  type GateContext,
  type GateSpec,
  httpJson,
  IDENTITY_REQS,
  isMain,
  JETSTREAM_REQ,
  main,
  PDS_IMPLEMENTATION_REQS,
  type PdsInfo,
  pdsInfo,
  RELEASE_REQS,
  type Subject,
  verifyAbsentBySnapshot,
  verifyRecordAt,
  xrpcUrl,
} from './live-gate.ts';

/** A syntactically valid TID that no clock produces (1970 timestamp): never written. */
export const ABSENT_RKEY = '2222222222222';

export interface PdsCompat {
  endpoint: string;
  did: string;
  getRecordInclusion: boolean;
  getRecordExclusion: boolean;
  getBlocks: boolean;
  getRepoStatus: boolean;
  /** Snapshot absence verified (checked only without an exclusion proof; null when not needed). */
  snapshotAbsence: boolean | null;
  notes: string[];
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

async function findRecord(pds: string, did: string, prefix: string): Promise<{ uri: string; cid: string } | null> {
  const described = await httpJson(xrpcUrl(pds, 'com.atproto.repo.describeRepo', { repo: did }));
  const collections = field<unknown[]>(described.json, 'collections');
  if (described.status !== 200 || !Array.isArray(collections)) return null;
  const names = collections.filter((c): c is string => typeof c === 'string');
  const preferred = [`${prefix}.settings`, `${prefix}.scrobble`, `${prefix}.follow`].filter((c) => names.includes(c));
  for (const collection of [...preferred, ...names.filter((c) => !preferred.includes(c))].slice(0, 8)) {
    const listed = await httpJson(xrpcUrl(pds, 'com.atproto.repo.listRecords', { repo: did, collection, limit: '1' }));
    const first = field<unknown[]>(listed.json, 'records')?.[0];
    const uri = field<string>(first, 'uri');
    const cid = field<string>(first, 'cid');
    if (listed.status === 200 && typeof uri === 'string' && typeof cid === 'string') return { uri, cid };
  }
  return null;
}

export async function checkPds(
  ctx: GateContext,
  did: string,
  endpoint: string,
): Promise<{ compat: PdsCompat; subject: Subject }> {
  const notes: string[] = [];
  const compat: PdsCompat = {
    endpoint,
    did,
    getRecordInclusion: false,
    getRecordExclusion: false,
    getBlocks: false,
    getRepoStatus: false,
    snapshotAbsence: null,
    notes,
  };
  await checkIdentityPds(did, endpoint);

  const status = await httpJson(xrpcUrl(endpoint, 'com.atproto.sync.getRepoStatus', { did }));
  compat.getRepoStatus =
    status.status === 200 && field(status.json, 'did') === did && typeof field(status.json, 'active') === 'boolean';
  if (!compat.getRepoStatus) notes.push(`getRepoStatus: HTTP ${status.status}`);
  else if (field(status.json, 'active') !== true) notes.push(`getRepoStatus: account not active`);

  let subject: Subject = { did, uri: null };
  const record = await findRecord(endpoint, did, ctx.prefix);
  if (record === null) {
    notes.push('getRecord inclusion: the repository lists no record to prove; create one first');
  } else {
    subject = { did, uri: record.uri };
    const parsed = parseRecordUri(record.uri);
    try {
      expect(parsed !== null && parsed.did === did, `listRecords returned a foreign or malformed URI ${record.uri}`);
      const proof = await verifyRecordAt(did, parsed.collection, parsed.rkey);
      compat.getRecordInclusion = proof.state === 'present' && proof.cid === record.cid;
      if (!compat.getRecordInclusion) notes.push(`getRecord inclusion: proof ${proof.state}, cid ${proof.cid}`);
      else notes.push(`getRecord inclusion: ${record.uri} cid ${proof.cid} at rev ${proof.rev}`);
    } catch (error) {
      notes.push(`getRecord inclusion: ${describe(error)}`);
    }
  }

  try {
    const proof = await verifyRecordAt(did, `${ctx.prefix}.scrobble`, ABSENT_RKEY);
    compat.getRecordExclusion = proof.state === 'absent';
    notes.push(`getRecord exclusion: proof ${proof.state} at rev ${proof.rev}`);
  } catch (error) {
    notes.push(`getRecord exclusion: ${describe(error)}`);
  }

  if (!compat.getRecordExclusion) {
    try {
      const snapshot = await verifyAbsentBySnapshot(did, `${ctx.prefix}.scrobble`, ABSENT_RKEY);
      compat.snapshotAbsence = snapshot.state === 'absent';
      notes.push(
        `snapshot absence: ${snapshot.state} at rev ${snapshot.rev} (${snapshot.keysEnumerated} keys enumerated)`,
      );
    } catch (error) {
      compat.snapshotAbsence = false;
      notes.push(`snapshot absence: ${describe(error)}`);
    }
  }

  try {
    const latest = await httpJson(xrpcUrl(endpoint, 'com.atproto.sync.getLatestCommit', { did }));
    const cid = field<string>(latest.json, 'cid');
    expect(latest.status === 200 && typeof cid === 'string', `getLatestCommit: HTTP ${latest.status}`);
    const [{ systemClock }, { createSafeFetch }, { getBlocksSource }] = await Promise.all([
      import('@atmusic/core/deps'),
      import('@atmusic/atproto/net/safe-fetch'),
      import('@atmusic/atproto/snapshot/getblocks-source'),
    ]);
    const source = getBlocksSource({ safeFetch: createSafeFetch({ clock: systemClock }), pds: endpoint, did });
    const blocks = await source.get([cid]);
    compat.getBlocks = blocks.has(cid);
    notes.push(compat.getBlocks ? `getBlocks: commit block ${cid} verified` : 'getBlocks: commit block missing');
  } catch (error) {
    notes.push(`getBlocks: ${describe(error)}`);
  }
  return { compat, subject };
}

export const spec: GateSpec = {
  gate: 'pdsCompat',
  script: 'scripts/live/pds_compat_check.ts',
  requirements: [...RELEASE_REQS, ...IDENTITY_REQS, ...PDS_IMPLEMENTATION_REQS, JETSTREAM_REQ],
  async run(ctx) {
    const deployment = await checkDeployment(ctx);
    const pds: PdsInfo[] = [];
    const subjects: Subject[] = [];
    const perPds: PdsCompat[] = [];
    for (const [didName, pdsName, implName] of [
      [ENV.didA, ENV.pdsA, ENV.pdsAImplementation],
      [ENV.didB, ENV.pdsB, ENV.pdsBImplementation],
    ] as const) {
      const did = ctx.get(didName);
      const info = await pdsInfo(ctx.get(pdsName), ctx.get(implName));
      pds.push(info);
      try {
        const { compat, subject } = await checkPds(ctx, did, info.endpoint);
        perPds.push(compat);
        subjects.push(subject);
        if (!compat.getRecordInclusion) ctx.fail(`${info.endpoint}: no verified getRecord inclusion proof`);
        if (!compat.getRepoStatus) ctx.fail(`${info.endpoint}: getRepoStatus unsupported`);
        if (!compat.getRecordExclusion && compat.snapshotAbsence !== true) {
          ctx.fail(`${info.endpoint}: no exclusion proof and no verified snapshot absence: deletes cannot reconcile`);
        }
      } catch (error) {
        subjects.push({ did, uri: null });
        ctx.fail(`${info.endpoint}: ${describe(error)}`);
      }
    }
    ctx.cleanup('read-only gate: no record was written');
    return { pds, subjects, results: { deployment, perPds } };
  },
};

if (isMain(import.meta.url)) main(spec);
