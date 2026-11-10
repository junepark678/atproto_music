import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import { settleRows } from '../../../src/forward/forward-outbox';
import {
  type AcceptedApiLoveRecipientEnvelope,
  type ApiRecipientUnloveAck,
  type ApiRecipientUnloveArgs,
  enqueueApiRecipientUnlove,
  enqueueForwards,
} from '../../../src/outbox/forward-enqueue';
import { withMigratedDb } from '../support/node-db';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const REV = '3lbcdefghijmu';
const URI = `at://${DID}/com.example.atmusic.love/api-recipient`;
const INCARNATION = 'love:api-record-incarnation';
const BROAD = `love-delete:${INCARNATION}:rev:${REV}`;
const NARROW = `${BROAD}:api-recipient`;
const NOW = 100;

function addLink(db: Db, id: string, service: 'lastfm' | 'listenbrainz', mode: 'active' | 'disabled' | 'revoked') {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,generation,status,
       forward_scrobbles,backfill_state,created_at_ms,updated_at_ms)
     VALUES(?,?,?,'remote',X'00','e1',1,?,?, 'done',1,1)`,
    id,
    DID,
    service,
    mode === 'revoked' ? 'revoked' : 'active',
    mode === 'active' ? 1 : 0,
  );
}

function addApiFact(
  db: Db,
  source: 'web' | 'lastfm' | 'listenbrainz' = 'web',
  sourceService: string | null = null,
  path: 'api' | 'snapshot' | 'import' = 'api',
  requestRkey = 'request-rkey-differs',
) {
  db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
     VALUES('original-love-put',?,'love.put',?,0,'com.example.atmusic.love',?,'succeeded',1,1,1)`,
    DID,
    source,
    requestRkey,
  );
  db.run(
    `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
     VALUES(?,?,'absent',?,?,1)`,
    URI,
    INCARNATION,
    path,
    sourceService,
  );
  db.run(
    `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
     VALUES(?,?,'delete','',1,999999)`,
    URI,
    REV,
  );
  if (sourceService !== null)
    db.run(
      `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
       VALUES(?,?,?, ?,?,'bound',1)`,
      DID,
      'api-source-bridge',
      URI,
      INCARNATION,
      sourceService,
    );
}

function args(
  linkId: string,
  source: 'web' | 'lastfm' | 'listenbrainz' = 'web',
  excludeSourceServices: readonly ('lastfm' | 'listenbrainz')[] = [],
  overrides: Partial<AcceptedApiLoveRecipientEnvelope> = {},
): ApiRecipientUnloveArgs {
  const envelope: AcceptedApiLoveRecipientEnvelope = {
    did: DID,
    recordUri: URI,
    incarnationKey: INCARNATION,
    apiOperationId: 'original-love-put',
    apiRequestRkey: 'request-rkey-differs',
    projectionRkey: 'api-recipient',
    source,
    sourceExclusions: excludeSourceServices,
    projection: { artist: 'Artist', track: 'Track' },
    authorization: { uri: URI, rev: REV },
    ...overrides,
  };
  return {
    did: DID,
    linkId,
    generation: 1,
    broadOperationId: BROAD,
    operationId: NARROW,
    envelope,
    now: NOW,
    random: seededRandom(911),
  };
}

function traceDb(raw: Db): {
  db: Db;
  result: () => { reads: number; statements: number; returnedRows: number; changedRows: number };
} {
  let reads = 0;
  let statements = 0;
  let returnedRows = 0;
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const rows = raw.all<T>(sql, ...params);
      if (mutation.test(sql)) statements += 1;
      else reads += 1;
      returnedRows += rows.length;
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      reads += 1;
      const row = raw.one<T>(sql, ...params);
      if (row !== null) returnedRows += 1;
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      statements += 1;
      return raw.run(sql, ...params);
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      return raw.tx(fn);
    },
  };
  const before = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
  return {
    db,
    result: () => ({
      reads,
      statements,
      returnedRows,
      changedRows: raw.one<{ n: number }>('SELECT total_changes() AS n')!.n - before,
    }),
  };
}

function measuredRecipient(db: Db, input: ApiRecipientUnloveArgs) {
  const traced = traceDb(db);
  const ack = enqueueApiRecipientUnlove(traced.db, input);
  const cost = traced.result();
  expect(cost.changedRows, JSON.stringify(cost)).toBeLessThanOrEqual(13);
  return { ack, cost };
}

