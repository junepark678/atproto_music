import { expect, it } from 'vitest';
import { dueRows } from '../../src/forward/forward-outbox';
import { backfillLoveReviveKeys, enqueueRevivedLoves } from '../../src/musicbrainz/revive-loves';
import { withMigratedDb } from './support/node-db';

it('revives an unresolved generation-2 love into its current destination generation', async () => {
  await withMigratedDb((db) => {
    const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    db.run(
      "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms,generation) VALUES('link',?,'listenbrainz','replacement',x'00','key',1,1,2)",
      did,
    );
    db.run(
      "INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms,generation) VALUES('ignored','link',?,'love','g2:op',?,'ignored',0,0,'mbid_unresolved',1,1,2)",
      did,
      JSON.stringify({ artist: 'Artist', track: 'Track' }),
    );
    backfillLoveReviveKeys(db, 100);
    expect(
      enqueueRevivedLoves(
        db,
        { artistKey: 'artist', trackKey: 'track' },
        '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
        10,
        100,
      ).enqueued,
    ).toBe(1);
    const row = db.one<{ generation: number; dedupe_key: string }>(
      "SELECT generation,dedupe_key FROM forward_outbox WHERE state='queued'",
    );
    expect(row?.generation).toBe(2);
    expect(row?.dedupe_key).toMatch(/^g2:/);
    expect(dueRows(db, 'link', 2, 'love', 10, 100)).toHaveLength(1);
  });
});

it('does not revive work addressed to an obsolete destination generation', async () => {
  await withMigratedDb((db) => {
    const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    db.run(
      "INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms,generation) VALUES('link',?,'listenbrainz','replacement',x'00','key',1,1,2)",
      did,
    );
    db.run(
      "INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,created_at_ms,updated_at_ms,generation) VALUES('ignored','link',?,'love','old-op',?,'ignored',0,0,'mbid_unresolved',1,1,1)",
      did,
      JSON.stringify({ artist: 'Artist', track: 'Track' }),
    );
    backfillLoveReviveKeys(db, 100);
    expect(
      enqueueRevivedLoves(
        db,
        { artistKey: 'artist', trackKey: 'track' },
        '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
        10,
        100,
      ).enqueued,
    ).toBe(0);
    expect(db.all("SELECT id FROM forward_outbox WHERE state='queued'")).toHaveLength(0);
  });
});
