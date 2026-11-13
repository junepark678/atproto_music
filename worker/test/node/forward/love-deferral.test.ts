import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import { authorizePendingRemovals } from '../../../src/do/ingest/live-pending-removals';
import { desiredLoved, runLoveCoverageChunk } from '../../../src/forward/love-coverage';
import { recordVerifiedDeferredLoveAuthority } from '../../../src/forward/love-coverage-authority';
import { allocateDeferredSequence, hasArmedLoveCoverage } from '../../../src/forward/love-deferral-storage';
import { remoteLoveState } from '../../../src/forward/love-delivery';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { reopen, withMigratedDb } from '../../node/support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';

function addLink(
  db: Parameters<typeof enqueueForwards>[0],
  id: string,
  service: 'lastfm' | 'listenbrainz',
  enabled: boolean,
) {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,forward_scrobbles,
       status,backfill_state,created_at_ms,updated_at_ms)
     VALUES(?,?,?,'remote',X'00','e1',1,?,'active','done',1,1)`,
    id,
    DID,
    service,
    enabled ? 1 : 0,
  );
}

describe('deferred love coverage', () => {
  it('retains only exact verified authority facts and never clears a conflict', async () => {
    await withMigratedDb((db) => {
      const authorization = { uri: `at://${DID}/com.example.atmusic.love/retained`, rev: '3lbcdefghijmu' };
      expect(recordVerifiedDeferredLoveAuthority(db, authorization, { action: 'delete', cid: '' }, 20)).toBe('active');
      expect(recordVerifiedDeferredLoveAuthority(db, authorization, { action: 'update', cid: 'bbcdefghij' }, 21)).toBe(
        'conflicted',
      );
      expect(recordVerifiedDeferredLoveAuthority(db, authorization, { action: 'delete', cid: '' }, 22)).toBe(
        'conflicted',
      );
      expect(db.one('SELECT action,cid,state FROM forward_deferred_love_authorities')).toEqual({
        action: 'delete',
        cid: '',
        state: 'conflicted',
      });
      expect(
        recordVerifiedDeferredLoveAuthority(
          db,
          { uri: `https://${DID}/bad`, rev: 'rev' },
          { action: 'delete', cid: '' },
          23,
        ),
      ).toBe('refused');
      expect(
        recordVerifiedDeferredLoveAuthority(db, authorization, { action: 'delete', cid: 'delete-cid-is-invalid' }, 24),
      ).toBe('refused');
      const conflictedAuthorization = { uri: `at://${DID}/com.example.atmusic.love/conflicted`, rev: '3lbcdefghijku' };
      expect(
        recordVerifiedDeferredLoveAuthority(
          db,
          conflictedAuthorization,
          { action: 'update', cid: 'babcdefgh', conflicted: true },
          25,
        ),
      ).toBe('conflicted');
      expect(
        db.one(
          'SELECT action,cid,state,due_seq FROM forward_deferred_love_authorities WHERE authorization_uri=?',
          conflictedAuthorization.uri,
        ),
      ).toMatchObject({ action: 'update', cid: 'babcdefgh', state: 'conflicted' });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_authorities')).toEqual({ n: 2 });
    });
  });

  it('records a disabled-link unlove and emits it once after history coverage resumes', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'deferred-link', 'lastfm', false);
      const [artistKey, trackKeyValue] = trackKey('Artist', 'Track');
      db.run(
        `INSERT INTO forward_love_delivery(link_id,generation,love_artist_key,love_track_key,last_sent_kind,last_sent_dedupe_key,row_created_at_ms,sent_at_ms)
         VALUES('deferred-link',1,?,?, 'love','prior-love',10,11)`,
        artistKey,
        trackKeyValue,
      );
      const args = {
        did: DID,
        items: [
          {
            kind: 'unlove' as const,
            operationId: 'deferred-unlove',
            payload: { artist: 'Artist', track: 'Track', origin: 'api' },
          },
        ],
        now: 20,
        random: seededRandom(21),
      };
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,state,due_at,created_at_ms,updated_at_ms,send_state)
         VALUES('deferred-unlove',?,'love.delete','web',0,'com.example.atmusic.love','queued',20,20,20,'unsent')`,
        DID,
      );
      expect(enqueueForwards(db, args)).toBe(0);
      expect(db.one('SELECT kind,operation_id,payload_json FROM forward_deferred_love_intents')).toEqual({
        kind: 'unlove',
        operation_id: 'deferred-unlove',
        payload_json: JSON.stringify({ artist: 'Artist', track: 'Track', origin: 'api' }),
      });
      expect(db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 0 });
      expect(db.one('SELECT count(*) AS n FROM forward_receipts')).toEqual({ n: 0 });
      expect(hasArmedLoveCoverage(db, { id: 'deferred-link', generation: 1 })).toBe(true);

      db.run("INSERT INTO users(did,joined_at) VALUES(?,'2026-01-15T12:00:00Z')", DID);
      db.run(
        'INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms) VALUES(?,?,?,?,?)',
        DID,
        `${artistKey}\0${trackKeyValue}`,
        'unlove',
        'deferred-unlove',
        20,
      );
      db.run(
        "UPDATE linked_accounts SET forward_scrobbles=1,backfill_state='running',backfill_discovery_done=1 WHERE id='deferred-link'",
      );
      const link = db.one('SELECT * FROM linked_accounts WHERE id=?', 'deferred-link')!;
      expect(db.one('SELECT origin_class,authorization_uri,intent_at_ms FROM forward_deferred_love_intents')).toEqual({
        origin_class: 'operation',
        authorization_uri: null,
        intent_at_ms: 20,
      });
      expect(db.all('SELECT did,artist_key,track_key FROM loves')).toEqual([]);
      expect(db.one('SELECT state FROM operations WHERE id=?', 'deferred-unlove')).toEqual({ state: 'queued' });
      const intent = db.one('SELECT * FROM forward_deferred_love_intents')!;
      expect(
        desiredLoved(
          db,
          link as Parameters<typeof desiredLoved>[1],
          intent as Parameters<typeof desiredLoved>[2],
          artistKey,
          trackKeyValue,
        ),
      ).toBe(false);
      expect(remoteLoveState(db, { id: 'deferred-link', generation: 1 }, artistKey, trackKeyValue)).toBe('love');
      expect(runLoveCoverageChunk(db, link as never, 30, seededRandom(22), 128)).toBe(1);
      expect(db.all("SELECT name,label,value FROM counters WHERE name='link_coverage'")).toContainEqual({
        name: 'link_coverage',
        label: 'deferred_coverage_unlove',
        value: 1,
      });
      expect(db.all("SELECT kind,state,dedupe_key,payload_json FROM forward_outbox WHERE kind='unlove'")).toEqual([
        {
          kind: 'unlove',
          state: 'queued',
          dedupe_key: 'deferred-unlove',
          payload_json: JSON.stringify({ artist: 'Artist', track: 'Track', origin: 'api' }),
        },
      ]);
      expect(
        db.one("SELECT retired_at_ms FROM forward_receipts WHERE kind='unlove' AND dedupe_key='deferred-unlove'"),
      ).toEqual({ retired_at_ms: null });
      expect(hasArmedLoveCoverage(db, { id: 'deferred-link', generation: 1 })).toBe(false);
      expect(runLoveCoverageChunk(db, link as never, 31, seededRandom(23), 128)).toBe(0);
      expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 1 });
    });
  });

  it('keeps source exclusions and exact-generation witness rebinding local to the addressed link', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'excluded-source', 'lastfm', false);
      addLink(db, 'deferred-target', 'listenbrainz', false);
      expect(
        enqueueForwards(db, {
          did: DID,
          excludeSourceService: 'lastfm',
          items: [{ kind: 'unlove', operationId: 'source-op', payload: { artist: 'Artist', track: 'Track' } }],
          now: 40,
          random: seededRandom(24),
        }),
      ).toBe(0);
      expect(db.all('SELECT link_id FROM forward_deferred_love_witnesses ORDER BY link_id')).toEqual([
        { link_id: 'deferred-target' },
      ]);
      expect(db.all('SELECT link_id FROM forward_deferred_love_intents ORDER BY link_id')).toEqual([
        { link_id: 'deferred-target' },
      ]);
      enqueueForwards(db, {
        did: DID,
        excludeSourceService: 'lastfm',
        items: [
          { kind: 'love', operationId: 'source-love', payload: { artist: 'Artist', track: 'Track', origin: 'api' } },
        ],
        now: 40,
        random: seededRandom(240),
      });
      expect(
        db.all(
          'SELECT link_id FROM forward_deferred_love_witnesses WHERE operation_id=? ORDER BY link_id',
          'source-love',
        ),
      ).toEqual([{ link_id: 'deferred-target' }]);

      db.run("UPDATE linked_accounts SET generation=2,backfill_state='done' WHERE id='deferred-target'");
      expect(
        enqueueForwards(db, {
          did: DID,
          linkId: 'deferred-target',
          items: [
            {
              kind: 'unlove',
              operationId: 'source-op',
              payload: { artist: 'Artist', track: 'Track', album: 'different' },
            },
          ],
          now: 41,
          random: seededRandom(25),
        }),
      ).toBe(0);
      expect(
        db.all('SELECT generation,operation_id FROM forward_deferred_love_witnesses WHERE operation_id=?', 'source-op'),
      ).toEqual([
        { generation: 1, operation_id: 'source-op' },
        { generation: 2, operation_id: 'source-op' },
      ]);
      expect(
        db.one(
          'SELECT count(DISTINCT group_seq) AS n FROM forward_deferred_love_witnesses WHERE link_id=?',
          'deferred-target',
        ),
      ).toEqual({ n: 2 });
    });
  });

  it('keeps normal opposite-kind enqueue available after a deferred-witness rejection', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'enabled-link', 'lastfm', true);
      const first = enqueueForwards(db, {
        did: DID,
        items: [{ kind: 'love', operationId: 'same-op', payload: { artist: 'Artist', track: 'Track' } }],
        now: 45,
        random: seededRandom(241),
      });
      const opposite = enqueueForwards(db, {
        did: DID,
        items: [
          { kind: 'unlove', operationId: 'same-op', payload: { artist: 'Artist', track: 'Track', album: 'Album' } },
        ],
        now: 46,
        random: seededRandom(242),
      });
      expect(first).toBe(1);
      expect(opposite).toBe(1);
      expect(db.all('SELECT kind,dedupe_key,payload_json FROM forward_outbox ORDER BY kind')).toEqual([
        { kind: 'love', dedupe_key: 'same-op', payload_json: JSON.stringify({ artist: 'Artist', track: 'Track' }) },
        {
          kind: 'unlove',
          dedupe_key: 'same-op',
          payload_json: JSON.stringify({ artist: 'Artist', track: 'Track', album: 'Album' }),
        },
      ]);
      expect(db.one('SELECT 1 FROM forward_deferred_love_intents')).toBeNull();
    });
  });

  it('bridges H1 conflict before A2 authorization and keeps authority until the dependent effect settles', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'authority-link', 'lastfm', false);
      const uri = `at://${DID}/com.example.atmusic.love/authority-rkey`;
      const rev = '3lbcdefghijkl';
      enqueueHints(db, [
        {
          did: DID,
          collection: 'com.example.atmusic.love',
          rkey: 'authority-rkey',
          source: 'jetstream',
          hintRev: rev,
          live: { operation: 'delete' },
          receiptMs: 100,
        },
      ]);
      enqueueForwards(db, {
        did: DID,
        items: [
          {
            kind: 'unlove',
            operationId: 'authorized-unlove',
            payload: { artist: 'Artist', track: 'Track', origin: 'web' },
            authorization: { uri, rev },
          },
        ],
        now: 101,
        random: seededRandom(26),
      });
      const before = db.one('SELECT state,authority_seq,action,cid FROM forward_deferred_love_authorities');
      expect(before).toMatchObject({ state: 'active', action: 'delete', cid: '' });
      db.run(
        `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
           created_at_ms,updated_at_ms,love_artist_key,love_track_key,authorization_uri,authorization_rev)
         VALUES('authorized-effect','authority-link',1,?,'unlove','effect-op','{}','queued',0,101,101,101,?,?,?,?)`,
        DID,
        trackKey('Artist', 'Track')[0],
        trackKey('Artist', 'Track')[1],
        uri,
        rev,
      );
      enqueueHints(db, [
        {
          did: DID,
          collection: 'com.example.atmusic.love',
          rkey: 'authority-rkey',
          source: 'jetstream',
          hintRev: rev,
          live: { operation: 'create', cid: 'replacement-cid' },
          receiptMs: 102,
        },
      ]);
      expect(db.one('SELECT conflicted FROM live_pending_removal_events WHERE uri=? AND rev=?', uri, rev)).toEqual({
        conflicted: 1,
      });
      expect(db.one('SELECT state,last_error FROM forward_outbox WHERE id=?', 'authorized-effect')).toEqual({
        state: 'ignored',
        last_error: 'authorization_conflicted',
      });
      expect(
        db.one(
          'SELECT state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
          uri,
          rev,
        ),
      ).toEqual({
        state: 'conflicted',
      });
      expect(
        db.one(
          'SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
          uri,
          rev,
        ),
      ).not.toBeNull();
      expect(
        db.one(
          'SELECT 1 FROM forward_deferred_love_intents WHERE authorization_uri=? AND authorization_rev=?',
          uri,
          rev,
        ),
      ).not.toBeNull();
    });
  });

  it('records the exact trusted A2 update CID as deferred unlove authority', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'update-authority-link', 'lastfm', false);
      const uri = `at://${DID}/com.example.atmusic.love/update-rkey`;
      const rev = '3lbcdefghijmu';
      enqueueHints(db, [
        {
          did: DID,
          collection: 'com.example.atmusic.love',
          rkey: 'update-rkey',
          source: 'jetstream',
          hintRev: rev,
          live: { operation: 'update', cid: 'babcdefgh' },
          receiptMs: 600,
        },
      ]);
      enqueueForwards(db, {
        did: DID,
        items: [
          {
            kind: 'unlove',
            operationId: 'trusted-update-unlove',
            payload: { artist: 'Artist', track: 'Update Track' },
            authorization: { uri, rev },
          },
        ],
        now: 601,
        random: seededRandom(601),
      });
      expect(
        db.one(
          'SELECT action,cid,state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
          uri,
          rev,
        ),
      ).toEqual({ action: 'update', cid: 'babcdefgh', state: 'active' });
      expect(
        db.one(
          'SELECT kind,authorization_uri,authorization_rev FROM forward_deferred_love_intents WHERE operation_id=?',
          'trusted-update-unlove',
        ),
      ).toEqual({ kind: 'unlove', authorization_uri: uri, authorization_rev: rev });
    });
  });

  it('uses witnessed chain order before API slots and lets cancelled slots fall through to the projection', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'desired-link', 'lastfm', false);
      db.run("INSERT INTO users(did,joined_at) VALUES(?,'2026-01-15T12:00:00Z')", DID);
      const link = db.one('SELECT * FROM linked_accounts WHERE id=?', 'desired-link')!;
      let nextHead = 1;
      const addChain = (
        artist: string,
        track: string,
        operationId: string,
        kind: 'love' | 'unlove',
        origin: 'operation' | 'live_love' | 'authorized',
        at: number,
      ) => {
        const [artistKey, trackKeyValue] = trackKey(artist, track);
        db.run(
          `INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,created_at_ms)
           VALUES('desired-link',1,?,?,?,?)`,
          artistKey,
          trackKeyValue,
          nextHead++,
          at,
        );
        db.run(
          `INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,
             operation_id,origin_class,payload_json,authorization_uri,authorization_rev,intent_at_ms)
           VALUES('desired-link',1,?,?,1,?,?,?,'{}',?,?,?)`,
          artistKey,
          trackKeyValue,
          kind,
          operationId,
          origin,
          origin === 'authorized' ? `at://${DID}/com.example.atmusic.love/${operationId}` : null,
          origin === 'authorized' ? '3lbcdefghijkd' : null,
          at,
        );
        return {
          artistKey,
          trackKeyValue,
          intent: db.one('SELECT * FROM forward_deferred_love_intents WHERE operation_id=?', operationId)!,
        };
      };
      const addProjection = (artist: string, track: string, artistKey: string, trackKeyValue: string) =>
        db.run(
          `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,created_at,indexed_at)
           VALUES(?,?,'rkey','cid',?,?,?,?,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z')`,
          `at://${DID}/com.example.atmusic.love/${artist.replaceAll(' ', '-')}`,
          DID,
          artist,
          track,
          artistKey,
          trackKeyValue,
        );

      const equal = addChain('Equal Artist', 'Equal Track', 'witnessed-love', 'love', 'operation', 100);
      db.run(
        `INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
           love_track_key,created_at_ms) VALUES('desired-link',1,'witnessed-love',1,'love',?,?,100)`,
        equal.artistKey,
        equal.trackKeyValue,
      );
      db.run(
        'INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms) VALUES(?,?,?,?,?)',
        DID,
        `${equal.artistKey}\0${equal.trackKeyValue}`,
        'unlove',
        'same-time-api-unlove',
        100,
      );
      expect(desiredLoved(db, link as never, equal.intent as never, equal.artistKey, equal.trackKeyValue)).toBe(true);

      const missingSlot = addChain(
        'Missing Slot Artist',
        'Missing Slot Track',
        'api-unlove',
        'unlove',
        'operation',
        200,
      );
      addProjection('Missing Slot Artist', 'Missing Slot Track', missingSlot.artistKey, missingSlot.trackKeyValue);
      expect(
        desiredLoved(db, link as never, missingSlot.intent as never, missingSlot.artistKey, missingSlot.trackKeyValue),
      ).toBe(false);

      const cancelled = addChain(
        'Cancelled Artist',
        'Cancelled Track',
        'authorized-unlove',
        'unlove',
        'authorized',
        300,
      );
      addProjection('Cancelled Artist', 'Cancelled Track', cancelled.artistKey, cancelled.trackKeyValue);
      db.run(
        `INSERT INTO operations(id,did,kind,origin,priority,collection,state,due_at,created_at_ms,updated_at_ms)
         VALUES('cancelled-new-love',?,'love.put','web',0,'com.example.atmusic.love','cancelled',1,1,1)`,
        DID,
      );
      db.run(
        'INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms) VALUES(?,?,?,?,?)',
        DID,
        `${cancelled.artistKey}\0${cancelled.trackKeyValue}`,
        'love',
        'cancelled-new-love',
        301,
      );
      expect(
        desiredLoved(db, link as never, cancelled.intent as never, cancelled.artistKey, cancelled.trackKeyValue),
      ).toBe(true);

      const override = addChain('Override Artist', 'Override Track', 'older-chain-love', 'love', 'operation', 400);
      db.run(
        'INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms) VALUES(?,?,?,?,?)',
        DID,
        `${override.artistKey}\0${override.trackKeyValue}`,
        'unlove',
        'new-unwitnessed-unlove',
        401,
      );
      expect(
        desiredLoved(db, link as never, override.intent as never, override.artistKey, override.trackKeyValue),
      ).toBe(true);
    });
  });

  it('keeps H1/H2 conflict sticky for held and MBID-revivable effects as well as the deferred intent', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'authority-link', 'listenbrainz', false);
      for (const [suffix, state, lastError] of [
        ['l', 'held', null],
        ['m', 'ignored', 'no_recording_mbid'],
      ] as const) {
        const uri = `at://${DID}/com.example.atmusic.love/sticky-${suffix}`;
        const rev = `3lbcdefghijk${suffix}`;
        enqueueHints(db, [
          {
            did: DID,
            collection: 'com.example.atmusic.love',
            rkey: `sticky-${suffix}`,
            source: 'jetstream',
            hintRev: rev,
            live: { operation: 'delete' },
            receiptMs: 500,
          },
        ]);
        enqueueForwards(db, {
          did: DID,
          items: [
            {
              kind: 'unlove',
              operationId: `sticky-op-${suffix}`,
              payload: { artist: 'Artist', track: `Track ${suffix}` },
              authorization: { uri, rev },
            },
          ],
          now: 501,
          random: seededRandom(300 + suffix.charCodeAt(0)),
        });
        const [artistKey, trackKeyValue] = trackKey('Artist', `Track ${suffix}`);
        db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,
             created_at_ms,updated_at_ms,last_error,love_artist_key,love_track_key,authorization_uri,authorization_rev)
           VALUES(?, 'authority-link',1,?,'unlove',?,'{}',?,0,501,501,501,?,?,?,?,?)`,
          `sticky-effect-${suffix}`,
          DID,
          `sticky-op-${suffix}`,
          state,
          lastError,
          artistKey,
          trackKeyValue,
          uri,
          rev,
        );
        if (suffix === 'm') {
          const rowid = db.one<{ rowid: number }>(
            'SELECT rowid FROM forward_outbox WHERE id=?',
            `sticky-effect-${suffix}`,
          )!.rowid;
          db.run(
            `INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid)
             VALUES(?,'authority-link',1,?,?,501,'11111111-2222-4333-8444-555555555555')`,
            rowid,
            artistKey,
            trackKeyValue,
          );
        }
        enqueueHints(db, [
          {
            did: DID,
            collection: 'com.example.atmusic.love',
            rkey: `sticky-${suffix}`,
            source: 'jetstream',
            hintRev: rev,
            live: { operation: 'create', cid: `replacement-${suffix}` },
            receiptMs: 502,
          },
        ]);
        expect(db.one('SELECT state,last_error FROM forward_outbox WHERE id=?', `sticky-effect-${suffix}`)).toEqual({
          state: 'ignored',
          last_error: 'authorization_conflicted',
        });
        expect(
          db.one(
            'SELECT state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
            uri,
            rev,
          ),
        ).toEqual({ state: 'conflicted' });
        expect(
          db.one(
            'SELECT 1 FROM forward_deferred_love_intents WHERE authorization_uri=? AND authorization_rev=?',
            uri,
            rev,
          ),
        ).not.toBeNull();
      }
    });
  });

  it('fails closed when an authorized writer has no durable producer fact and H2 makes an A2 conflict sticky', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'authority-link', 'lastfm', false);
      const missing = { uri: `at://${DID}/com.example.atmusic.love/missing`, rev: '3lbcdefghijkm' };
      enqueueForwards(db, {
        did: DID,
        items: [
          {
            kind: 'unlove',
            operationId: 'missing-fact',
            payload: { artist: 'Artist', track: 'Track' },
            authorization: missing,
          },
        ],
        now: 200,
        random: seededRandom(27),
      });
      expect(
        db.one('SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=?', missing.uri),
      ).toBeNull();
      expect(db.one('SELECT 1 FROM forward_deferred_love_intents WHERE operation_id=?', 'missing-fact')).toBeNull();
      expect(
        db.one('SELECT 1 FROM forward_deferred_love_witnesses WHERE operation_id=?', 'missing-fact'),
      ).not.toBeNull();

      const uri = `at://${DID}/com.example.atmusic.love/h2-rkey`;
      const rev = '3lbcdefghijkn';
      enqueueHints(db, [
        {
          did: DID,
          collection: 'com.example.atmusic.love',
          rkey: 'h2-rkey',
          source: 'jetstream',
          hintRev: rev,
          live: { operation: 'delete' },
          receiptMs: 201,
        },
      ]);
      enqueueForwards(db, {
        did: DID,
        items: [
          {
            kind: 'unlove',
            operationId: 'h2-unlove',
            payload: { artist: 'Other', track: 'Song', origin: 'web' },
            authorization: { uri, rev },
          },
        ],
        now: 202,
        random: seededRandom(28),
      });
      authorizePendingRemovals(db, { uri, rev, action: 'delete', conflicted: true }, 203);
      expect(
        db.one(
          'SELECT state FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
          uri,
          rev,
        ),
      ).toEqual({
        state: 'conflicted',
      });
    });
  });

  it('does not bind delayed authorization to evidence for a different record revision', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'authority-link', 'lastfm', false);
      const uri = `at://${DID}/com.example.atmusic.love/delayed`;
      recordLiveEvidence(
        db,
        {
          uri,
          did: DID,
          collection: 'com.example.atmusic.love',
          rkey: 'delayed',
          rev: '3lbcdefghijkn',
          action: 'update',
          cid: 'current-cid',
        },
        300,
      );
      enqueueForwards(db, {
        did: DID,
        items: [
          {
            kind: 'unlove',
            operationId: 'delayed-old-revision',
            payload: { artist: 'Artist', track: 'Track' },
            authorization: { uri, rev: '3lbcdefghijkm' },
          },
        ],
        now: 301,
        random: seededRandom(29),
      });
      expect(db.one('SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=?', uri)).toBeNull();
      expect(
        db.one('SELECT 1 FROM forward_deferred_love_intents WHERE operation_id=?', 'delayed-old-revision'),
      ).toBeNull();
      expect(
        db.one('SELECT 1 FROM forward_deferred_love_witnesses WHERE operation_id=?', 'delayed-old-revision'),
      ).not.toBeNull();
    });
  });

  it('allows the last safe sequence successor and rolls back sequence exhaustion', async () => {
    await withMigratedDb((db) => {
      const beforeLastSafe = BigInt(Number.MAX_SAFE_INTEGER) - 1n;
      db.run(
        'INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq) VALUES(1,?)',
        beforeLastSafe.toString(),
      );
      expect(db.tx(() => allocateDeferredSequence(db, 'next_head_seq'))).toBe(Number.MAX_SAFE_INTEGER - 1);
      expect(db.one('SELECT CAST(next_head_seq AS TEXT) AS value FROM forward_deferred_love_maintenance')).toEqual({
        value: String(Number.MAX_SAFE_INTEGER),
      });
      expect(() => db.tx(() => allocateDeferredSequence(db, 'next_head_seq'))).toThrow(/exhausted/);
      expect(db.one('SELECT CAST(next_head_seq AS TEXT) AS value FROM forward_deferred_love_maintenance')).toEqual({
        value: String(Number.MAX_SAFE_INTEGER),
      });
    });
  });

  it('restores populated B2 rows exactly and cascades link-owned state without resetting global allocators', async () => {
    await withMigratedDb((initial) => {
      addLink(initial, 'restore-deferred', 'lastfm', false);
      enqueueForwards(initial, {
        did: DID,
        linkId: 'restore-deferred',
        items: [
          { kind: 'unlove', operationId: 'restore-op', payload: { artist: 'Restore Artist', track: 'Restore Track' } },
        ],
        now: 400,
        random: seededRandom(30),
      });
      const [artistKey, trackKeyValue] = trackKey('Restore Artist', 'Restore Track');
      initial.run(
        `INSERT INTO forward_love_delivery(link_id,generation,love_artist_key,love_track_key,last_sent_kind,
           last_sent_dedupe_key,row_created_at_ms,sent_at_ms) VALUES(?,1,?,?,'love','retained',1,2)`,
        'restore-deferred',
        artistKey,
        trackKeyValue,
      );
      const db = reopen(initial);
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual({ n: 1 });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_heads')).toEqual({ n: 1 });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_intents')).toEqual({ n: 1 });
      expect(db.one('SELECT count(*) AS n FROM forward_love_delivery')).toEqual({ n: 1 });
      const allocators = db.one('SELECT next_head_seq,next_group_seq FROM forward_deferred_love_maintenance');
      db.run("DELETE FROM linked_accounts WHERE id='restore-deferred'");
      for (const table of [
        'forward_love_delivery',
        'forward_deferred_love_heads',
        'forward_deferred_love_intents',
        'forward_deferred_love_witnesses',
      ])
        expect(db.one(`SELECT 1 FROM ${table} WHERE link_id='restore-deferred'`), table).toBeNull();
      expect(db.one('SELECT next_head_seq,next_group_seq FROM forward_deferred_love_maintenance')).toEqual(allocators);
    });
  });
});
