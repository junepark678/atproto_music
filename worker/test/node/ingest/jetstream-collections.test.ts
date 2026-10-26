// N3-11 (ADR 0005 §6.3, B12): the Jetstream subscription on Node asks for
// exactly the four configured collections, love included, in the fixed order
// scrobble, follow, settings, love. The production socket `connect` builds
// the URL from config.collections (parseConfig) and hands it to an injected
// connector; the connector here records the URL and plays scripted frames,
// so nothing reaches a network. The same URL passes the Node ws connector's
// allow-list mapping unchanged apart from the https→wss scheme.

import type { IdentityResolver } from '@atmusic/atproto/identity/types';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import type { ModuleDeps } from '../../../src/do/contracts';
import { configuredCollections } from '../../../src/do/ingest/jetstream';
import {
  closeSocket,
  connect,
  type JetstreamLink,
  type LinkEvent,
  subscribeUrl,
} from '../../../src/do/ingest/jetstream-socket';
import { jetstreamWsTarget } from '../../../src/node/jetstream-ws';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { withMigratedDb } from '../support/node-db';

const P = 'com.example.atmusic';
const FOUR = [`${P}.scrobble`, `${P}.follow`, `${P}.settings`, `${P}.love`];
const HOST = 'jetstream.example.test';
const SUBSCRIBE_PATH = '/xrpc/network.bsky.jetstream.subscribeEvents';
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const REV = '3lbcdefghijkl';
const CID = 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const T0_US = Date.parse('2026-01-15T12:00:00Z') * 1000;

function deps(db: SqliteDb, prefix = P): ModuleDeps {
  const config = parseConfig(
    {
      PUBLIC_ORIGIN: 'https://music.example.test',
      LEXICON_PREFIX: prefix,
      NAMESPACE_OWNERSHIP_REF: '',
      INGEST_MODE: 'socket',
      JETSTREAM_URLS: `wss://${HOST}`,
      JETSTREAM_LOOKBACK_HOURS: '24',
      RELAY_URL: 'https://relay.example.test',
      PLAN: 'paid',
      DO_LOCATION_HINT: '',
      ADMIN_TOKEN: '',
    },
    { allowFixturePrefix: true },
  );
  const never = (what: string) => () => Promise.reject(new Error(`the subscription test never calls ${what}`));
  const identity: IdentityResolver = { resolveDid: never('resolveDid'), resolveHandle: never('resolveHandle') };
  return {
    db,
    clock: fixedClock(),
    // Zero jitter: reconnect delays are deterministic.
    random: { float: () => 0, bytes: (n: number) => new Uint8Array(n) },
    transport: never('transport'),
    identity,
    config,
    log: { log: () => undefined },
  };
}

/** A connector that records every URL and returns a link whose frames the test pushes. */
function scriptedConnector() {
  const urls: string[] = [];
  let emit: ((e: LinkEvent) => void) | null = null;
  const connector = async (url: string): Promise<JetstreamLink> => {
    urls.push(url);
    return {
      url,
      start(onEvent) {
        emit = onEvent;
      },
      close() {
        emit = null;
      },
    };
  };
  const push = (frame: unknown) => {
    if (emit === null) throw new Error('link not started');
    emit({ type: 'message', data: JSON.stringify(frame) });
  };
  return { connector, urls, push };
}

const commitFrame = (collection: string, rkey: string, seq: number) => ({
  did: ALICE,
  time_us: T0_US + seq,
  seq,
  kind: 'commit',
  commit: { rev: REV, operation: 'create', collection, rkey, cid: CID },
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('jetstream collections', () => {
  it('the Jetstream URL requests the four wantedCollections in a fixed order', async () => {
    await withMigratedDb(async (db) => {
      const m = deps(db);
      expect(configuredCollections(m)).toEqual(FOUR);

      const js = scriptedConnector();
      const opened = await connect(m, js.connector, m.clock.nowMs());
      expect(opened).toMatchObject({ ok: true, hostIndex: 0, gap: 'no_cursor' });
      // One connect, one URL: kinds=commit and the four collections, in order, nothing else.
      expect(js.urls).toHaveLength(1);
      const url = new URL(js.urls[0] as string);
      expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(`https://${HOST}${SUBSCRIBE_PATH}`);
      expect([...url.searchParams.keys()]).toEqual([
        'kinds',
        'collections',
        'collections',
        'collections',
        'collections',
      ]);
      expect(url.searchParams.getAll('kinds')).toEqual(['commit']);
      expect(url.searchParams.getAll('collections')).toEqual(FOUR);

      // The Node ws connector dials exactly that URL (wss://, same query).
      const target = jetstreamWsTarget(js.urls[0] as string, m.config.jetstreamUrls);
      expect(target.ok).toBe(true);
      if (target.ok) {
        expect(target.url.protocol).toBe('wss:');
        expect(target.url.searchParams.getAll('collections')).toEqual(FOUR);
      }

      // Frames of the subscribed love collection become hints; an unsubscribed one does not.
      js.push(commitFrame('app.bsky.feed.like', 'x1', 1));
      js.push(commitFrame(`${P}.love`, '3lovelovelov2', 2));
      await settle();
      const hints = db.all<{ uri: string; collection: string; source: string }>(
        'SELECT uri, collection, source FROM hints ORDER BY uri',
      );
      expect(hints).toEqual([
        { uri: `at://${ALICE}/${P}.love/3lovelovelov2`, collection: `${P}.love`, source: 'jetstream' },
      ]);
      expect(db.one<{ cursor: number }>("SELECT cursor FROM ingest_checkpoint WHERE stream = 'jetstream'")).toEqual({
        cursor: 2,
      });

      // A resumed connect keeps the same four collections and adds only the cursor.
      closeSocket(m, m.clock.nowMs());
      const again = await connect(m, js.connector, m.clock.nowMs());
      expect(again).toMatchObject({ ok: true, gap: null });
      expect(js.urls).toHaveLength(2);
      const resumed = new URL(js.urls[1] as string);
      expect([...new Set(resumed.searchParams.keys())]).toEqual(['kinds', 'collections', 'cursor']);
      expect(resumed.searchParams.getAll('collections')).toEqual(FOUR);
      expect(resumed.searchParams.get('cursor')).toBe('2');
      closeSocket(m, m.clock.nowMs());

      // Another valid prefix derives its own four, in the same order.
      const other = new URL(subscribeUrl(deps(db, 'org.example.other'), 0, null));
      expect(other.searchParams.getAll('collections')).toEqual([
        'org.example.other.scrobble',
        'org.example.other.follow',
        'org.example.other.settings',
        'org.example.other.love',
      ]);
    });
  });
});
