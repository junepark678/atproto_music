import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { disconnectLocalData } from '../../../src/do/write/suppression';
import { acceptListens } from '../../../src/outbox/ingress';
import { cancelUnsent } from '../../../src/outbox/operations';
import { listenInput, SCROBBLE, T0, withHarness } from './support';

it('releases an API listen admission with an explicitly unsent cancellation, so reaccept forwards once', async () => {
  await withHarness(async (h) => {
    h.account(h.alice);
    h.link(h.alice, 'lastfm');
    const args = {
      did: h.alice,
      origin: 'web' as const,
      listens: [{ input: listenInput(0) }],
      receiptMs: T0,
    };
    const first = await acceptListens(h.m, args);
    expect(first.created).toBe(1);
    const firstResult = first.results[0]!;
    if (firstResult.status !== 'accepted') throw new Error('fixture listen was not accepted');
    const key = firstResult.listenKey;
    const opId = firstResult.operationId;
    if (opId === null) throw new Error('accepted listen has no operation');
    expect(h.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 1 });

    expect(cancelUnsent(h.db, opId, T0)).toBe(true);
    expect(h.db.one('SELECT 1 AS hit FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, key)).toBeNull();
    expect(h.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 0 });

    const again = await acceptListens(h.m, args);
    expect(again.created).toBe(1);
    expect(h.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 1 });
  });
});

it('keeps a listen admission when cancellation is backed by an indexed tombstone', async () => {
  await withHarness(async (h) => {
    h.account(h.alice);
    const accepted = await acceptListens(h.m, {
      did: h.alice,
      origin: 'web',
      listens: [{ input: listenInput(1) }],
      receiptMs: T0,
    });
    const result = accepted.results[0]!;
    if (result.status !== 'accepted') throw new Error('fixture listen was not accepted');
    const op = h.op(result.operationId!);
    h.db.run("UPDATE forward_admissions SET path='live' WHERE did=? AND identity_key=?", h.alice, result.listenKey);
    h.db.run(
      `INSERT INTO record_state(uri,did,collection,revision,cid,state,reason,verified_at)
       VALUES (?, ?, ?, '3', NULL, 'absent', NULL, '2026-01-15T12:00:00.000000000Z')`,
      `at://${h.alice}/${SCROBBLE}/${op.rkey}`,
      h.alice,
      SCROBBLE,
    );

    expect(cancelUnsent(h.db, op.id, T0)).toBe(true);
    expect(
      h.db.one('SELECT path FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, result.listenKey),
    ).toEqual({
      path: 'live',
    });
  });
});

it('suppression clears index-only forwarding state but retains markers backed by API acceptance', async () => {
  await withHarness(async (h) => {
    h.account(h.alice);
    const accepted = await acceptListens(h.m, {
      did: h.alice,
      origin: 'web',
      listens: [{ input: listenInput(2) }],
      receiptMs: T0,
    });
    const acceptedResult = accepted.results[0]!;
    if (acceptedResult.status !== 'accepted') throw new Error('fixture listen was not accepted');
    const acceptedKey = acceptedResult.listenKey;
    const liveKey = 'external-live-listen-marker';
    const loveUri = `at://${h.alice}/com.example.atmusic.love/3kcleanup001`;
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms)
       VALUES (?,?,'live',NULL,?)`,
      h.alice,
      liveKey,
      T0,
    );
    h.db.run(
      `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms)
       VALUES (?,?,'live',NULL,?)`,
      h.alice,
      `love:${loveUri}:3`,
      T0,
    );
    h.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES (?,?,'present','live',NULL,?)`,
      loveUri,
      `love:${loveUri}:3`,
      T0,
    );
    h.db.run(
      `INSERT INTO love_delete_bridges(did,uri,incarnation_key,expected_cid,operation_id,state,created_at_ms)
       VALUES (?,?,?,'bafyreitest','removed-api-op','pending',?)`,
      h.alice,
      loveUri,
      `love:${loveUri}:3`,
      T0,
    );

    disconnectLocalData(h.db, h.alice, {
      settingsUri: `at://${h.alice}/com.example.atmusic.settings/self`,
      settingsRev: '4',
      nowNs: fromMs(T0),
    });

    expect(
      h.db.one('SELECT 1 AS hit FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, acceptedKey),
    ).toEqual({
      hit: 1,
    });
    expect(
      h.db.one('SELECT 1 AS hit FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, liveKey),
    ).toBeNull();
    expect(
      h.db.one('SELECT 1 AS hit FROM forward_admissions WHERE did=? AND identity_key=?', h.alice, `love:${loveUri}:3`),
    ).toBeNull();
    expect(h.db.one('SELECT 1 AS hit FROM love_incarnations WHERE uri=?', loveUri)).toBeNull();
    expect(h.db.one('SELECT 1 AS hit FROM love_delete_bridges WHERE uri=?', loveUri)).toBeNull();
  });
});
