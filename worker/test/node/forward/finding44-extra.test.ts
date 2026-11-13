// biome-ignore-all lint/suspicious/noExplicitAny: external proof fixtures model injected production dependencies
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { hasCanonicalListenSurvivor } from '../../../src/forward/delete-enqueue';
import { projectionListenKey } from '../../../src/forward/projection';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { ALICE, deleteProof, NOW_MS, OPTS, putProof, repoFor, SCROBBLE, scrobble, seedUser } from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = { ...OPTS, forwarding: { random: seededRandom(619) } };
function seedLink(db: Db) {
  seedUser(db, ALICE);
  ensureAccount({ db, clock: { nowMs: () => NOW_MS } } as any, { did: ALICE, verifiedHandle: null });
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

import { ensureAccount } from '../../../src/credentials/accounts';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';

const BATCH = `${SCROBBLE}Batch`;
const uri = (key: string, batch = false) => `at://${ALICE}/${batch ? BATCH : SCROBBLE}/${key}`;
const batchRecord = (ids = ['2222222222222'], track = record.track) => {
  const { $type, ...entry } = record;
  return { $type: BATCH, createdAt: record.createdAt, listens: ids.map((id) => ({ ...entry, id, track })) };
};
const opRandom = seededRandom(123);
const moduleOf = (db: Db) =>
  ({ db, config: { prefix: 'com.example.atmusic' }, clock: { nowMs: () => NOW_MS }, random: opRandom }) as any;
const apiSingle = (db: Db, key: string) =>
  enqueueScrobbleDelete(moduleOf(db), { did: ALICE, uri: uri(key), origin: 'web' });
async function drain(db: Db) {
  let now = NOW_MS,
    deletes = 0,
    lookups = 0;
  const clock = { nowMs: () => now };
  const deps: any = {
    db,
    clock,
    random: seededRandom(9),
    box: { openText: () => 'fixture' },
    pacing: new UpstreamPacing(clock as any),
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
        return { ok: true, rate: { remaining: 100, resetInS: 0 } };
      },
    },
  };
  for (let i = 0; i < 12; i++) {
    await runDeleteSlice(deps);
    now += 1000;
  }
  return { deletes, lookups };
}

it('batch same-CID recreation survives historical live deletion', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, BATCH, 'a', batchRecord());
  const gone = await deleteProof(repo, BATCH, 'a');
  const again = await putProof(repo, BATCH, 'a', batchRecord());
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    delivered(db);
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(db.tx(() => applyRecordProof(db, again, OPTS)).outcome).toBe('applied');
    expect(await drain(db)).toEqual({ deletes: 0, lookups: 0 });
  });
});
it('legacy live tombstone does not hide recreated single', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const again = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    delivered(db);
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    db.run('UPDATE linked_pull_tombstones SET identity_key=?', `live:${uri('a')}`);
    expect(db.tx(() => applyRecordProof(db, again, OPTS)).outcome).toBe('applied');
    expect(await drain(db)).toEqual({ deletes: 0, lookups: 0 });
  });
});
it('legacy API tombstone remains removal intent while final copy disappears', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, SCROBBLE, 'b', { ...record, album: 'B' });
  const gone = await deleteProof(repo, SCROBBLE, 'b');
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(db.tx(() => applyRecordProof(db, b, OPTS)).outcome).toBe('applied');
    delivered(db);
    apiSingle(db, 'a');
    db.run('UPDATE linked_pull_tombstones SET identity_key=?', `uri:${uri('a')}`);
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('same-CID later proof while API removal pending preserves intent', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  await putProof(repo, SCROBBLE, 'b', { ...record, track: 'Else' });
  const again = await putProof(repo, SCROBBLE, 'a', record);
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    delivered(db);
    apiSingle(db, 'a');
    expect(db.tx(() => applyRecordProof(db, again, OPTS)).outcome).toBe('applied');
    expect(hasCanonicalListenSurvivor(db, deletion)).toBe(false);
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('invalid later record does not clear historical removal intent', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const invalid = await putProof(repo, SCROBBLE, 'a', { ...record, track: 42 });
  await withMigratedDb((db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(db.all('SELECT * FROM linked_pull_tombstones')).toHaveLength(1);
    expect(db.tx(() => applyRecordProof(db, invalid, live)).outcome).toBe('excluded');
    expect(db.all('SELECT * FROM linked_pull_tombstones')).toHaveLength(1);
  });
});
it.each([false, true])('replacement with survivor and final removal: batch=%s', async (batch) => {
  const repo = await repoFor('alice');
  const col = batch ? BATCH : SCROBBLE;
  const a = await putProof(repo, col, 'a', batch ? batchRecord() : record);
  const b = await putProof(repo, SCROBBLE, 'b', { ...record, album: 'B' });
  const replaced = await putProof(
    repo,
    col,
    'a',
    batch ? batchRecord(['2222222222222'], 'Other') : { ...record, track: 'Other' },
  );
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(db.tx(() => applyRecordProof(db, b, OPTS)).outcome).toBe('applied');
    delivered(db);
    expect(db.tx(() => applyRecordProof(db, replaced, live)).outcome).toBe('applied');
    expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(0);
    apiSingle(db, 'b');
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it('batch replacement excludes outstanding API removal', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, BATCH, 'b', batchRecord());
  const c = await putProof(repo, BATCH, 'b', batchRecord(['2222222222222'], 'Other'));
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(db.tx(() => applyRecordProof(db, b, OPTS)).outcome).toBe('applied');
    delivered(db);
    apiSingle(db, 'a');
    expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(0);
    expect(db.tx(() => applyRecordProof(db, c, live)).outcome).toBe('applied');
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});

