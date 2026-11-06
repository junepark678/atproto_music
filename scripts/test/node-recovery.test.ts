// Actual subprocess SIGKILL evidence over the built, guarded Node test host.
// The PDS/AS/PLC/DoH live in the parent and survive each product-process death.
// No external network or production address. This is not a browser/live run.
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import type { JetstreamEvent } from '@atmusic/atproto/test-support/fake-jetstream';
import { FakeOAuthAs } from '@atmusic/atproto/test-support/fake-oauth-as';
import { FakePds, fixtureToken } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { type CommitResult, SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testEnv, testSecretsDocument } from '../../worker/test/node/support/app';
import { main as build } from '../build-server';
import { runGuard as guard } from '../check-node-bundle';

const ALICE = 'did:plc:alicealicealicealicealic';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const BOB_PDS_HOST = 'pds-bob.example.test';
const PREFIX = 'org.example.music';
const SCROBBLE = `${PREFIX}.scrobble`;
const FOLLOW = `${PREFIX}.follow`;
const ORIGIN = 'https://music.example.test';
const ROOT = mkdtempSync(join(tmpdir(), 'atmusic-packaged-recovery-'));
const DIST = process.env.ATMUSIC_RECOVERY_DIST ?? join(ROOT, 'bundle');
const NOW = Date.now();
const clock = fixedClock(new Date(NOW).toISOString());
const logs: string[] = [];
beforeAll(async () => {
  const io = { out: (s: string) => logs.push(s), err: (s: string) => logs.push(s) };
  if (!process.env.ATMUSIC_RECOVERY_DIST) {
    expect(await build(['--check', '--outdir', DIST], io), logs.join('\n')).toBe(0);
  }
  expect(guard({ dist: DIST }, io), logs.join('\n')).toBe(0);
}, 120_000);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
interface Wire {
  type: string;
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
  status: number;
  authority: string;
  result: unknown;
  error?: string;
}

