import type { Clock } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Box } from '../../../src/crypto/box';
import type { ModuleDeps } from '../../../src/do/contracts';
import type { Db } from '../../../src/do/db';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { enqueueListenDelete, hasCanonicalListenSurvivor } from '../../../src/forward/delete-enqueue';
import type { DeleteForwardDeps } from '../../../src/forward/delete-forwarder';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import type { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { projectionListenKey } from '../../../src/forward/projection';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { hasListenRemovalTombstones, isListenTombstoned, tombstoneListen } from '../../../src/sync/tombstones';
import {
  ALICE,
  authorizedLiveOptions,
  deleteProof,
  NOW_MS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  scrobble,
  seedSnapshotJob,
  seedUser,
} from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = (db: Db, proof: Awaited<ReturnType<typeof putProof>>) =>
  authorizedLiveOptions(db, proof, rng);
function seedLink(db: Db) {
  seedUser(db, ALICE);
  const accountDeps: Pick<CredentialDeps, 'db' | 'clock'> = { db, clock: { nowMs: () => NOW_MS } };
  ensureAccount(accountDeps, { did: ALICE, verifiedHandle: null });
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
    VALUES ('replacement-link',?,'listenbrainz','alice',X'00','fixture',?,?)`,
    ALICE,
    NOW_MS,
    NOW_MS,
  );
}
function delivered(db: Db) {
  enqueueForwards(db, {
    did: ALICE,
    items: [{ kind: 'scrobble', listenKey: identity, payload: { listen: record } }],
    now: NOW_MS,
    random: seededRandom(
      620 +
        db.one<{ generation: number }>("SELECT generation FROM linked_accounts WHERE id='replacement-link'")!
          .generation,
    ),
  });
  db.run("UPDATE forward_outbox SET state='sent'");
}
const deletion = {
  did: ALICE,
  identityKey: identity,
  eventKey: 'same-event',
  listenedAt: second,
  artistKey,
  trackKey: musicTrackKey,
  artist: 'Björk',
  track: 'Jóga',
  sourcePath: 'live',
  now: NOW_MS,
};

const BATCH = `${SCROBBLE}Batch`;
const uri = (key: string, batch = false) => `at://${ALICE}/${batch ? BATCH : SCROBBLE}/${key}`;
const batchRecord = (ids = ['2222222222222'], track = record.track) => {
  const { $type, ...entry } = record;
  return { $type: BATCH, createdAt: record.createdAt, listens: ids.map((id) => ({ ...entry, id, track })) };
};
const opRandom = seededRandom(123);
const moduleOf = (db: Db) =>
  ({
    db,
    config: { prefix: 'com.example.atmusic' },
    clock: { nowMs: () => NOW_MS },
    random: opRandom,
  }) as unknown as ModuleDeps;
const apiSingle = (db: Db, key: string) =>
  enqueueScrobbleDelete(moduleOf(db), { did: ALICE, uri: uri(key), origin: 'web' });
const apiBatch = (db: Db, key: string, ids: string[]) =>
  enqueueBatchListenDelete(moduleOf(db), { did: ALICE, uri: uri(key, true), listenIds: ids, origin: 'web' });
async function drain(db: Db) {
  let now = NOW_MS,
    deletes = 0,
    lookups = 0;
  const clock = { nowMs: () => now };
  const deps: DeleteForwardDeps = {
    db,
    clock,
    random: seededRandom(9),
    box: { openText: () => 'fixture' } as unknown as Box,
    pacing: new UpstreamPacing(clock as Clock),
    client: {
      listWindowPage: async () => {
        lookups++;
        return {
          ok: true,
          rate: { remaining: 100, resetInS: 0 },
          value: [{ listenedAt: second, artist: 'Björk', track: 'Jóga', recordingMsid: 'fixture-msid' }],
        };
      },
      deleteListen: async () => {
        deletes++;
        return { ok: true, accepted: true, rate: { remaining: 100, resetInS: 0 } };
      },
    } as unknown as ListenbrainzClient,
  };
  for (let i = 0; i < 12; i++) {
    await runDeleteSlice(deps);
    now += 1000;
  }
  return { deletes, lookups };
}

import { authorizePendingRemovals, executeAuthorizedRemovals, recordPendingRemoval } from '../../../src/do/ingest/live-pending-removals';
import { LIVE_EVIDENCE_TTL_MS, readLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { enqueueHints } from '../../../src/do/ingest/hints';
const rng = seededRandom(888);
const sweep = (db: Db, nowMs=NOW_MS) => db.tx(()=>executeAuthorizedRemovals(db,{nowMs,random:rng,limit:10}));
it.each([false,true])('independent: delayed old event protects same-CID recreation=%s', async recreated => {
 const repo=await repoFor('alice');
 const first=await putProof(repo,SCROBBLE,'a',record);
 const gone=await deleteProof(repo,SCROBBLE,'a');
 const again=await putProof(repo,SCROBBLE,'a',record);
 await withMigratedDb(async db=>{
  seedLink(db);
  db.tx(()=>applyRecordProof(db,first,live(db,first))); delivered(db);
  db.tx(()=>applyRecordProof(db,gone,OPTS));
  expect(db.one('SELECT count(*) n FROM scrobbles')).toEqual({n:0});
  expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({n:1});
  expect((await drain(db)).deletes).toBe(0);
  if(recreated) db.tx(()=>applyRecordProof(db,again,live(db,again)));
  enqueueHints(db,[{did:ALICE,collection:SCROBBLE,rkey:'a',source:'jetstream',hintRev:gone.commit.rev,live:{operation:'delete'},receiptMs:NOW_MS}]);
  sweep(db);
  const result=await drain(db);
  console.log('recreation',recreated,'wire',result,'tombstones',db.all('SELECT identity_key FROM linked_pull_tombstones'));
  expect(result.deletes).toBe(recreated?0:1);
 });
});
it('independent: exact stale replay cannot extend pending TTL',async()=>{
 const repo=await repoFor('alice'); const first=await putProof(repo,SCROBBLE,'a',record);const gone=await deleteProof(repo,SCROBBLE,'a');
 await withMigratedDb(db=>{seedLink(db);db.tx(()=>applyRecordProof(db,first,live(db,first)));delivered(db);
 const row=db.one<any>('SELECT * FROM scrobbles WHERE uri=?',uri('a'))!;
 db.tx(()=>applyRecordProof(db,gone,OPTS));
 const original=db.one<any>('SELECT expires_at_ms FROM live_pending_removals')!.expires_at_ms;
 recordPendingRemoval(db,{did:ALICE,uri:uri('a'),kind:'scrobble',row,identityKey:identity,windowLo:first.commit.rev,windowHi:gone.commit.rev,replacedByCid:null,nowMs:NOW_MS+LIVE_EVIDENCE_TTL_MS-1});
 expect(db.one<any>('SELECT expires_at_ms FROM live_pending_removals')!.expires_at_ms).toBe(original);
 });
});
it('independent: conflict remains disqualifying after newer evidence arrives',async()=>{
 const repo=await repoFor('alice');const first=await putProof(repo,SCROBBLE,'a',record);const gone=await deleteProof(repo,SCROBBLE,'a');const next=await putProof(repo,SCROBBLE,'a',record);
 await withMigratedDb(async db=>{seedLink(db);db.tx(()=>applyRecordProof(db,first,live(db,first)));delivered(db);db.tx(()=>applyRecordProof(db,gone,OPTS));
 for(const [rev,operation,cid] of [[gone.commit.rev,'delete',undefined],[gone.commit.rev,'create',first.state==='present'?first.cid:''],[next.commit.rev,'create',next.state==='present'?next.cid:'']] as const)
 enqueueHints(db,[{did:ALICE,collection:SCROBBLE,rkey:'a',source:'jetstream',hintRev:rev,live:{operation,cid},receiptMs:NOW_MS}]);
 console.log('conflict after newer event',readLiveEvidence(db,uri('a'),NOW_MS));sweep(db);
 expect((await drain(db)).deletes).toBe(0);
 });
});
it('independent: delayed love removal protects a newer external recreation',async()=>{
 const LOVE='com.example.atmusic.love';const key='2222222222222'; const u=`at://${ALICE}/${LOVE}/${key}`;
 const repo=await repoFor('alice');const loved={$type:LOVE,artist:'Björk',track:'Jóga',createdAt:'2026-01-15T11:00:00Z'};
 const first=await putProof(repo,LOVE,key,loved);const gone=await deleteProof(repo,LOVE,key);const again=await putProof(repo,LOVE,key,loved);
 await withMigratedDb(db=>{seedLink(db);db.tx(()=>applyRecordProof(db,first,live(db,first)));db.run("UPDATE forward_outbox SET state='sent'");
 expect(db.one('SELECT count(*) n FROM loves')).toEqual({n:1});
 db.tx(()=>applyRecordProof(db,gone,OPTS));expect(db.one('SELECT count(*) n FROM live_pending_removals')).toEqual({n:1});
 db.tx(()=>applyRecordProof(db,again,live(db,again)));expect(db.one('SELECT count(*) n FROM loves')).toEqual({n:1});
 enqueueHints(db,[{did:ALICE,collection:LOVE,rkey:key,source:'jetstream',hintRev:gone.commit.rev,live:{operation:'delete'},receiptMs:NOW_MS}]);sweep(db);
 console.log('love recreation',db.all('SELECT kind,state FROM forward_outbox'),db.all('SELECT * FROM love_incarnations'));
 expect(db.one("SELECT count(*) n FROM forward_outbox WHERE kind='unlove'")).toEqual({n:0});
 });
});
it('independent: group failure rolls back effects and keeps authorization under caller transaction',async()=>{
 const repo=await repoFor('alice');const first=await putProof(repo,SCROBBLE,'a',record);const gone=await deleteProof(repo,SCROBBLE,'a');
 await withMigratedDb((db,ctx)=>{seedLink(db);db.tx(()=>applyRecordProof(db,first,live(db,first)));delivered(db);db.tx(()=>applyRecordProof(db,gone,OPTS));
 enqueueHints(db,[{did:ALICE,collection:SCROBBLE,rkey:'a',source:'jetstream',hintRev:gone.commit.rev,live:{operation:'delete'},receiptMs:NOW_MS}]);
 const failing: Db = {all:db.all.bind(db),one:db.one.bind(db),tx:db.tx.bind(db),run(sql,...args){if(sql.startsWith('DELETE FROM live_pending_removals INDEXED BY'))throw new Error('injected');return db.run(sql,...args);}};
 expect(()=>db.tx(()=>executeAuthorizedRemovals(failing,{nowMs:NOW_MS,random:rng,limit:10}))).toThrow('injected');expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({n:0});expect(db.one('SELECT count(*) n FROM linked_pull_tombstones')).toEqual({n:0});expect(db.one('SELECT authorized_rev FROM live_pending_removals')).toEqual({authorized_rev:gone.commit.rev});
 });
});
it('independent: intersecting windows are all considered for matching authorization',async()=>{
 const repo=await repoFor('alice');const first=await putProof(repo,SCROBBLE,'a',record);const gone=await deleteProof(repo,SCROBBLE,'a');const newer=await putProof(repo,SCROBBLE,'b',record);
 await withMigratedDb(db=>{seedLink(db);db.tx(()=>applyRecordProof(db,first,live(db,first)));const row=db.one<any>('SELECT * FROM scrobbles')!;
 const common={did:ALICE,uri:uri('a'),kind:'scrobble' as const,row,identityKey:identity,windowLo:first.commit.rev,nowMs:NOW_MS};
 recordPendingRemoval(db,{...common,windowHi:gone.commit.rev,replacedByCid:'wrong'});
 recordPendingRemoval(db,{...common,windowHi:newer.commit.rev,replacedByCid:'matching'});
 authorizePendingRemovals(db,{uri:uri('a'),rev:gone.commit.rev,action:'update',cid:'matching'},NOW_MS);
 expect(db.one("SELECT authorized_rev FROM live_pending_removals WHERE replaced_by_cid='matching'")).toEqual({authorized_rev:gone.commit.rev});
 });
});
