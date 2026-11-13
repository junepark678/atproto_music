import { expect, it } from 'vitest';
import { LOVE_API_RECLAIM_PAGE, reclaimLoveApiProofRows } from '../../../src/forward/love-api-maintenance';
import { withMigratedDb } from '../../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const URI = `at://${DID}/com.example.atmusic.love/3mchjvhag2266`;
const INCARNATION = `love:${URI}:api:api-op`;

it('keeps original API origin while a selected SENT aggregate depends on it, then reclaims it', async () => {
  await withMigratedDb((db) => {
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
       VALUES('l2-link',?,'listenbrainz','remote',X'00','e1',1,'active',1,1)`,
      DID,
    );
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?, 'api-op','listenbrainz',?,?,1,1)`,
      DID,
      URI,
      INCARNATION,
    );
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?, 'api-op-later','lastfm',?,?,2,1)`,
      DID,
      URI,
      INCARNATION,
    );
    db.run(
      `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms)
       VALUES(?,?,?,'l2-link',1,1,'present','api-op',1,1)`,
      DID,
      URI,
      INCARNATION,
    );
    db.run(
      `INSERT INTO love_api_comparison_facts(authorization_uri,authorization_rev,fact_seq,action,cid,horizon_ms,created_at_ms)
       VALUES(?, '3mchjvhag2422',1,'delete','',2,1)`,
      URI,
    );

    const bindingPass = reclaimLoveApiProofRows(db, 10);
    expect(bindingPass).toMatchObject({ lane: 'binding', visited: 2, bindingsDeleted: 0 });
    expect(db.one("SELECT api_origin FROM love_api_bindings WHERE operation_id='api-op'")).toEqual({
      api_origin: 'listenbrainz',
    });
    expect(db.one("SELECT api_origin FROM love_api_bindings WHERE operation_id='api-op-later'")).toEqual({
      api_origin: 'lastfm',
    });
    expect(db.one('SELECT count(*) AS n FROM love_api_bindings')).toEqual({ n: 2 });
    const factPass = reclaimLoveApiProofRows(db, 10);
    expect(factPass).toMatchObject({ lane: 'fact', visited: 1, factsDeleted: 1 });
    expect(db.one('SELECT 1 FROM love_api_comparison_facts')).toBeNull();

    db.run("UPDATE love_api_recipients SET state='released',sent_operation_id=NULL WHERE link_id='l2-link'");
    expect(reclaimLoveApiProofRows(db, 11)).toMatchObject({ lane: 'binding', visited: 2, bindingsDeleted: 2 });
    expect(db.one('SELECT 1 FROM love_api_bindings')).toBeNull();
  });
});

it('does not create maintenance writes after its empty singleton/frontiers are initialized', async () => {
  await withMigratedDb((raw) => {
    const first = reclaimLoveApiProofRows(raw, 10);
    expect(first).toMatchObject({ visited: 0, bindingsDeleted: 0, factsDeleted: 0 });
    const afterFirst = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
    reclaimLoveApiProofRows(raw, 11);
    expect(raw.one<{ n: number }>('SELECT total_changes() AS n')!.n).toBe(afterFirst);
  });
});

it('validates reclaim page bounds and refuses an unsafe pass successor without committing its cursor', async () => {
  await withMigratedDb((db) => {
    for (const limit of [0, -1, 1.5, LOVE_API_RECLAIM_PAGE + 1])
      expect(() => reclaimLoveApiProofRows(db, 10, limit)).toThrow(RangeError);

    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
       VALUES('reclaim-bound-link',?,'listenbrainz','remote',X'00','e1',1,'active',1,1)`,
      DID,
    );
    db.run(
      `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
       VALUES(?, 'reclaim-bound-op','web',?,?,1,1)`,
      DID,
      URI,
      INCARNATION,
    );
    db.run(
      `INSERT INTO love_api_comparison_facts(authorization_uri,authorization_rev,fact_seq,action,cid,horizon_ms,created_at_ms)
       VALUES(?,?,1,'delete','',2,1)`,
      URI,
      '3mchjvhag2422',
    );
    db.run('INSERT INTO love_api_proof_state(singleton,reclaim_passes) VALUES(1,?)', Number.MAX_SAFE_INTEGER - 1);

    // The current safe pass value advances to its maximum on the first finite
    // reclaim pass. Completing that frontier does not wrap or rebase it.
    expect(reclaimLoveApiProofRows(db, 10)).toMatchObject({ lane: 'binding', visited: 1, bindingsDeleted: 1 });
    expect(db.one('SELECT reclaim_passes FROM love_api_proof_state WHERE singleton=1')).toEqual({
      reclaim_passes: Number.MAX_SAFE_INTEGER,
    });
    const before = db.one('SELECT * FROM love_api_proof_state WHERE singleton=1');
    expect(() => reclaimLoveApiProofRows(db, 10)).toThrow(RangeError);
    expect(db.one('SELECT * FROM love_api_proof_state WHERE singleton=1')).toEqual(before);
    expect(db.one('SELECT 1 FROM love_api_comparison_facts WHERE authorization_uri=?', URI)).not.toBeNull();
  });
});
