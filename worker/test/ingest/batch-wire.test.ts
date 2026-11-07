import { MAX_JETSTREAM_MESSAGE_BYTES } from '@atmusic/atproto/jetstream/events';
import { measureScrobbleBatch, scrobbleBatchSizer } from '@atmusic/atproto/scrobble-batch-size';
import { packScrobbleBatchEntries } from '@atmusic/core/scrobble-batch';
import { expect, it } from 'vitest';
import { onMessage } from '../../src/do/ingest/jetstream';
import { drain } from '../../src/do/ingest/verify-drain';
import { seedUser } from '../write/support';
import { depsFor, kit } from './drain-support';
import { withIngestIndex } from './node-index';

it('full external batch create and update queue hints and verify without snapshots or local writes', async () => {
  const k = await kit();
  const collection = 'com.example.atmusic.scrobbleBatch';
  const rkey = '3lb2222222222';
  const did = k.users.Alice.did;
  const envelope = { $type: collection, createdAt: new Date(k.clock.nowMs()).toISOString() };
  const request = { repo: did, collection, rkey };
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  const entries = Array.from({ length: 9000 }, (_, i) => ({
    id: `3${i
      .toString(32)
      .padStart(12, '0')
      .split('')
      .map((c) => alphabet[Number.parseInt(c, 32)])
      .join('')}`,
    artist: 'a',
    track: 'b',
    createdAt: envelope.createdAt,
    listenedAt: new Date(k.clock.nowMs() - 86400000 - i * 60000).toISOString(),
  }));
  const packed = packScrobbleBatchEntries(entries, {
    sizer: scrobbleBatchSizer(envelope, request),
    measure: (listens) => measureScrobbleBatch({ ...envelope, listens: [...listens] }, request),
  });
  const record = { ...envelope, listens: packed[0]!.entries };
  expect(record.listens.length).toBeGreaterThan(1000);
  await withIngestIndex(async ({ db }) => {
    seedUser(db, did);
    const m = depsFor(db, k);
    for (const [i, operation] of ['create', 'update'].entries()) {
      if (i) record.listens[0]!.track = 'c';
      const commit = await k.externalPut('Alice', collection, rkey, record);
      // Deliberately lie in the wire record: only the signed proof may supply fields.
      const wireRecord = {
        ...record,
        listens: [{ ...record.listens[0]!, track: 'forged' }, ...record.listens.slice(1)],
      };
      const event = {
        did,
        time_us: k.clock.nowMs() * 1000,
        seq: 100 + i,
        kind: 'commit',
        commit: { operation, collection, rkey, rev: commit.rev, cid: commit.ops[0]!.cid, record: wireRecord },
      };
      const text = JSON.stringify(event);
      expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
      expect(Buffer.byteLength(text)).toBeLessThan(MAX_JETSTREAM_MESSAGE_BYTES);
      expect(onMessage(m, text, k.clock.nowMs()).kind).toBe('hint');
      expect(db.all('SELECT * FROM hints')).toHaveLength(1);
      expect(db.all('SELECT * FROM repo_jobs')).toHaveLength(0);
      expect(db.all("SELECT * FROM scrobbles WHERE track = 'c'")).toHaveLength(0);
      await drain(m, k.clock.nowMs());
      expect(db.all('SELECT * FROM hints')).toHaveLength(0);
      expect(db.all('SELECT * FROM scrobbles')).toHaveLength(record.listens.length);
      expect(db.all("SELECT * FROM scrobbles WHERE track = 'forged'")).toHaveLength(0);
      expect(db.all("SELECT * FROM scrobbles WHERE track = 'c'")).toHaveLength(i);
      expect(db.all('SELECT * FROM repo_jobs')).toHaveLength(0);
      const checkpoint = db.all('SELECT * FROM ingest_checkpoint');
      for (const bad of [
        text.slice(0, -1),
        JSON.stringify({ ...event, pad: 'x'.repeat(MAX_JETSTREAM_MESSAGE_BYTES) }),
      ]) {
        expect(onMessage(m, bad, k.clock.nowMs()).kind).toBe('invalid');
        expect(db.all('SELECT * FROM hints')).toHaveLength(0);
        expect(db.all('SELECT * FROM ingest_checkpoint')).toEqual(checkpoint);
        expect(db.all('SELECT * FROM repo_jobs')).toHaveLength(0);
      }
    }
  });
}, 30000);