async function world() {
  const dir = mkdtempSync(join(ROOT, 'state-'));
  const assets = join(dir, 'web');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>fixture</title>');
  const secrets = join(dir, 'secrets.json');
  writeFileSync(secrets, JSON.stringify(testSecretsDocument()));
  chmodSync(secrets, 0o600);
  const as = new FakeOAuthAs({ clock });
  const pds = new FakePds('pds.example.test', { clock, authorizationServer: as });
  const bobPds = new FakePds(BOB_PDS_HOST, { clock });
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const keys = await fixtureKeys();
  const repo = new SignedRepo(ALICE, keys.alice, { clock });
  await pds.addAccount(repo, { handle: 'alice.test', auth: 'dpop' });
  plc.register(ALICE, { signingKey: keys.alice, pds: pds.origin, handle: 'alice.test' });
  doh.setTxt('_atproto.alice.test', [`did=${ALICE}`]);
  as.addAccount(ALICE, { handle: 'alice.test' });
  const bobRepo = new SignedRepo(BOB, keys.bob, { clock });
  await bobPds.addAccount(bobRepo, { handle: 'bob.test' });
  plc.register(BOB, { signingKey: keys.bob, pds: bobPds.origin, handle: 'bob.test' });
  doh.setTxt('_atproto.bob.test', [`did=${BOB}`]);
  let authority = '';
  let proc: ChildProcess;
  let output = '';
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  let requestId = 0;
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  const commits: CommitResult[] = [];
  const jetstreamCommits: CommitResult[] = [];
  pds.onCommit((_did, commit) => commits.push(commit));
  bobPds.onCommit((_did, commit) => commits.push(commit));
  const router = routerTransport({
    pds: [pds, bobPds],
    plc,
    doh,
    hosts: {
      [as.host]: as.fetch,
      'music.example.test': (request: Request) => {
        const url = new URL(request.url);
        return fetch(`http://${authority}${url.pathname}${url.search}`);
      },
    },
  });
  as.connect(router);
  const externalPdsWrite = async (
    method: 'createRecord' | 'putRecord' | 'deleteRecord',
    fields: Record<string, unknown>,
  ) => {
    const response = await router(
      new Request(`${bobPds.origin}/xrpc/com.atproto.repo.${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fixtureToken(BOB)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: BOB, collection: SCROBBLE, ...fields }),
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  };
  const externalCreateRecord = async (rkey: string, record: unknown) => {
    const result = await externalPdsWrite('createRecord', { rkey, record });
    return { status: result.status, body: result.body as { uri: string; cid: string } };
  };
  const externalPutRecord = async (rkey: string, record: unknown, swapRecord: string) => {
    const result = await externalPdsWrite('putRecord', { rkey, record, swapRecord });
    return { status: result.status, body: result.body as { uri: string; cid: string } };
  };
  const externalDeleteRecord = async (rkey: string, swapRecord: string) => {
    const result = await externalPdsWrite('deleteRecord', { rkey, swapRecord });
    return {
      status: result.status,
      body: result.body as { commit: { cid: string; rev: string } },
    };
  };
  const rotateBobSigningKey = async () => {
    await bobPds.rotateKey(BOB, keys.bobRotated);
    plc.rotateKey(BOB, keys.bobRotated);
  };
  let paused: {
    nsid: string;
    host?: string;
    method?: string;
    query?: Record<string, string>;
    reached: (request: Wire) => void;
  } | null = null;
  const command = <T = unknown>(action: string, extra: Record<string, unknown> = {}): Promise<T> => {
    if (action === 'events' && Array.isArray(extra.commits))
      jetstreamCommits.push(...(extra.commits as CommitResult[]));
    const id = ++requestId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (r) => resolve(r as T), reject });
      proc.send({ type: 'command', id, action, ...extra });
    });
  };
  const start = async () => {
    output = '';
    let ready!: () => void;
    const listening = new Promise<void>((r) => {
      ready = r;
    });
    proc = spawn(process.execPath, [join(DIST, 'e2e.mjs'), '--init'], {
      env: Object.fromEntries(
        Object.entries({
          PATH: process.env.PATH,
          ...testEnv(dir),
          ATMUSIC_ASSETS_DIR: assets,
          ATMUSIC_SECRETS_FILE: secrets,
          ATMUSIC_TEST_NOW_MS: String(clock.nowMs()),
          ATMUSIC_SIGNIN_DIDS: ALICE,
          LEXICON_PREFIX: PREFIX,
          NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org',
          NAMESPACE_PUBLICATION_REF: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          INGEST_MODE: 'socket',
          ATMUSIC_TEST_JETSTREAM_COMMITS: Buffer.from(JSON.stringify(jetstreamCommits)).toString('base64'),
        }).filter((p): p is [string, string] => p[1] !== undefined),
      ),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    proc.stdout?.on('data', (b: Buffer) => {
      output += b.toString();
    });
    proc.stderr?.on('data', (b: Buffer) => {
      output += b.toString();
    });
    proc.on('message', (raw) => {
      const m = raw as Wire;
      if (m.type === 'ready') {
        authority = m.authority;
        ready();
      }
      if (m.type === 'answer') {
        const waiter = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) waiter?.reject(new Error(m.error));
        else waiter?.resolve(m.result);
      }
      if (m.type === 'request') {
        const child = proc;
        void (async () => {
          const response = await router(
            new Request(m.url, {
              method: m.method,
              headers: m.headers,
              ...(m.body === null ? {} : { body: Buffer.from(m.body, 'base64') }),
            }),
          );
          // Real remote commit, then withhold the response from the child:
          // the operation must still be running when SIGKILL arrives.
          const url = new URL(m.url);
          if (
            paused &&
            response.ok &&
            url.pathname === `/xrpc/${paused.nsid}` &&
            (paused.host === undefined || url.hostname === paused.host) &&
            (paused.method === undefined || m.method === paused.method) &&
            Object.entries(paused.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value)
          ) {
            const pause = paused;
            paused = null;
            pause.reached(m);
            return;
          }
          const body = response.body === null ? null : Buffer.from(await response.arrayBuffer()).toString('base64');
          if (child.connected)
            child.send({ type: 'response', id: m.id, status: response.status, headers: [...response.headers], body });
        })().catch((error) => {
          if (child.connected)
            child.send({
              type: 'response',
              id: m.id,
              status: 599,
              headers: [],
              body: Buffer.from(String(error)).toString('base64'),
            });
        });
      }
    });
    exit = new Promise((resolve) =>
      proc.once('exit', (code, signal) => {
        for (const waiter of pending.values()) waiter.reject(new Error(`process exit ${code}/${signal}`));
        pending.clear();
        resolve({ code, signal });
      }),
    );
    await Promise.race([
      listening,
      exit.then((e) => {
        throw new Error(`startup ${JSON.stringify(e)}: ${output}`);
      }),
    ]);
  };
  let signed: { token: string; csrf: string } | undefined;
  const send = async (method: string, path: string, body?: unknown, key?: string) => {
    const response = await fetch(`http://${authority}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(signed ? { cookie: `__Host-atmusic_session=${signed.token}`, 'x-csrf-token': signed.csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookies: response.headers.getSetCookie() };
  };
  const cookie = (cookies: string[], name: string) => {
    const value = cookies
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0]
      ?.slice(name.length + 1);
    if (!value) throw new Error(`missing cookie ${name}`);
    return value;
  };
  const signIn = async () => {
    const start = await send('POST', '/api/v1/auth/start', { handle: 'alice.test' });
    expect(start.status).toBe(200);
    const binding = cookie(start.cookies, '__Host-atmusic_oauth');
    const redirect = await router(new Request(start.body.authorizeUrl));
    const callback = new URL(redirect.headers.get('location')!);
    const response = await fetch(`http://${authority}${callback.pathname}${callback.search}`, {
      redirect: 'manual',
      headers: { cookie: `__Host-atmusic_oauth=${binding}` },
    });
    expect(response.status).toBe(303);
    signed = { token: cookie(response.headers.getSetCookie(), '__Host-atmusic_session'), csrf: '' };
    const session = await send('GET', '/api/v1/auth/session');
    expect(session.status).toBe(200);
    signed.csrf = session.body.csrfToken;
  };
  const inspect = () => command<Snapshot>('inspect');
  const pump = async () => {
    clock.advance(2_500);
    await command('pump', { advance: 2_500 });
  };
  const advance = async (ms: number) => {
    clock.advance(ms);
    await command('pump', { advance: ms });
  };
  const until = async (done: (s: Snapshot) => boolean) => {
    for (let i = 0; i < 40; i++) {
      const snapshot = await inspect();
      if (done(snapshot)) return snapshot;
      await pump();
    }
    throw new Error(`condition did not converge: ${JSON.stringify(await inspect())}\n${output}`);
  };
  return {
    start,
    send,
    signIn,
    advance,
    inspect,
    pump,
    until,
    repo,
    pds,
    as,
    bobRepo,
    bobPds,
    plc,
    rotateBobSigningKey,
    externalCreateRecord,
    externalPutRecord,
    externalDeleteRecord,
    commits,
    command,
    pause(nsid: string, match: { host?: string; method?: string; query?: Record<string, string> } = {}) {
      return new Promise<Wire>((reached) => {
        paused = { nsid, ...match, reached };
      });
    },
    async stop(signal: 'SIGKILL' | 'SIGTERM') {
      proc.kill(signal);
      return exit;
    },
    async close() {
      if (proc?.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await exit;
      }
    },
  };
}

it('oauth_refresh_recovery: rotated refresh credentials and the same app-session cookie survive a child-process restart', async () => {
  const w = await world();
  try {
    await w.start();
    await w.signIn();
    const asSession = w.as.sessions(ALICE)[0];
    if (!asSession) throw new Error('missing fixture OAuth session');
    const initialRefreshToken = asSession.refreshToken;
    expect(asSession.refreshCount).toBe(0);

    const submit = async (track: string, key: string) => {
      const response = await w.send(
        'POST',
        '/api/v1/scrobbles',
        {
          artist: 'Recovery Artist',
          track,
          listenedAt: new Date(NOW - 60_000).toISOString(),
        },
        key,
      );
      expect(response.status).toBe(202);
      const id = response.body.operation.id as string;
      const settled = await w.until(
        (snapshot) => snapshot.operations?.find((row) => row.id === id)?.state === 'succeeded',
      );
      expect(settled.operations?.find((row) => row.id === id)).toMatchObject({ id, state: 'succeeded' });
    };

    // Expire the access token, force one refresh/rotation through an authenticated write,
    // then kill the product process while the fixture AS and PDS remain alive.
    await w.advance(3_660_000);
    await submit('First Rotation', 'refresh-recovery-1');
    const rotatedRefreshToken = w.as.sessions(ALICE)[0]?.refreshToken;
    expect(rotatedRefreshToken).toBeTruthy();
    expect(rotatedRefreshToken).not.toBe(initialRefreshToken);
    expect(w.as.sessions(ALICE)[0]?.refreshCount).toBe(1);
    const tokenRequestsBeforeRestart = w.as.count('/oauth/token');
    const parRequestsBeforeRestart = w.as.count('/oauth/par');
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });

    await w.start();
    // The harness retains the original __Host-atmusic_session cookie and CSRF token;
    // restarting does not perform a new OAuth authorization/code exchange.
    expect(w.as.count('/oauth/token')).toBe(tokenRequestsBeforeRestart);
    expect(w.as.count('/oauth/par')).toBe(parRequestsBeforeRestart);
    expect(w.as.sessions(ALICE)[0]?.refreshCount).toBe(1);

    // The next access-token expiry can only refresh successfully with the rotated token
    // persisted in SQLite. Replaying the pre-restart token would revoke the fake-AS session.
    await w.advance(3_660_000);
    await submit('Second Rotation After Restart', 'refresh-recovery-2');
    const recoveredSession = w.as.sessions(ALICE)[0];
    expect(recoveredSession?.refreshCount).toBe(2);
    expect(recoveredSession?.refreshToken).not.toBe(rotatedRefreshToken);
    expect(w.as.revocations).toEqual([]);
    expect(w.as.count('/oauth/token')).toBeGreaterThan(tokenRequestsBeforeRestart);
    expect(w.as.count('/oauth/par')).toBe(parRequestsBeforeRestart);
    expect(await w.repo.list(SCROBBLE)).toHaveLength(2);
    expect((await w.inspect()).operations?.map((row) => row.state)).toEqual(['succeeded', 'succeeded']);
    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
  } finally {
    await w.close();
  }
}, 120_000);