import { runForward } from '../../../src/forward/forwarder';

it('genuine forward in new generation then repository deletion remains eligible', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const again = await putProof(repo, SCROBBLE, 'a', record);
  const goneAgain = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb(async (db) => {
    seedLink(db);
    let submits = 0;
    const clock = { nowMs: () => NOW_MS };
    const forward = async () => {
      expect(
        enqueueForwards(db, {
          did: ALICE,
          items: [{ kind: 'scrobble', listenKey: identity, payload: { listen: record } }],
          now: NOW_MS,
          random: seededRandom(777 + submits),
        }),
      ).toBe(1);
      await runForward({
        db,
        clock,
        random: seededRandom(44),
        log: { log: () => {} },
        box: { openText: () => 'fixture' },
        pacing: new UpstreamPacing(clock as any),
        lastfm: null,
        listenbrainz: {
          submit: async () => {
            submits++;
            return { ok: true, value: null, rate: { remaining: 100, resetInS: 0 } };
          },
        },
      } as any);
      expect(db.one<any>('SELECT state FROM forward_outbox ORDER BY rowid DESC')!.state).toBe('sent');
    };
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    await forward();
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(await drain(db)).toMatchObject({ deletes: 1 });
    db.run('UPDATE linked_accounts SET generation=generation+1');
    expect(db.tx(() => applyRecordProof(db, again, OPTS)).outcome).toBe('applied');
    await forward();
    expect(submits).toBe(2);
    expect(db.tx(() => applyRecordProof(db, goneAgain, live)).outcome).toBe('absent');
    expect(await drain(db)).toMatchObject({ deletes: 1 });
  });
});
it.each(['000000001', '999999999'])('nanosecond boundary %s remains within exact second', async (fraction) => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', { ...record, listenedAt: `2026-01-15T11:00:00.${fraction}Z` });
  await withMigratedDb((db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(hasCanonicalListenSurvivor(db, deletion)).toBe(true);
    expect(hasCanonicalListenSurvivor(db, { ...deletion, listenedAt: second + 1 })).toBe(false);
    expect(hasCanonicalListenSurvivor(db, { ...deletion, listenedAt: second - 1 })).toBe(false);
  });
});
it('different-identity recreation preserves deleted old identity history', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  const other = await putProof(repo, SCROBBLE, 'a', { ...record, track: 'Other' });
  await withMigratedDb((db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(db.tx(() => applyRecordProof(db, other, live)).outcome).toBe('applied');
    expect(
      db.all('SELECT * FROM linked_pull_tombstones WHERE artist_key=? AND track_key=?', artistKey, musicTrackKey),
    ).toHaveLength(1);
  });
});
it('both event rows resolve before one dispatch retires siblings', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const b = await putProof(repo, SCROBBLE, 'a', { ...record, album: 'New bytes' });
  await withMigratedDb(async (db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    delivered(db);
    apiSingle(db, 'a');
    expect(db.tx(() => applyRecordProof(db, b, OPTS)).outcome).toBe('applied');
    apiSingle(db, 'a');
    expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(2);
    expect(await drain(db)).toEqual({ deletes: 1, lookups: 2 });
  });
});
it('stale present proof cannot clear live removal intent', async () => {
  const repo = await repoFor('alice');
  const a = await putProof(repo, SCROBBLE, 'a', record);
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb((db) => {
    seedLink(db);
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('applied');
    expect(db.tx(() => applyRecordProof(db, gone, live)).outcome).toBe('absent');
    expect(db.tx(() => applyRecordProof(db, a, OPTS)).outcome).toBe('stale_head');
    expect(db.all('SELECT * FROM linked_pull_tombstones')).toHaveLength(1);
  });
});
