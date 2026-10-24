// Test-only Worker entry for the browser end-to-end stack (W6-03;
// wrangler.e2e.jsonc, run by scripts/e2e/start-stack.ts under `wrangler dev`).
// TEST-ONLY: never deployed, never imported by worker/src.
//
// `E2eIndexDO` is the production IndexDO with exactly one override,
// `buildDeps` (the ADR 0004 §4.4 test seam), and it changes only what the
// local network needs:
// - transport: a fixture-marked router (packages/atproto/test-support) whose
//   routes are the dev-env hosts of scripts/e2e/dev-env.ts and nothing else:
//   each `https://<host>/…` request (pds1.test, pds2.test, plc.directory) is
//   forwarded to that host's http loopback port on 127.0.0.1; a fake DoH
//   answers the SafeFetch pre-check (and has no `_atproto` TXT records, so
//   the DNS method finds nothing); handles resolve through
//   `https://<handle>/.well-known/atproto-did`, which the router itself
//   answers from E2E_NETWORK's handle → DID map (the accounts the stack
//   created on the dev-env PDSs, recorded by scripts/e2e/dev-env.ts
//   `workerNetwork`), not the dev-env PDSs; the relay answers an empty
//   discovery page. Any other host is refused (no route), so the IndexDO can never reach
//   the real network. The production SafeFetch policy stays on (https only,
//   default port, no redirects, caps, deadline); the fixture mark admits the
//   reserved `.test` hosts, exactly as in every other fixture suite;
// - config: `parseConfig(env, { allowFixturePrefix: true })`, as every test
//   entry does; INGEST_MODE is `off` (ingestion arrives through notify hints
//   and snapshots only), so the Jetstream connector refuses;
// - randomness: a seeded Random.
// The clock is the system clock: the dev-env PDS is a real OAuth provider and
// signs real commits, so DPoP proofs, token lifetimes and record times are
// checked against wall time; a frozen clock would reject them.
//
// Verification is unchanged: every record is proved by the production drain
// and snapshot code (signed commit, MST membership, record CID) against the
// key in the account's PLC document.
//
// The default export is the production Worker (src/index.ts). Every other
// value export of a main module is a Workers entrypoint, so this module
// exports only `default` and the E2eIndexDO class.

import { fakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { routerTransport, xrpcJson } from '@atmusic/atproto/test-support/router-transport';
import { systemClock } from '@atmusic/core/deps';
import { seededRandom } from '@atmusic/core/test-support/random';
import { parseConfig } from '../../src/config';
import { doDb } from '../../src/do/db';
import { envLogger, type IndexDeps, IndexDO } from '../../src/do/index-do';
import { cachedIdentityResolver } from '../../src/do/ingest/identity-cache';
import type { ConnectJetstream } from '../../src/do/ingest/jetstream-socket';
import type { Env } from '../../src/env';

export { default } from '../../src/index';

/** The relay host wrangler.e2e.jsonc names (discovery only). */
const E2E_RELAY_HOST = 'relay.test';

/** The dev-env network the stack passes as the E2E_NETWORK var (base64url JSON). */
export interface E2eWorkerNetwork {
  /** Public https host → http loopback port on 127.0.0.1. */
  hosts: Record<string, number>;
  /** handle → DID, as the dev-env PDSs serve them. */
  handles: Record<string, string>;
}

export interface E2eEnv extends Env {
  E2E_NETWORK?: string;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Parses and checks E2E_NETWORK; throws (so the DO is not ready) on anything unexpected. */
function parseE2eNetwork(raw: string | undefined): E2eWorkerNetwork {
  if (raw === undefined || raw === '') throw new TypeError('E2E_NETWORK is not set (run scripts/e2e/start-stack.ts)');
  const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<E2eWorkerNetwork>;
  const hosts: Record<string, number> = {};
  for (const [host, port] of Object.entries(value.hosts ?? {})) {
    if (!HOST.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new TypeError(`E2E_NETWORK: bad host entry ${host}`);
    }
    hosts[host] = port;
  }
  const handles: Record<string, string> = {};
  for (const [handle, did] of Object.entries(value.handles ?? {})) {
    if (!HOST.test(handle) || typeof did !== 'string' || !did.startsWith('did:plc:')) {
      throw new TypeError(`E2E_NETWORK: bad handle entry ${handle}`);
    }
    handles[handle] = did;
  }
  return { hosts, handles };
}

/**
 * `https://<host>/<path>` → `http://127.0.0.1:<port>/<path>`, same method,
 * headers and body, redirects returned as they are (SafeFetch refuses them).
 */
function loopbackForwarder(port: number) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
    const init: RequestInit = { method: req.method, headers: req.headers, redirect: 'manual', signal: req.signal };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
    return fetch(target, init);
  };
}

const emptyRelay = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname === '/xrpc/com.atproto.sync.listReposByCollection') return xrpcJson({ repos: [] });
  return xrpcJson({ error: 'MethodNotImplemented', message: 'e2e relay' }, 501);
};

const refuseJetstream: ConnectJetstream = async (url) => {
  throw new TypeError(`e2e stack: ingestion is off; no Jetstream at ${new URL(url).host}`);
};

export class E2eIndexDO extends IndexDO {
  protected override buildDeps(env: E2eEnv, ctx: DurableObjectState): IndexDeps {
    const network = parseE2eNetwork(env.E2E_NETWORK);
    const config = parseConfig(env, { allowFixturePrefix: true });
    if (config.ingestMode !== 'off') throw new TypeError('the e2e stack runs with INGEST_MODE=off');
    const hosts: Record<string, (req: Request) => Promise<Response>> = { [E2E_RELAY_HOST]: emptyRelay };
    for (const [host, port] of Object.entries(network.hosts)) hosts[host] = loopbackForwarder(port);
    const transport = routerTransport({ hosts, doh: fakeDoh(), handles: network.handles });
    const db = doDb(ctx.storage);
    const clock = systemClock;
    return {
      db,
      clock,
      random: seededRandom(6),
      transport,
      identity: cachedIdentityResolver(db, { transport, clock }),
      config,
      log: envLogger(env),
      connectJetstream: refuseJetstream,
      alarms: ctx.storage,
    };
  }
}