describe('API recipient unlove handoff acknowledgements', () => {
  for (const mode of ['active', 'disabled', 'revoked'] as const) {
    for (const service of ['lastfm', 'listenbrainz'] as const) {
      for (const source of ['web', 'lastfm', 'listenbrainz'] as const) {
        for (const reverse of [false, true]) {
          it(`${source} API origin -> ${service} ${mode}: broad and api-recipient identities coexist, reverse=${reverse}`, async () => {
            await withMigratedDb((db) => {
              addLink(db, 'recipient-link', service, mode);
              addApiFact(db, source);
              const broadItem = {
                kind: 'unlove' as const,
                operationId: BROAD,
                payload: { artist: 'Artist', track: 'Track', origin: source },
                authorization: { uri: URI, rev: REV },
              };
              const recipient = () => measuredRecipient(db, args('recipient-link', source));
              if (reverse) expect(recipient().ack.status).toBe(mode === 'active' ? 'queued' : 'deferred');
              enqueueForwards(db, {
                did: DID,
                linkId: 'recipient-link',
                items: [broadItem],
                now: NOW,
                random: seededRandom(1),
              });
              if (!reverse) expect(recipient().ack.status).toBe(mode === 'active' ? 'queued' : 'deferred');
              expect(
                db.all<{ operation_id: string }>(
                  'SELECT operation_id FROM forward_deferred_love_witnesses WHERE link_id=? AND generation=1 ORDER BY operation_id',
                  'recipient-link',
                ),
              ).toEqual([{ operation_id: BROAD }, { operation_id: NARROW }]);
              const expected = mode === 'active' ? [BROAD, NARROW] : [BROAD, NARROW];
              const outbox = db.all<{ dedupe_key: string }>(
                "SELECT dedupe_key FROM forward_outbox WHERE link_id=? AND kind='unlove' ORDER BY dedupe_key",
                'recipient-link',
              );
              const intents = db.all<{ operation_id: string }>(
                'SELECT operation_id FROM forward_deferred_love_intents WHERE link_id=? ORDER BY operation_id',
                'recipient-link',
              );
              expect(
                mode === 'active' ? outbox.map((row) => row.dedupe_key) : intents.map((row) => row.operation_id),
              ).toEqual(expected);
            });
          });
        }
      }
    }
  }

  it('returns queued, terminal replay and retired-receipt replay from exact current-generation lineage only', async () => {
    await withMigratedDb((raw) => {
      addLink(raw, 'ack-link', 'listenbrainz', 'active');
      addApiFact(raw);
      const first = measuredRecipient(raw, args('ack-link'));
      expect(first.ack).toEqual({ status: 'queued' });
      const trace = first.cost;
      expect(trace.changedRows).toBeLessThanOrEqual(13);
      expect(trace.reads).toBeGreaterThan(0);
      expect(trace.statements).toBeGreaterThan(0);
      expect(trace.returnedRows).toBeGreaterThan(0);

      const effect = raw.one<{ id: string; generation: number }>(
        "SELECT id,generation FROM forward_outbox WHERE link_id='ack-link' AND kind='unlove'",
      )!;
      expect(measuredRecipient(raw, args('ack-link')).ack).toEqual({ status: 'queued' });
      settleRows(raw, [effect.id], 'sent', NOW + 1, null, true, effect.generation);
      expect(measuredRecipient(raw, args('ack-link')).ack).toEqual({ status: 'replay' });

      raw.run('DELETE FROM forward_outbox WHERE id=?', effect.id);
      expect(measuredRecipient(raw, args('ack-link')).ack).toEqual({
        status: 'refused',
        reason: 'no_durable_acceptance',
      });
      raw.run(
        "UPDATE forward_receipts SET retired_at_ms=? WHERE link_id='ack-link' AND generation=1 AND kind='unlove' AND dedupe_key=?",
        NOW + 2,
        NARROW,
      );
      expect(measuredRecipient(raw, args('ack-link')).ack).toEqual({ status: 'replay' });
    });
  });

  it('keeps the 13 changed-row handoff ceiling hard under an injected write-count break', async () => {
    await withMigratedDb((raw) => {
      addLink(raw, 'budget-link', 'listenbrainz', 'active');
      addApiFact(raw);
      const traced = traceDb(raw);
      let injected = false;
      const broken: Db = {
        ...traced.db,
        one<T>(sql: string, ...params: SqlParam[]): T | null {
          if (!injected && sql.includes('FROM linked_accounts WHERE id=?')) {
            injected = true;
            for (let i = 0; i < 14; i++)
              raw.run('UPDATE linked_accounts SET updated_at_ms=updated_at_ms WHERE id=?', 'budget-link');
          }
          return traced.db.one<T>(sql, ...params);
        },
      };
      expect(enqueueApiRecipientUnlove(broken, args('budget-link')).status).toBe('queued');
      const cost = traced.result();
      expect(cost.changedRows).toBeGreaterThan(13);
      expect(() => expect(cost.changedRows).toBeLessThanOrEqual(13)).toThrow();
    });
  });

  it('preflights generation, source, survivor, authority and rebind collisions before witnesses or effects', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'guard-link', 'listenbrainz', 'active');
      addLink(db, 'excluded-link', 'lastfm', 'active');
      addApiFact(db, 'web', 'lastfm');
      const stale = traceDb(db);
      expect(enqueueApiRecipientUnlove(stale.db, { ...args('guard-link'), generation: 2 })).toMatchObject({
        status: 'refused',
      });
      expect(stale.result().changedRows).toBe(0);
      expect(enqueueApiRecipientUnlove(db, args('excluded-link', 'web', ['lastfm']))).toEqual({
        status: 'refused',
        reason: 'source_excluded',
      });
      expect(
        enqueueApiRecipientUnlove(db, {
          ...args('guard-link', 'web', ['lastfm']),
          envelope: {
            ...args('guard-link', 'web', ['lastfm']).envelope,
            authorization: { uri: URI, rev: '3lbcdefghijkm' },
          },
        }),
      ).toMatchObject({ status: 'refused' });
      expect(
        enqueueApiRecipientUnlove(db, {
          ...args('guard-link', 'web', ['lastfm']),
          envelope: {
            ...args('guard-link', 'web', ['lastfm']).envelope,
            source: 'import' as AcceptedApiLoveRecipientEnvelope['source'],
          },
        }),
      ).toEqual({
        status: 'refused',
        reason: 'accepted_envelope_invalid',
      });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual({ n: 0 });

      db.run("INSERT INTO users(did,joined_at) VALUES(?,'2026-01-15T12:00:00Z')", DID);
      const [artistKey, trackKeyValue] = trackKey('Artist', 'Track');
      db.run(
        `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,created_at,indexed_at)
         VALUES(?,?,'live','babcdefgh','Artist','Track',?,?,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z')`,
        `at://${DID}/com.example.atmusic.love/live`,
        DID,
        artistKey,
        trackKeyValue,
      );
      expect(enqueueApiRecipientUnlove(db, args('guard-link', 'web', ['lastfm']))).toEqual({
        status: 'refused',
        reason: 'canonical_survivor',
      });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual({ n: 0 });
      db.run('DELETE FROM loves');

      db.run('DELETE FROM live_pending_removal_events WHERE uri=? AND rev=?', URI, REV);
      expect(enqueueApiRecipientUnlove(db, args('guard-link', 'web', ['lastfm']))).toEqual({
        status: 'refused',
        reason: 'authority_missing',
      });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual({ n: 0 });
      db.run(
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,created_at_ms,expires_at_ms)
         VALUES(?,?,'delete','',1,1,999999)`,
        URI,
        REV,
      );
      expect(enqueueApiRecipientUnlove(db, args('guard-link', 'web', ['lastfm']))).toEqual({
        status: 'refused',
        reason: 'authority_conflicted',
      });
      expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual({ n: 0 });
    });
  });

  it('refuses a rebind and an opposite-kind identity without creating a second effect', async () => {
    await withMigratedDb((db) => {
      addLink(db, 'rebind-link', 'listenbrainz', 'active');
      addApiFact(db);
      expect(enqueueApiRecipientUnlove(db, args('rebind-link')).status).toBe('queued');
      expect(
        enqueueApiRecipientUnlove(db, {
          ...args('rebind-link'),
          envelope: {
            ...args('rebind-link').envelope,
            projection: { artist: 'Other Artist', track: 'Track' },
          },
        }),
      ).toEqual({ status: 'refused', reason: 'witness_missing_or_mismatched' });
      expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE link_id='rebind-link'")).toEqual({ n: 1 });

      db.run('DELETE FROM forward_deferred_love_witnesses WHERE operation_id=?', NARROW);
      db.run("DELETE FROM forward_outbox WHERE link_id='rebind-link'");
      enqueueForwards(db, {
        did: DID,
        linkId: 'rebind-link',
        items: [{ kind: 'love', operationId: NARROW, payload: { artist: 'Artist', track: 'Track', origin: 'web' } }],
        now: NOW,
        random: seededRandom(12),
      });
      expect(enqueueApiRecipientUnlove(db, args('rebind-link'))).toEqual({
        status: 'refused',
        reason: 'identity_collision',
      });
      expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE link_id='rebind-link'")).toEqual({ n: 1 });
    });
  });

  it('uses accepted snapshot/import reuse correspondence, independent of rkey reuse, operation GC, and mutable source rows', async () => {
    for (const path of ['snapshot', 'import'] as const) {
      for (const mode of ['active', 'disabled', 'revoked'] as const) {
        for (const reverse of [false, true]) {
          await withMigratedDb((db) => {
            addLink(db, 'original-import-recipient', 'lastfm', mode);
            addLink(db, 'broad-target', 'listenbrainz', 'active');
            addApiFact(db, 'lastfm', 'lastfm', path, 'different-api-request-rkey');
            db.run(
              `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
             VALUES(?,?,?,?,'lastfm','consumed',1)`,
              DID,
              'mutable-import-bridge',
              URI,
              INCARNATION,
            );
            db.run('DELETE FROM operations WHERE id=?', 'original-love-put');
            db.run("UPDATE love_incarnations SET path='api',source_service='listenbrainz' WHERE uri=?", URI);
            db.run("UPDATE love_import_bridges SET source_service='listenbrainz' WHERE uri=?", URI);
            const broad = () =>
              enqueueForwards(db, {
                did: DID,
                items: [
                  {
                    kind: 'unlove',
                    operationId: BROAD,
                    payload: { artist: 'Artist', track: 'Track', origin: 'lastfm' },
                    authorization: { uri: URI, rev: REV },
                  },
                ],
                excludeSourceServices: ['lastfm'],
                now: NOW,
                random: seededRandom(20),
              });
            const recipient = () =>
              measuredRecipient(
                db,
                args('original-import-recipient', 'lastfm', [], {
                  apiRequestRkey: 'different-api-request-rkey',
                  source: 'lastfm',
                }),
              );
            let ack: ApiRecipientUnloveAck | undefined;
            if (reverse) ack = recipient().ack;
            broad();
            if (!reverse) ack = recipient().ack;
            expect(ack).toEqual({ status: mode === 'active' ? 'queued' : 'deferred' });

            expect(
              db.all<{ operation_id: string }>(
                'SELECT operation_id FROM forward_deferred_love_witnesses WHERE link_id=? ORDER BY operation_id',
                'original-import-recipient',
              ),
            ).toEqual([{ operation_id: NARROW }]);
            expect(
              db.all<{ link_id: string; operation_id: string }>(
                'SELECT link_id,operation_id FROM forward_deferred_love_witnesses WHERE operation_id=?',
                BROAD,
              ),
            ).toEqual([{ link_id: 'broad-target', operation_id: BROAD }]);
          });
        }
      }
    }
  });

  it.each(['scrobble', 'nowplaying'] as const)(
    'rejects exact %s identity collisions with bounded kind seeks',
    async (kind) => {
      await withMigratedDb((db) => {
        addLink(db, `wrong-kind-${kind}`, 'listenbrainz', 'active');
        addApiFact(db);
        db.run(
          `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,'{}','queued',0,?,?,?)`,
          `wrong-kind-row-${kind}`,
          `wrong-kind-${kind}`,
          1,
          DID,
          kind,
          NARROW,
          NOW,
          NOW,
          NOW,
        );
        expect(enqueueApiRecipientUnlove(db, args(`wrong-kind-${kind}`))).toEqual({
          status: 'refused',
          reason: 'identity_collision',
        });
        expect(db.one('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual({ n: 0 });
      });
    },
  );

  it('filters a source-excluded broad witness before the separately scoped recipient in both orders', async () => {
    for (const reverse of [false, true]) {
      await withMigratedDb((db) => {
        addLink(db, 'source-lastfm', 'lastfm', 'active');
        addLink(db, 'recipient-lb', 'listenbrainz', 'active');
        addApiFact(db, 'web', 'lastfm');
        const broadItem = {
          kind: 'unlove' as const,
          operationId: BROAD,
          payload: { artist: 'Artist', track: 'Track', origin: 'web' },
          authorization: { uri: URI, rev: REV },
        };
        const recipient = () => measuredRecipient(db, args('recipient-lb', 'web', ['lastfm']));
        const broad = () =>
          enqueueForwards(db, {
            did: DID,
            items: [broadItem],
            excludeSourceServices: ['lastfm'],
            now: NOW,
            random: seededRandom(33),
          });
        if (reverse) recipient();
        broad();
        if (!reverse) recipient();
        expect(
          db.all<{ link_id: string; operation_id: string }>(
            'SELECT link_id,operation_id FROM forward_deferred_love_witnesses ORDER BY link_id,operation_id',
          ),
        ).toEqual([
          { link_id: 'recipient-lb', operation_id: BROAD },
          { link_id: 'recipient-lb', operation_id: NARROW },
        ]);
        expect(
          db.one("SELECT count(*) AS n FROM forward_deferred_love_witnesses WHERE link_id='source-lastfm'"),
        ).toEqual({ n: 0 });
      });
    }
  });
});
