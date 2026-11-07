// Fidelity of the fake PDS's write no-ops to the installed reference PDS
// (@atproto/pds 0.5.40, a dependency of the declared @atproto/dev-env). Its
// com.atproto.repo.deleteRecord of an absent record and putRecord of the bytes
// already stored return before processWrites, the only place swapCommit and
// swapRecord are checked: a 2xx without `commit`, with no swap enforced. A
// client must not read such an answer as a compare-and-swap success, so the
// fake answers the same way (outbox/removal-fence.ts relies on it).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FakePds, fixtureToken } from '@atmusic/atproto/test-support/fake-pds';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { cidOf, SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BATCH = 'com.example.atmusic.scrobbleBatch';
const HOST = 'pds-alice.example.test';
const STALE_CID = 'bafyreiaawy3tvt5ratnkyi4cufgbi4iuomy4gcezjmujq5qlikpafckiyu';
const RECORD = { $type: BATCH, createdAt: '2026-01-15T12:00:00Z', listens: [] };

type Handler = (req: { input: { body: unknown }; auth: unknown }) => Promise<{ body: Record<string, unknown> }>;

/** The installed reference handler `name` (com.atproto.repo.<name>), registered against stub actor storage. */
async function installedHandler(name: 'deleteRecord' | 'putRecord', current: string | null) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@atproto/pds/package.json'));
  const version = (require('@atproto/pds/package.json') as { version: string }).version;
  const mod = (await import(pathToFileURL(join(root, 'dist/api/com/atproto/repo', `${name}.js`)).href)) as {
    default: (server: unknown, ctx: unknown) => void;
  };
  let processWrites = 0;
  let handler: Handler | null = null;
  const ctx = {
    authVerifier: { authorization: () => () => {}, findAccount: async () => ({ did: ALICE }) },
    actorStore: {
      transact: async (_did: string, fn: (txn: unknown) => unknown) =>
        fn({
          record: { getRecord: async () => (current === null ? null : { cid: current }) },
          repo: {
            processWrites: async () => {
              processWrites += 1;
              throw new Error('processWrites (the swap checks) reached');
            },
          },
        }),
    },
  };
  mod.default(
    {
      add: (_lexicon: unknown, config: { handler: Handler }) => {
        handler = config.handler;
      },
    },
    ctx,
  );
  if (handler === null) throw new Error(`no ${name} handler registered`);
  const call = (body: Record<string, unknown>) =>
    handler!({ input: { body }, auth: { credentials: { did: ALICE, type: 'access' } } });
  return { version, call, processWrites: () => processWrites };
}

it('the installed reference PDS answers a delete of an absent record and a put of the stored bytes without commit and without checking either swap', async () => {
  const body = { repo: ALICE, collection: BATCH, rkey: 'test', swapCommit: STALE_CID, swapRecord: STALE_CID };
  const del = await installedHandler('deleteRecord', null);
  expect(del.version).toBe('0.5.40');
  const deleted = await del.call(body);
  expect(del.processWrites()).toBe(0);
  expect(deleted.body).toEqual({});

  const put = await installedHandler('putRecord', cidOf(RECORD));
  const putted = await put.call({ ...body, record: RECORD, validate: false });
  expect(put.processWrites()).toBe(0);
  // `commit: undefined`, absent from the JSON answer.
  expect(putted.body.commit).toBeUndefined();
  expect(JSON.parse(JSON.stringify(putted.body))).not.toHaveProperty('commit');
  expect(putted.body).toMatchObject({ uri: `at://${ALICE}/${BATCH}/test`, cid: cidOf(RECORD) });
});

it('the fake PDS answers the same no-ops the same way, and still refuses a stale swap for a real write', async () => {
  const clock = fixedClock();
  const keys = await fixtureKeys();
  const pds = new FakePds(HOST, { clock });
  const alice = new SignedRepo(ALICE, keys.alice, { clock });
  await pds.addAccount(alice, { handle: 'alice.test' });
  const transport = routerTransport({ pds: [pds] });
  const write = async (nsid: string, body: Record<string, unknown>) => {
    const res = await transport(
      new Request(`${pds.origin}/xrpc/${nsid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken(ALICE)}` },
        body: JSON.stringify({ repo: ALICE, collection: BATCH, ...body }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  await alice.put(BATCH, 'kept', RECORD);
  const head = alice.head!;
  // A stale swapCommit and swapRecord: the reference no-ops never check them.
  const stale = { swapCommit: STALE_CID, swapRecord: STALE_CID };
  expect(await write('com.atproto.repo.deleteRecord', { rkey: 'gone', ...stale })).toEqual({ status: 200, body: {} });
  expect(await write('com.atproto.repo.putRecord', { rkey: 'kept', record: RECORD, ...stale })).toEqual({
    status: 200,
    body: { uri: `at://${ALICE}/${BATCH}/kept`, cid: cidOf(RECORD) },
  });
  expect(alice.head).toEqual(head);
  // A write that would change the repository still enforces both swaps.
  for (const [nsid, extra] of [
    ['com.atproto.repo.deleteRecord', {}],
    ['com.atproto.repo.putRecord', { record: { ...RECORD, createdAt: '2026-01-16T12:00:00Z' } }],
  ] as const) {
    expect(await write(nsid, { rkey: 'kept', ...extra, swapCommit: STALE_CID })).toMatchObject({
      status: 400,
      body: { error: 'InvalidSwap' },
    });
    expect(await write(nsid, { rkey: 'kept', ...extra, swapRecord: STALE_CID })).toMatchObject({
      status: 400,
      body: { error: 'InvalidSwap' },
    });
  }
  expect(alice.head).toEqual(head);
  const committed = await write('com.atproto.repo.deleteRecord', { rkey: 'kept', swapCommit: head.cid });
  expect(committed.status).toBe(200);
  expect(committed.body.commit).toMatchObject({ rev: alice.head!.rev });
});
