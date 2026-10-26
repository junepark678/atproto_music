// N3-04: the reserved Audioscrobbler 1.2 path (ADR 0005 §7.10, §18 Q9).
//
// The real Node composition with the 1.2 routes mounted. A handshake, at
// /audioscrobbler/ or at the root, answers the FAILED line as 200 text/plain;
// 1.2 submissions get the same line. "Stores nothing" is checked over the
// whole database: the row count of every table before and after.

import { afterEach, describe, expect, it } from 'vitest';
import { AS12_FAILED_BODY, routes as as12Routes } from '../../../src/lastfm/as12';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { closeApps, DEFAULT_DIST, startApp } from '../support/app';

const LINE = 'FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or ListenBrainz API';
const HANDSHAKE = 'hs=true&p=1.2.1&c=tst&v=1.0&u=alice&t=1768478400&a=0123456789abcdef0123456789abcdef';

/** table name → row count, for every table of the database. */
function rowCounts(db: SqliteDb): Record<string, number> {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.one<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`)!.n]),
  );
}

afterEach(async () => {
  await closeApps();
});

describe('Audioscrobbler 1.2', () => {
  it("GET /audioscrobbler/?hs=true&p=1.2.1 answers 200 text/plain 'FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or ListenBrainz API' and stores nothing", async () => {
    const app = await startApp({ routes: as12Routes });
    expect(AS12_FAILED_BODY).toBe(`${LINE}\n`);
    const before = rowCounts(app.db);

    const res = await app.fetch(`/audioscrobbler/?${HANDSHAKE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe(`${LINE}\n`);

    // A 1.2 submission and a now-playing notification get the same line.
    for (const path of ['/audioscrobbler/', '/audioscrobbler/submit', '/audioscrobbler/nowplaying']) {
      const post = await app.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 's=0123456789abcdef&a[0]=Artist&t[0]=Track&i[0]=1768478400&o[0]=P&l[0]=200',
      });
      expect([post.status, await post.text()], path).toEqual([200, `${LINE}\n`]);
    }
    // HEAD answers the GET route's status and headers without a body.
    const head = await app.fetch(`/audioscrobbler/?${HANDSHAKE}`, { method: 'HEAD' });
    expect([head.status, head.headers.get('content-type'), await head.text()]).toEqual([
      200,
      'text/plain; charset=utf-8',
      '',
    ]);

    expect(rowCounts(app.db)).toEqual(before);
    // The request log names the route, never the query (the 1.2 token travels there).
    const requests = app.log.logs.filter((l) => l.event === 'request');
    expect(requests.map((l) => [l.method, l.route, l.status])).toEqual([
      ['GET', '/audioscrobbler/', 200],
      ['POST', '/audioscrobbler/', 200],
      ['POST', '/audioscrobbler/{path}', 200],
      ['POST', '/audioscrobbler/{path}', 200],
      ['HEAD', '/audioscrobbler/', 200],
    ]);
    expect(app.log.lines.join('\n')).not.toContain('0123456789abcdef');
  });

  it('GET /?hs=true&p=1.2.1 at the root answers the same FAILED line', async () => {
    const app = await startApp({ routes: as12Routes });
    const before = rowCounts(app.db);
    const res = await app.fetch(`/?${HANDSHAKE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe(`${LINE}\n`);
    expect(rowCounts(app.db)).toEqual(before);

    // Without hs=true the root is the SPA, not the 1.2 answer.
    for (const path of ['/', '/?hs=false', '/?p=1.2.1']) {
      const root = await app.fetch(path);
      expect([root.status, await root.text()], path).toEqual([200, DEFAULT_DIST['index.html']]);
    }
  });
});