it('federation_process_recovery: second-PDS create/update/delete survive SIGKILL during proof and converge', async () => {
  const w = await world();
  try {
    await w.start();
    await w.until((s) => s.ingest_checkpoint?.[0]?.connected === 1);
    expect((await w.send('POST', '/api/v1/notify', { did: BOB })).status).toBe(202);
    const bootstrapped = await w.until((s) => {
      const bob = s.users?.find((row) => row.did === BOB);
      const snapshot = s.repo_jobs?.find((row) => row.did === BOB && row.kind === 'snapshot');
      return (
        bob?.active === 1 &&
        bob.indexing_state === 'current' &&
        s.hints?.every((row) => row.did !== BOB) === true &&
        (snapshot === undefined || snapshot.state === 'complete')
      );
    });
    expect(bootstrapped.operations).toEqual([]);
    expect(bootstrapped.scrobbles).toEqual([]);
    expect(await w.repo.list(SCROBBLE)).toEqual([]);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([]);
    expect((await w.send('GET', '/api/v1/feed?scope=global')).body.items).toEqual([]);

    const listenedAt = new Date(NOW - 60_000).toISOString();
    const record = {
      $type: SCROBBLE,
      artist: 'Portishead',
      track: 'Roads',
      album: 'Dummy',
      listenedAt,
      createdAt: listenedAt,
    };
    const rkey = 'remote01';
    const uri = `at://${BOB}/${SCROBBLE}/${rkey}`;
    const written = await w.externalCreateRecord(rkey, record);
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ uri, cid: expect.any(String) });
    const remote = await w.bobRepo.list(SCROBBLE);
    expect(remote).toEqual([{ rkey, cid: written.body.cid, value: record }]);
    const commit = w.commits.at(-1)!;
    expect(commit).toMatchObject({ did: BOB, rev: expect.any(String), ops: [{ action: 'create', rkey }] });
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.repo.createRecord', did: BOB, status: 200 })).toBe(1);

    // A transient independent-PDS proof failure must leave the durable hint
    // retryable. Hold the next successful proof so the process can die while
    // that retry is in flight.
    w.bobPds.serverError('com.atproto.sync.getRecord', 503);
    const proofHeld = w.pause('com.atproto.sync.getRecord', {
      host: BOB_PDS_HOST,
      method: 'GET',
      query: { did: BOB, collection: SCROBBLE, rkey },
    });
    const emitted = await w.command<JetstreamEvent[]>('events', { commits: [commit] });
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    if (event.kind !== 'commit') throw new Error(`expected commit event, got ${event.kind}`);
    // Advance one alarm slice at a time until the fault is observed. Avoid
    // waiting on wall-clock scheduling or running past the first failed call.
    for (
      let i = 0;
      i < 40 && w.bobPds.calls.count({ nsid: 'com.atproto.sync.getRecord', did: BOB, status: 503 }) === 0;
      i++
    ) {
      await w.pump();
    }
    expect(w.bobPds.calls.filter({ nsid: 'com.atproto.sync.getRecord', did: BOB, status: 503 })).toMatchObject([
      {
        host: BOB_PDS_HOST,
        method: 'GET',
        params: { did: [BOB], collection: [SCROBBLE], rkey: [rkey] },
      },
    ]);
    // Advance the fixture clock through the retry backoff until the successful
    // proof request reaches the hold point; no wall-clock sleeps are used.
    const proofPumpRuns: Promise<void>[] = [];
    let proofRequest: Wire | null = null;
    for (let i = 0; i < 40 && proofRequest === null; i++) {
      const cycle = w.pump().catch(() => {});
      proofPumpRuns.push(cycle);
      proofRequest = await Promise.race([proofHeld, cycle.then(() => null)]);
    }
    if (proofRequest === null)
      throw new Error(`second-PDS retry proof was not requested\n${JSON.stringify(await w.inspect())}`);
    const proofUrl = new URL(proofRequest.url);
    expect(proofRequest.method).toBe('GET');
    expect(proofUrl.hostname).toBe(BOB_PDS_HOST);
    expect(proofUrl.pathname).toBe('/xrpc/com.atproto.sync.getRecord');
    expect(proofUrl.searchParams.get('did')).toBe(BOB);
    expect(proofUrl.searchParams.get('collection')).toBe(SCROBBLE);
    expect(proofUrl.searchParams.get('rkey')).toBe(rkey);
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.sync.getRecord', did: BOB, status: 503 })).toBe(1);
    const beforeKill = await w.inspect();
    const savedHint = beforeKill.hints!.find((row) => row.uri === uri)!;
    expect(savedHint).toMatchObject({
      did: BOB,
      collection: SCROBBLE,
      rkey,
      source: 'jetstream',
      hint_rev: commit.rev,
    });
    expect(beforeKill.ingest_checkpoint?.[0]?.cursor).toBe(event.seq);
    expect(beforeKill.scrobbles).toEqual([]);
    expect(beforeKill.record_state).toEqual([]);
    expect(beforeKill.operations).toEqual([]);
    expect((await w.send('GET', '/api/v1/feed?scope=global')).body.items).toEqual([]);

    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await Promise.all(proofPumpRuns);
    await w.start();
    const afterRestart = await w.inspect();
    expect(afterRestart.hints?.find((row) => row.uri === uri)).toMatchObject({
      did: savedHint.did,
      collection: savedHint.collection,
      rkey: savedHint.rkey,
      source: savedHint.source,
      hint_rev: savedHint.hint_rev,
    });
    expect(afterRestart.ingest_checkpoint?.[0]?.cursor).toBe(beforeKill.ingest_checkpoint?.[0]?.cursor);
    expect(afterRestart.scrobbles).toEqual([]);
    expect(afterRestart.operations).toEqual([]);

    const recovered = await w.until((s) => {
      const bob = s.users?.find((row) => row.did === BOB);
      const pending = s.hints?.some((row) => row.uri === uri) ?? true;
      const snapshot = s.repo_jobs?.find((row) => row.did === BOB && row.kind === 'snapshot');
      return (
        s.scrobbles?.filter((row) => row.uri === uri).length === 1 &&
        !pending &&
        bob?.active === 1 &&
        bob.indexing_state === 'current' &&
        (snapshot === undefined || snapshot.state === 'complete')
      );
    });
    const indexed = recovered.scrobbles!.filter((row) => row.uri === uri);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      uri,
      cid: written.body.cid,
      did: BOB,
      rkey,
      revision: commit.rev,
      artist: record.artist,
      track: record.track,
      album: record.album,
      listened_at: listenedAt.replace('Z', '000000Z'),
      created_at: listenedAt.replace('Z', '000000Z'),
      duration_seconds: null,
      recording_mbid: null,
    });
    expect(recovered.record_state?.filter((row) => row.uri === uri)).toEqual([
      expect.objectContaining({ uri, did: BOB, revision: commit.rev, cid: written.body.cid, state: 'present' }),
    ]);
    expect(recovered.operations).toEqual([]);
    expect(await w.repo.list(SCROBBLE)).toEqual([]);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual(remote);
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.sync.getRecord', did: BOB, status: 200 })).toBeGreaterThanOrEqual(
      2,
    );

    const feed = await w.send('GET', '/api/v1/feed?scope=global');
    const history = await w.send('GET', `/api/v1/users/${BOB}/scrobbles?limit=10`);
    const status = await w.send('GET', `/api/v1/records/status?uri=${encodeURIComponent(uri)}`);
    const stats = await w.send('GET', `/api/v1/users/${BOB}/stats`);
    expect(feed.status).toBe(200);
    expect(history.status).toBe(200);
    expect(status).toMatchObject({ status: 200, body: { uri, state: 'indexed', cid: written.body.cid } });
    expect(stats.status).toBe(200);
    const expectedDto = {
      uri,
      cid: written.body.cid,
      did: BOB,
      revision: commit.rev,
      indexedAt: indexed[0]?.indexed_at,
      artist: record.artist,
      track: record.track,
      album: record.album,
      listenedAt: listenedAt.replace('Z', '000000Z'),
      createdAt: listenedAt.replace('Z', '000000Z'),
    };
    for (const page of [feed, history]) {
      expect(page.body.items).toHaveLength(1);
      expect(page.body.items[0]).toEqual(expectedDto);
      expect(page.body.nextCursor).toBeNull();
    }
    expect(stats.body.totalScrobbles).toBe(1);

    const duplicate = await w.command<JetstreamEvent[]>('events', { commits: [commit] });
    expect(duplicate).toHaveLength(1);
    const duplicateEvent = duplicate[0]!;
    if (duplicateEvent.kind !== 'commit')
      throw new Error(`expected duplicate commit event, got ${duplicateEvent.kind}`);
    const afterDuplicate = await w.until(
      (s) =>
        s.ingest_checkpoint?.[0]?.cursor === duplicateEvent.seq && s.hints?.every((row) => row.uri !== uri) === true,
    );
    expect(afterDuplicate.scrobbles?.filter((row) => row.uri === uri)).toEqual(indexed);
    expect(afterDuplicate.record_state?.filter((row) => row.uri === uri)).toEqual(
      recovered.record_state?.filter((row) => row.uri === uri),
    );
    expect((await w.send('GET', '/api/v1/feed?scope=global')).body.items).toEqual(feed.body.items);
    expect((await w.send('GET', `/api/v1/users/${BOB}/stats`)).body.totalScrobbles).toBe(1);
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.repo.createRecord', did: BOB, status: 200 })).toBe(1);
    expect((await w.inspect()).operations).toEqual([]);

    const waitForHeldProof = async (held: Promise<Wire>, phase: string) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          held,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${phase} proof was not requested`)), 5_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };
    const proofMatch = { host: BOB_PDS_HOST, method: 'GET', query: { did: BOB, collection: SCROBBLE, rkey } };

    // Independent PDS update: the signed head changes, but the current indexed row stays intact
    // while the proof response is held. SIGKILL loses the request; restart replays and verifies it.
    const priorPlcResolutions = w.plc.count(BOB);
    const oldSigningKey = w.plc.entry(BOB)?.signingKey;
    await w.rotateBobSigningKey();
    expect(w.plc.entry(BOB)?.signingKey).not.toBe(oldSigningKey);
    const updatedRecord = { ...record, track: 'Sour Times' };
    const updatedWrite = await w.externalPutRecord(rkey, updatedRecord, written.body.cid);
    expect(updatedWrite.status).toBe(200);
    expect(updatedWrite.body).toMatchObject({ uri, cid: expect.any(String) });
    const updatedCommit = w.commits.at(-1);
    if (!updatedCommit) throw new Error('missing external update commit');
    const updateHeld = w.pause('com.atproto.sync.getRecord', proofMatch);
    const updateEvents = await w.command<JetstreamEvent[]>('events', { commits: [updatedCommit] });
    expect(updateEvents).toHaveLength(1);
    const updateEvent = updateEvents[0];
    if (updateEvent?.kind !== 'commit') throw new Error('expected external update commit event');
    const updating = w.pump().catch(() => {});
    const updateProof = await waitForHeldProof(updateHeld, 'update');
    expect(new URL(updateProof.url).searchParams.get('rkey')).toBe(rkey);
    const beforeUpdateKill = await w.inspect();
    expect(beforeUpdateKill.hints?.find((row) => row.uri === uri)).toMatchObject({ hint_rev: updatedCommit.rev });
    expect(beforeUpdateKill.ingest_checkpoint?.[0]?.cursor).toBe(updateEvent.seq);
    expect(beforeUpdateKill.scrobbles?.filter((row) => row.uri === uri)).toMatchObject([
      { cid: written.body.cid, track: record.track },
    ]);
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await updating;
    await w.start();
    const updated = await w.until(
      (s) =>
        s.scrobbles?.filter((row) => row.uri === uri).length === 1 &&
        s.scrobbles?.some((row) => row.uri === uri && row.cid === updatedWrite.body.cid) === true &&
        s.hints?.every((row) => row.uri !== uri) === true &&
        s.users?.find((row) => row.did === BOB)?.indexing_state === 'current',
    );
    expect(updated.scrobbles?.filter((row) => row.uri === uri)).toMatchObject([
      { cid: updatedWrite.body.cid, track: 'Sour Times', album: 'Dummy' },
    ]);
    // The database retained the old cached DID key across SIGKILL; successful
    // convergence therefore requires fresh PLC resolution after signature failure.
    expect(w.plc.count(BOB)).toBeGreaterThan(priorPlcResolutions);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([{ rkey, cid: updatedWrite.body.cid, value: updatedRecord }]);
    expect((await w.send('GET', '/api/v1/feed?scope=global')).body.items).toMatchObject([
      { uri, cid: updatedWrite.body.cid, track: 'Sour Times' },
    ]);
    expect((await w.send('GET', `/api/v1/users/${BOB}/stats`)).body.totalScrobbles).toBe(1);
    const duplicateUpdateEvents = await w.command<JetstreamEvent[]>('events', { commits: [updatedCommit] });
    const duplicateUpdate = duplicateUpdateEvents[0];
    if (duplicateUpdate?.kind !== 'commit') throw new Error('expected duplicate update event');
    const afterDuplicateUpdate = await w.until(
      (s) =>
        s.ingest_checkpoint?.[0]?.cursor === duplicateUpdate.seq && s.hints?.every((row) => row.uri !== uri) === true,
    );
    expect(afterDuplicateUpdate.scrobbles?.filter((row) => row.uri === uri)).toEqual(
      updated.scrobbles?.filter((row) => row.uri === uri),
    );
    expect((await w.send('GET', `/api/v1/users/${BOB}/stats`)).body.totalScrobbles).toBe(1);

    // Independent PDS deletion: the absent-record proof is also held across SIGKILL. The verified
    // exclusion is applied once after restart and removes the row from every public read.
    const deletedWrite = await w.externalDeleteRecord(rkey, updatedWrite.body.cid);
    expect(deletedWrite.status).toBe(200);
    expect(w.bobRepo.head?.rev).toBe(deletedWrite.body.commit.rev);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([]);
    const deleteCommit = w.commits.at(-1);
    if (!deleteCommit) throw new Error('missing external delete commit');
    const deleteHeld = w.pause('com.atproto.sync.getRecord', proofMatch);
    const deleteEvents = await w.command<JetstreamEvent[]>('events', { commits: [deleteCommit] });
    expect(deleteEvents).toHaveLength(1);
    const deleteEvent = deleteEvents[0];
    if (deleteEvent?.kind !== 'commit') throw new Error('expected external delete commit event');
    const deleting = w.pump().catch(() => {});
    const deleteProof = await waitForHeldProof(deleteHeld, 'delete');
    expect(new URL(deleteProof.url).searchParams.get('rkey')).toBe(rkey);
    const beforeDeleteKill = await w.inspect();
    expect(beforeDeleteKill.hints?.find((row) => row.uri === uri)).toMatchObject({ hint_rev: deleteCommit.rev });
    expect(beforeDeleteKill.ingest_checkpoint?.[0]?.cursor).toBe(deleteEvent.seq);
    expect(beforeDeleteKill.scrobbles?.filter((row) => row.uri === uri)).toMatchObject([
      { cid: updatedWrite.body.cid, track: 'Sour Times' },
    ]);
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await deleting;
    await w.start();
    const removed = await w.until(
      (s) =>
        s.scrobbles?.every((row) => row.uri !== uri) === true &&
        s.hints?.every((row) => row.uri !== uri) === true &&
        s.record_state?.some((row) => row.uri === uri && row.state === 'absent') === true &&
        s.users?.find((row) => row.did === BOB)?.indexing_state === 'current',
    );
    expect(removed.scrobbles?.filter((row) => row.uri === uri)).toEqual([]);
    expect(removed.record_state?.filter((row) => row.uri === uri)).toEqual([
      expect.objectContaining({ uri, did: BOB, revision: deleteCommit.rev, state: 'absent' }),
    ]);
    expect((await w.send('GET', '/api/v1/feed?scope=global')).body.items).toEqual([]);
    expect((await w.send('GET', `/api/v1/users/${BOB}/scrobbles?limit=10`)).body.items).toEqual([]);
    expect((await w.send('GET', `/api/v1/users/${BOB}/stats`)).body.totalScrobbles).toBe(0);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([]);
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.repo.createRecord', did: BOB, status: 200 })).toBe(1);
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.repo.putRecord', did: BOB, status: 200 })).toBe(1);
    expect(w.bobPds.calls.count({ nsid: 'com.atproto.repo.deleteRecord', did: BOB, status: 200 })).toBe(1);
    const duplicateDeleteEvents = await w.command<JetstreamEvent[]>('events', { commits: [deleteCommit] });
    const duplicateDelete = duplicateDeleteEvents[0];
    if (duplicateDelete?.kind !== 'commit') throw new Error('expected duplicate delete event');
    const afterDuplicateDelete = await w.until(
      (s) =>
        s.ingest_checkpoint?.[0]?.cursor === duplicateDelete.seq && s.hints?.every((row) => row.uri !== uri) === true,
    );
    expect(afterDuplicateDelete.scrobbles?.filter((row) => row.uri === uri)).toEqual([]);
    expect(afterDuplicateDelete.record_state?.filter((row) => row.uri === uri)).toEqual(
      removed.record_state?.filter((row) => row.uri === uri),
    );
    expect((await w.send('GET', `/api/v1/users/${BOB}/stats`)).body.totalScrobbles).toBe(0);

    // A commit arrives while the socket is closed and the process dies before reconnect.
    // The next process must replay from the durable cursor, prove the second-PDS head,
    // and converge the exact remote/projection set rather than relying on a live hint.
    const cursorBeforeOutage = afterDuplicateDelete.ingest_checkpoint?.[0]?.cursor;
    if (typeof cursorBeforeOutage !== 'number') throw new Error('expected a durable Jetstream cursor before outage');
    expect(await w.command<number>('disconnectJetstream')).toBe(1);
    const disconnected = await w.until((s) => s.ingest_checkpoint?.[0]?.connected === 0);
    expect(disconnected.ingest_checkpoint?.[0]?.cursor).toBe(cursorBeforeOutage);
    const backfillRecord = { ...record, track: 'Glory Box' };
    const backfillWrite = await w.externalCreateRecord('remote02', backfillRecord);
    expect(backfillWrite.status).toBe(200);
    const backfillCommit = w.commits.at(-1);
    if (!backfillCommit) throw new Error('missing second-PDS backfill commit');
    const backfillEvents = await w.command<JetstreamEvent[]>('events', { commits: [backfillCommit] });
    expect(backfillEvents).toHaveLength(1);
    const backfillEvent = backfillEvents[0]!;
    if (backfillEvent.kind !== 'commit') throw new Error('expected backfill commit event');
    expect(backfillEvent.seq).toBeGreaterThan(cursorBeforeOutage);
    const beforeOutageKill = await w.inspect();
    expect(beforeOutageKill.ingest_checkpoint?.[0]?.cursor).toBe(cursorBeforeOutage);
    expect(beforeOutageKill.hints?.every((row) => row.rkey !== 'remote02')).toBe(true);
    expect(beforeOutageKill.scrobbles?.some((row) => row.rkey === 'remote02')).toBe(false);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([
      { rkey: 'remote02', cid: backfillWrite.body.cid, value: backfillRecord },
    ]);
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await w.start();
    const backfilled = await w.until(
      (s) =>
        s.ingest_checkpoint?.[0]?.cursor === backfillEvent.seq &&
        s.scrobbles?.filter((row) => row.rkey === 'remote02').length === 1 &&
        s.hints?.every((row) => row.rkey !== 'remote02') === true &&
        s.users?.find((row) => row.did === BOB)?.indexing_state === 'current',
    );
    // For this second-PDS actor, compare the complete active projection and
    // follow sets to the independent repository rather than just checking the
    // one expected URI. The earlier remote01 delete remains absent.
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([
      { rkey: 'remote02', cid: backfillWrite.body.cid, value: backfillRecord },
    ]);
    expect(backfilled.scrobbles).toHaveLength(1);
    expect(
      backfilled.scrobbles?.map((row) => ({
        uri: row.uri,
        cid: row.cid,
        did: row.did,
        rkey: row.rkey,
        revision: row.revision,
        artist: row.artist,
        track: row.track,
        album: row.album,
        listened_at: row.listened_at,
        created_at: row.created_at,
        duration_seconds: row.duration_seconds,
        recording_mbid: row.recording_mbid,
        album_artist: row.album_artist,
        track_number: row.track_number,
        artist_mbids: row.artist_mbids,
        release_mbid: row.release_mbid,
        release_group_mbid: row.release_group_mbid,
        isrc: row.isrc,
        submission_client: row.submission_client,
        music_service: row.music_service,
      })),
    ).toEqual([
      {
        uri: backfillWrite.body.uri,
        cid: backfillWrite.body.cid,
        did: BOB,
        rkey: 'remote02',
        revision: backfillCommit.rev,
        artist: 'Portishead',
        track: 'Glory Box',
        album: 'Dummy',
        listened_at: listenedAt.replace('Z', '000000Z'),
        created_at: listenedAt.replace('Z', '000000Z'),
        duration_seconds: null,
        recording_mbid: null,
        album_artist: null,
        track_number: null,
        artist_mbids: null,
        release_mbid: null,
        release_group_mbid: null,
        isrc: null,
        submission_client: null,
        music_service: null,
      },
    ]);
    expect(await w.bobRepo.list(FOLLOW)).toEqual([]);
    expect(backfilled.follows).toEqual([]);
    const backfilledRow = backfilled.scrobbles?.find((row) => row.rkey === 'remote02');
    expect(backfilledRow).toMatchObject({
      uri: backfillWrite.body.uri,
      cid: backfillWrite.body.cid,
      did: BOB,
      revision: backfillCommit.rev,
      artist: record.artist,
      track: 'Glory Box',
      album: record.album,
    });
    expect(backfilled.record_state?.filter((row) => row.uri === backfillWrite.body.uri)).toEqual([
      expect.objectContaining({
        uri: backfillWrite.body.uri,
        did: BOB,
        revision: backfillCommit.rev,
        cid: backfillWrite.body.cid,
        state: 'present',
      }),
    ]);
    const recoveredFeed = await w.send('GET', '/api/v1/feed?scope=global');
    const recoveredHistory = await w.send('GET', `/api/v1/users/${BOB}/scrobbles?limit=10`);
    expect(recoveredFeed.body.items.map((item: { uri: string }) => item.uri)).toEqual([backfillWrite.body.uri]);
    expect(recoveredHistory.body.items.map((item: { uri: string }) => item.uri)).toEqual([backfillWrite.body.uri]);
    expect((await w.send('GET', `/api/v1/users/${BOB}/stats`)).body.totalScrobbles).toBe(1);
    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
  } finally {
    await w.close();
  }
}, 120_000);

it('packaged_recovery: SIGKILL after create and delete commits reconciles durable operations, views, cursor and checkpoint on the same database', async () => {
  const w = await world();
  try {
    await w.start();
    await w.signIn();
    await w.until((s) => s.ingest_checkpoint?.[0]?.connected === 1);
    const input = {
      artist: 'Björk',
      track: 'Jóga',
      album: 'Homogenic',
      listenedAt: new Date(NOW - 60_000).toISOString(),
    };
    const posted = await w.send('POST', '/api/v1/scrobbles', input, 'packaged-recovery-1');
    expect(posted.status).toBe(202);
    const id = posted.body.operation.id;
    const before = await w.inspect();
    const create = before.operations!.find((r) => r.id === id)!;
    const localRkey = create.rkey;
    if (typeof localRkey !== 'string') throw new Error('expected the accepted create to have a rkey');
    expect(create.state).toBe('queued');
    const reached = w.pause('com.atproto.repo.createRecord');
    const pumping = w.pump().catch(() => {}); // the IPC command dies with the process
    await reached;
    const interrupted = await w.inspect();
    expect(interrupted.operations!.find((r) => r.id === id)).toMatchObject({
      state: 'running',
      attempts: 1,
      rkey: create.rkey,
    });
    const remote = await w.repo.list(SCROBBLE);
    expect(remote).toHaveLength(1);
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await pumping;

    await w.start();
    const restored = await w.inspect();
    expect(restored.operations!.find((r) => r.id === id)).toEqual(interrupted.operations!.find((r) => r.id === id));
    // Startup can change connected/updated_at_ms, never the durable cursor.
    expect(restored.ingest_checkpoint![0]?.cursor).toBe(interrupted.ingest_checkpoint![0]?.cursor);
    const indexed = await w.until(
      (s) => s.operations!.find((r) => r.id === id)?.state === 'succeeded' && s.scrobbles!.length === 1,
    );
    expect(indexed.operations!.find((r) => r.id === id)).toMatchObject({
      attempts: 2,
      rkey: create.rkey,
      digest: create.digest,
    });
    expect(await w.repo.list(SCROBBLE)).toEqual(remote);
    const uri = `at://${ALICE}/${SCROBBLE}/${create.rkey}`;
    const secondInput = { ...input, track: 'Hunter', listenedAt: new Date(NOW - 120_000).toISOString() };
    expect((await w.send('POST', '/api/v1/scrobbles', secondInput, 'packaged-recovery-2')).status).toBe(202);
    expect((await w.send('PUT', `/api/v1/follows/${BOB}`)).status).toBe(202);
    await w.until((s) => s.scrobbles!.length === 2 && s.follows!.length === 1);
    const followingPath = `/api/v1/users/${ALICE}/following`;
    const following = await w.send('GET', followingPath);
    expect(following.status).toBe(200);
    expect(following.body.items).toMatchObject([{ actor: ALICE, subject: BOB }]);
    const historyPath = `/api/v1/users/${ALICE}/scrobbles?limit=1`;
    const history = await w.send('GET', historyPath);
    expect(history.status).toBe(200);
    expect(history.body.items).toMatchObject([
      { uri, cid: remote[0]!.cid, did: ALICE, ...input, listenedAt: input.listenedAt.replace('Z', '000000Z') },
    ]);
    const replay = await w.send('POST', '/api/v1/scrobbles', input, 'packaged-recovery-1');
    expect(replay.body.operation.id).toBe(id);
    const statsPath = `/api/v1/users/${ALICE}/stats`;
    const stats = await w.send('GET', statsPath);
    expect(stats.status).toBe(200);
    expect(stats.body.totalScrobbles).toBe(2);
    expect(typeof history.body.nextCursor).toBe('string');
    const nextPath = `${historyPath}&cursor=${encodeURIComponent(history.body.nextCursor)}`;
    const nextBeforeRestart = await w.send('GET', nextPath);
    expect(nextBeforeRestart.body.items).toMatchObject([{ track: 'Hunter' }]);
    const checkpoint = (await w.inspect()).ingest_checkpoint![0]!;
    expect(checkpoint.cursor).not.toBeNull();
    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
    await w.start();
    expect((await w.send('GET', historyPath)).body).toEqual(history.body);
    expect((await w.send('GET', nextPath)).body).toEqual(nextBeforeRestart.body);
    expect((await w.send('GET', followingPath)).body).toEqual(following.body);
    expect((await w.send('GET', statsPath)).body).toEqual(stats.body);
    expect((await w.inspect()).ingest_checkpoint![0]?.cursor).toBe(checkpoint.cursor);
    expect((await w.send('GET', '/api/v1/auth/session')).status).toBe(200);

    const deleted = await w.send('DELETE', `/api/v1/scrobbles/${encodeURIComponent(uri)}`);
    expect(deleted.status).toBe(202);
    const deleteId = deleted.body.operation.id;
    const deletedRemote = w.pause('com.atproto.repo.deleteRecord');
    const deleting = w.pump().catch(() => {});
    await deletedRemote;
    const inDelete = await w.inspect();
    expect(inDelete.operations!.find((r) => r.id === deleteId)).toMatchObject({
      state: 'running',
      attempts: 1,
      swap_cid: remote[0]!.cid,
    });
    expect((await w.repo.list(SCROBBLE)).map((r) => r.value)).toMatchObject([{ track: 'Hunter' }]);
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await deleting;
    await w.start();
    expect((await w.inspect()).operations!.find((r) => r.id === deleteId)).toEqual(
      inDelete.operations!.find((r) => r.id === deleteId),
    );
    const proofPending = w.pause('com.atproto.sync.getRecord', {
      host: 'pds.example.test',
      method: 'GET',
      query: { did: ALICE, collection: SCROBBLE, rkey: localRkey },
    });
    const proofPumpRuns: Promise<void>[] = [];
    let heldProof: Wire | null = null;
    for (let i = 0; i < 10 && heldProof === null; i++) {
      const cycle = w.pump().catch(() => {});
      proofPumpRuns.push(cycle);
      heldProof = await Promise.race([proofPending, cycle.then(() => null)]);
    }
    if (heldProof === null) throw new Error(`delete absence proof was not requested\n${await w.inspect()}`);
    expect(new URL(heldProof.url).searchParams.get('rkey')).toBe(create.rkey);
    const acknowledged = await w.inspect();
    expect(acknowledged.operations!.find((r) => r.id === deleteId)).toMatchObject({
      state: 'succeeded',
      swap_cid: remote[0]!.cid,
    });
    expect(acknowledged.scrobbles!.some((r) => r.uri === uri && r.cid === remote[0]!.cid)).toBe(true);
    const hiddenBeforeProof = await w.send('GET', `/api/v1/users/${ALICE}/scrobbles?limit=10`);
    expect(hiddenBeforeProof.body.items.map((item: { uri: string }) => item.uri)).not.toContain(uri);
    expect((await w.send('GET', `/api/v1/scrobbles/${encodeURIComponent(uri)}`)).status).toBe(404);
    expect(
      (await w.send('GET', '/api/v1/feed?scope=global')).body.items.map((item: { uri: string }) => item.uri),
    ).not.toContain(uri);
    expect((await w.send('GET', statsPath)).body.totalScrobbles).toBe(1);

    // The process dies with PDS acknowledgement durable but its signed absence proof in flight.
    expect(await w.stop('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    await Promise.all(proofPumpRuns);
    await w.start();
    const afterProofRestart = await w.inspect();
    expect(afterProofRestart.operations!.find((r) => r.id === deleteId)).toMatchObject({
      state: 'succeeded',
      swap_cid: remote[0]!.cid,
    });
    expect(afterProofRestart.scrobbles!.some((r) => r.uri === uri && r.cid === remote[0]!.cid)).toBe(true);
    expect(
      (await w.send('GET', `/api/v1/users/${ALICE}/scrobbles?limit=10`)).body.items.map(
        (item: { uri: string }) => item.uri,
      ),
    ).not.toContain(uri);
    const absent = await w.until(
      (s) =>
        s.operations!.find((r) => r.id === deleteId)?.state === 'succeeded' &&
        s.scrobbles!.every((r) => r.uri !== uri) &&
        s.record_state!.some((r) => r.uri === uri && r.state === 'absent'),
    );
    expect(absent.operations!.find((r) => r.id === id)).toMatchObject({
      state: 'succeeded',
      record_json: null,
      digest: null,
    });
    expect((await w.send('GET', historyPath)).body.items).toMatchObject([{ track: 'Hunter' }]);
    expect((await w.send('GET', '/api/v1/feed?scope=global')).body.items).toMatchObject([{ track: 'Hunter' }]);
    expect((await w.send('GET', statsPath)).body.totalScrobbles).toBe(1);
    expect((await w.repo.list(SCROBBLE)).map((r) => r.value)).toMatchObject([{ track: 'Hunter' }]);
    const after = await w.send('POST', '/api/v1/scrobbles', input, 'packaged-recovery-1');
    expect(after.body.operation.id).toBe(id);
    expect((await w.inspect()).operations).toHaveLength(4);
    expect(w.pds.calls.count({ nsid: 'com.atproto.repo.createRecord', status: 200 })).toBe(3);
    expect(w.pds.calls.count({ nsid: 'com.atproto.repo.deleteRecord', status: 200 })).toBe(1);
    // The hide is asserted only after the PDS delete succeeded and before the signed absence proof applied.
    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
  } finally {
    await w.close();
  }
}, 120_000);

