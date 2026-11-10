import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { expireRows, settleRows } from '../../../src/forward/forward-outbox';
import { remoteLoveState } from '../../../src/forward/love-delivery';
import { withMigratedDb } from '../../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

function insertRow(
  db: Db,
  values: {
    id: string;
    kind: 'love' | 'unlove';
    dedupeKey: string;
    state: 'queued' | 'sent' | 'held';
    createdAtMs: number;
  },
) {
  db.run(
    `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
       created_at_ms,updated_at_ms,love_artist_key,love_track_key)
     VALUES(?,?,2,?,?,?,?,?,0,?,?,?,'artist-key','track-key')`,
    values.id,
    'love-link',
    DID,
    values.kind,
    values.dedupeKey,
    JSON.stringify({ artist: 'Artist', track: 'Track' }),
    values.state,
    values.createdAtMs,
    values.createdAtMs,
    values.createdAtMs,
  );
}

function insertRecipientMember(db: Db, operationId: string) {
  db.run(
    `INSERT OR IGNORE INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,created_at_ms,updated_at_ms)
     VALUES(?,?,'incarnation','love-link',2,1,'sealed',1,1)`,
    DID,
    `at://${DID}/com.example.atmusic.love/recipient`,
  );
  db.run(
    `INSERT INTO love_api_recipient_members(link_id,generation,operation_id,did,uri,incarnation_key,member_seq,created_at_ms)
     VALUES('love-link',2,?,?,?,'incarnation',1,1)`,
    operationId,
    DID,
    `at://${DID}/com.example.atmusic.love/recipient`,
  );
}

describe('love delivery ledger', () => {
  it('clears a recipient member on failed terminal settlement without promoting positive proof', async () => {
    await withMigratedDb((db) => {
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
         VALUES('love-link',?,'lastfm','remote',X'00','e1',2,'active',1,1)`,
        DID,
      );
      insertRecipientMember(db, 'failed-member');
      insertRow(db, {
        id: 'failed-member',
        kind: 'love',
        dedupeKey: 'g2:failed-member',
        state: 'queued',
        createdAtMs: 10,
      });
      settleRows(db, ['failed-member'], 'failed', 20, 'test_failure', true, 2);
      expect(db.one('SELECT 1 FROM love_api_recipient_members WHERE operation_id=?', 'failed-member')).toBeNull();
      expect(db.one('SELECT sent_operation_id FROM love_api_recipients')).toEqual({ sent_operation_id: null });
    });
  });

  it('clears members from both age and held expiry RETURNING transitions', async () => {
    await withMigratedDb((db) => {
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
         VALUES('love-link',?,'lastfm','remote',X'00','e1',2,'active',1,1)`,
        DID,
      );
      insertRecipientMember(db, 'aged-member');
      insertRow(db, { id: 'aged-member', kind: 'love', dedupeKey: 'g2:aged-member', state: 'queued', createdAtMs: 10 });
      const aged = expireRows(db, 14 * 24 * 60 * 60 * 1000);
      expect(aged.aged).toBe(1);
      expect(db.one('SELECT 1 FROM love_api_recipient_members WHERE operation_id=?', 'aged-member')).toBeNull();

      db.run("UPDATE love_api_recipients SET next_member_seq=2 WHERE link_id='love-link'");
      insertRecipientMember(db, 'held-member');
      insertRow(db, { id: 'held-member', kind: 'love', dedupeKey: 'g2:held-member', state: 'held', createdAtMs: 10 });
      const held = expireRows(db, 31 * 24 * 60 * 60 * 1000);
      expect(held.held).toBe(1);
      expect(db.one('SELECT 1 FROM love_api_recipient_members WHERE operation_id=?', 'held-member')).toBeNull();
      expect(db.all<{ sent_operation_id: string | null }>('SELECT sent_operation_id FROM love_api_recipients')).toEqual(
        [{ sent_operation_id: null }],
      );
    });
  });

  it('records only sent settlement, canonicalizes generations, and survives sent-row cleanup', async () => {
    await withMigratedDb((db) => {
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
         VALUES('love-link',?,'lastfm','remote',X'00','e1',2,'active',1,1)`,
        DID,
      );
      insertRow(db, { id: 'love-op', kind: 'love', dedupeKey: 'g2:love-op', state: 'queued', createdAtMs: 10 });
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('love');
      settleRows(db, ['love-op'], 'sent', 20, null, true, 2);
      expect(
        db.one('SELECT last_sent_kind,last_sent_dedupe_key,row_created_at_ms,sent_at_ms FROM forward_love_delivery'),
      ).toEqual({
        last_sent_kind: 'love',
        last_sent_dedupe_key: 'love-op',
        row_created_at_ms: 10,
        sent_at_ms: 20,
      });
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('love');
      db.run("DELETE FROM forward_outbox WHERE id='love-op'");
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('love');

      insertRow(db, { id: 'unlove-op', kind: 'unlove', dedupeKey: 'g2:unlove-op', state: 'queued', createdAtMs: 11 });
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('unlove');
      settleRows(db, ['unlove-op'], 'sent', 21, null, true, 2);
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('unlove');
      db.run("DELETE FROM forward_outbox WHERE id='unlove-op'");
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('unlove');

      insertRow(db, { id: 'later-love', kind: 'love', dedupeKey: 'g2:later-love', state: 'queued', createdAtMs: 12 });
      settleRows(db, ['later-love'], 'sent', 22, null, true, 2);
      expect(db.one('SELECT last_sent_kind,last_sent_dedupe_key FROM forward_love_delivery')).toEqual({
        last_sent_kind: 'love',
        last_sent_dedupe_key: 'later-love',
      });
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('love');
    });
  });

  it('does not let an older late settlement overwrite a newer delivered fact', async () => {
    await withMigratedDb((db) => {
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
         VALUES('love-link',?,'lastfm','remote',X'00','e1',2,'active',1,1)`,
        DID,
      );
      insertRow(db, { id: 'older', kind: 'love', dedupeKey: 'g2:older', state: 'queued', createdAtMs: 10 });
      insertRow(db, { id: 'newer', kind: 'unlove', dedupeKey: 'g2:newer', state: 'queued', createdAtMs: 11 });
      settleRows(db, ['newer'], 'sent', 21, null, true, 2);
      settleRows(db, ['older'], 'sent', 22, null, true, 2);
      expect(db.one('SELECT last_sent_kind,last_sent_dedupe_key FROM forward_love_delivery')).toEqual({
        last_sent_kind: 'unlove',
        last_sent_dedupe_key: 'newer',
      });
    });
  });

  it('uses a newer sent row when a 55-code rollback skipped the ledger write', async () => {
    await withMigratedDb((db) => {
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,created_at_ms,updated_at_ms)
         VALUES('love-link',?,'lastfm','remote',X'00','e1',2,'active',1,1)`,
        DID,
      );
      db.run(
        `INSERT INTO forward_love_delivery(link_id,generation,love_artist_key,love_track_key,last_sent_kind,
           last_sent_dedupe_key,row_created_at_ms,sent_at_ms) VALUES('love-link',2,'artist-key','track-key','love','old-love',10,11)`,
      );
      insertRow(db, {
        id: 'rollback-unlove',
        kind: 'unlove',
        dedupeKey: 'g2:rollback-unlove',
        state: 'sent',
        createdAtMs: 12,
      });
      expect(remoteLoveState(db, { id: 'love-link', generation: 2 }, 'artist-key', 'track-key')).toBe('unlove');
    });
  });
});
