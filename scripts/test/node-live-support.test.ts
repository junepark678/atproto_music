import { expect, test, vi } from 'vitest';
import { observeNodeGateResults } from '../live/node-live-support.ts';

function ingest() {
  const cid = `b${'a'.repeat(58)}`;
  const publish = (did: string) => ({
    uri: `at://${did}/org.atproto.music.scrobble/3aaaaaaaaaaa2`,
    cid,
    statusCid: cid,
    indexedCid: cid,
    verifiedCid: cid,
    verifiedRev: '3aaaaaaaaaaa4',
    lagMs: 0,
  });
  const localPublish = publish('did:plc:abcdefghijklmnopqrstuvwx');
  const externalPublish = publish('did:plc:bcdefghijklmnopqrstuvwxy');
  return {
    localPublish,
    externalPublish,
    deleteReconcile: [localPublish, externalPublish].map((row) => ({
      uri: row.uri,
      absentVerified: true,
      method: 'exclusionProof',
      presentRev: row.verifiedRev,
      verifiedRev: '3aaaaaaaaaaa5',
      lagMs: 0,
    })),
  };
}

function pds() {
  return ['one', 'two'].map((name) => ({
    endpoint: `https://pds-${name}.example.org`,
    did: `did:web:${name}.example.org`,
    getRecordInclusion: true,
    getRecordExclusion: false,
    getBlocks: false,
    getRepoStatus: true,
    snapshotAbsence: true,
  }));
}

test('built-in ingest observations require matching publication and newer absence evidence', () => {
  expect(observeNodeGateResults('ingest', undefined, ingest())).toEqual([]);
  for (const mutation of [
    (rows: ReturnType<typeof ingest>) => {
      rows.localPublish.indexedCid = `b${'b'.repeat(58)}`;
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.externalPublish.verifiedCid = '';
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.localPublish.lagMs = Number.NaN;
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.deleteReconcile[0]!.absentVerified = false;
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.deleteReconcile[0]!.method = 'unverified';
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.deleteReconcile[0]!.uri = rows.externalPublish.uri;
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.deleteReconcile[0]!.verifiedRev = rows.localPublish.verifiedRev;
    },
    (rows: ReturnType<typeof ingest>) => {
      rows.deleteReconcile[0]!.presentRev = '3aaaaaaaaaaa2';
      rows.deleteReconcile[0]!.verifiedRev = '3aaaaaaaaaaa3';
    },
  ]) {
    const results = ingest();
    mutation(results);
    expect(observeNodeGateResults('ingest', [], results)).not.toEqual([]);
  }
});

test('declared delete validators always run alongside built-in cross-result checks', () => {
  const reject = vi.fn(() => 'additional delete check rejected');
  expect(observeNodeGateResults('ingest', [{ key: 'deleteReconcile', accept: reject }], ingest())).toEqual([
    'observation deleteReconcile: additional delete check rejected',
  ]);
  expect(reject).toHaveBeenCalledOnce();
  const throws = vi.fn(() => {
    throw new Error('additional delete check threw');
  });
  expect(observeNodeGateResults('ingest', [{ key: 'deleteReconcile', accept: throws }], ingest())).toEqual([
    'observation deleteReconcile: validator threw: additional delete check threw',
  ]);
  expect(throws).toHaveBeenCalledOnce();
  const accept = vi.fn(() => null);
  const stale = ingest();
  stale.deleteReconcile[0]!.presentRev = '3aaaaaaaaaaa2';
  stale.deleteReconcile[0]!.verifiedRev = '3aaaaaaaaaaa3';
  expect(observeNodeGateResults('ingest', [{ key: 'deleteReconcile', accept }], stale)).toContainEqual(
    expect.stringContaining('presentRev does not match published verifiedRev'),
  );
  expect(accept).toHaveBeenCalledOnce();
});

test('only null accepts an observation; empty rejection messages fail closed', () => {
  expect(observeNodeGateResults('oauth', [{ key: 'proof', accept: () => null }], { proof: true })).toEqual([]);
  for (const problem of ['', '   ', undefined, false, 0]) {
    // Guard the runtime boundary too: a malformed JS callback is not acceptance.
    const accept = () => problem as unknown as string;
    expect(observeNodeGateResults('oauth', [{ key: 'proof', accept }], { proof: true })).toEqual([
      'observation proof: validator did not accept',
    ]);
  }
  expect(
    observeNodeGateResults('oauth', [{ key: 'proof', accept: () => null }], Object.create({ proof: true })),
  ).toEqual(['observation proof: missing']);
});

test('PDS observations require both hosts and mandatory capabilities with a verified absence fallback', () => {
  expect(observeNodeGateResults('pdsCompat', undefined, { perPds: pds() })).toEqual([]);
  for (const mutation of [
    (rows: ReturnType<typeof pds>) => {
      rows.pop();
    },
    (rows: ReturnType<typeof pds>) => {
      rows[1]!.endpoint = rows[0]!.endpoint;
    },
    (rows: ReturnType<typeof pds>) => {
      rows[0]!.getRecordInclusion = false;
    },
    (rows: ReturnType<typeof pds>) => {
      rows[0]!.getRepoStatus = false;
    },
    (rows: ReturnType<typeof pds>) => {
      rows[0]!.snapshotAbsence = false;
    },
  ]) {
    const perPds = pds();
    mutation(perPds);
    expect(observeNodeGateResults('pdsCompat', [], { perPds })).not.toEqual([]);
  }
});