it('packaged_follow_feed_recovery: second-PDS create, update and delete persist through process restarts', async () => {
  // Give this process-level journey an absolute, repeatable asOf independent of
  // the other recovery tests' explicit clock advances.
  clock.set(new Date(NOW).toISOString());
  const w = await world();
  try {
    await w.start();
    await w.signIn();
    await w.until((s) => s.ingest_checkpoint?.[0]?.connected === 1);
    expect((await w.send('POST', '/api/v1/notify', { did: BOB })).status).toBe(202);
    await w.until((s) => {
      const bob = s.users?.find((row) => row.did === BOB);
      const snapshot = s.repo_jobs?.find((row) => row.did === BOB && row.kind === 'snapshot');
      return (
        bob?.active === 1 &&
        bob.indexing_state === 'current' &&
        s.hints?.every((row) => row.did !== BOB) === true &&
        (snapshot === undefined || snapshot.state === 'complete')
      );
    });

    const listenedAt = new Date(NOW - 60_000).toISOString();
    const record = {
      $type: SCROBBLE,
      artist: 'M5 Remote Artist',
      track: 'Before Update',
      album: 'M5 Remote Album',
      listenedAt,
      createdAt: listenedAt,
    };
    const rkey = 'm5remote1';
    const uri = `at://${BOB}/${SCROBBLE}/${rkey}`;
    const written = await w.externalCreateRecord(rkey, record);
    expect(written.status).toBe(200);
    const createCommit = w.commits.at(-1);
    if (!createCommit) throw new Error('missing second-PDS create commit');
    expect(await w.command<JetstreamEvent[]>('events', { commits: [createCommit] })).toHaveLength(1);
    await w.until((s) => s.scrobbles?.some((row) => row.uri === uri && row.track === 'Before Update') === true);

    expect((await w.send('PUT', `/api/v1/follows/${BOB}`)).status).toBe(202);
    await w.until((s) => s.follows?.some((row) => row.actor === ALICE && row.subject === BOB) === true);
    const feedPath = `/api/v1/feed?scope=following&viewer=${encodeURIComponent(ALICE)}`;
    const historyPath = `/api/v1/users/${BOB}/scrobbles?limit=10`;
    const statsPath = `/api/v1/users/${BOB}/stats`;
    const followingPath = `/api/v1/users/${ALICE}/following`;
    const beforeRestart = {
      feed: (await w.send('GET', feedPath)).body,
      history: (await w.send('GET', historyPath)).body,
      stats: (await w.send('GET', statsPath)).body,
      following: (await w.send('GET', followingPath)).body,
    };
    expect(beforeRestart.feed.items).toMatchObject([{ uri, did: BOB, track: 'Before Update' }]);
    expect(beforeRestart.history.items).toMatchObject([{ uri, track: 'Before Update' }]);
    expect(beforeRestart.stats.totalScrobbles).toBe(1);
    expect(beforeRestart.following.items).toMatchObject([{ actor: ALICE, subject: BOB }]);

    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
    await w.start();
    expect((await w.send('GET', feedPath)).body).toEqual(beforeRestart.feed);
    expect((await w.send('GET', historyPath)).body).toEqual(beforeRestart.history);
    expect((await w.send('GET', statsPath)).body).toEqual(beforeRestart.stats);
    expect((await w.send('GET', followingPath)).body).toEqual(beforeRestart.following);

    const updatedRecord = { ...record, track: 'After Update' };
    const updated = await w.externalPutRecord(rkey, updatedRecord, written.body.cid);
    expect(updated.status).toBe(200);
    const updateCommit = w.commits.at(-1);
    if (!updateCommit) throw new Error('missing second-PDS update commit');
    expect(await w.command<JetstreamEvent[]>('events', { commits: [updateCommit] })).toHaveLength(1);
    await w.until((s) => s.scrobbles?.some((row) => row.uri === uri && row.track === 'After Update') === true);
    const afterUpdate = {
      feed: (await w.send('GET', feedPath)).body,
      history: (await w.send('GET', historyPath)).body,
      stats: (await w.send('GET', statsPath)).body,
    };
    expect(afterUpdate.feed.items).toMatchObject([{ uri, track: 'After Update', cid: updated.body.cid }]);
    expect(afterUpdate.history.items).toMatchObject([{ uri, track: 'After Update', cid: updated.body.cid }]);
    expect(afterUpdate.stats.totalScrobbles).toBe(1);
    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
    await w.start();
    expect((await w.send('GET', feedPath)).body).toEqual(afterUpdate.feed);
    expect((await w.send('GET', historyPath)).body).toEqual(afterUpdate.history);
    expect((await w.send('GET', statsPath)).body).toEqual(afterUpdate.stats);

    const deleted = await w.externalDeleteRecord(rkey, updated.body.cid);
    expect(deleted.status).toBe(200);
    const deleteCommit = w.commits.at(-1);
    if (!deleteCommit) throw new Error('missing second-PDS delete commit');
    expect(await w.command<JetstreamEvent[]>('events', { commits: [deleteCommit] })).toHaveLength(1);
    await w.until(
      (s) =>
        s.scrobbles?.every((row) => row.uri !== uri) === true &&
        s.record_state?.some((row) => row.uri === uri && row.state === 'absent') === true,
    );
    const afterDelete = {
      feed: (await w.send('GET', feedPath)).body,
      history: (await w.send('GET', historyPath)).body,
      stats: (await w.send('GET', statsPath)).body,
      following: (await w.send('GET', followingPath)).body,
    };
    expect(afterDelete.feed.items).toEqual([]);
    expect(afterDelete.history.items).toEqual([]);
    expect(afterDelete.stats.totalScrobbles).toBe(0);
    expect(afterDelete.following.items).toMatchObject([{ actor: ALICE, subject: BOB }]);

    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
    await w.start();
    expect((await w.send('GET', feedPath)).body).toEqual(afterDelete.feed);
    expect((await w.send('GET', historyPath)).body).toEqual(afterDelete.history);
    expect((await w.send('GET', statsPath)).body).toEqual(afterDelete.stats);
    expect((await w.send('GET', followingPath)).body).toEqual(afterDelete.following);
    expect((await w.inspect()).scrobbles?.some((row) => row.uri === uri)).toBe(false);
    expect(await w.bobRepo.list(SCROBBLE)).toEqual([]);
    expect(await w.stop('SIGTERM')).toEqual({ code: 0, signal: null });
  } finally {
    await w.close();
  }
}, 120_000);
