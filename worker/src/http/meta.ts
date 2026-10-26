// GET /api/v1/meta (API.md, ADR 0004 §9.2 A20).
//
// `{name, version, stage, capabilities, lexiconPrefix, indexing}`:
// - Only initialised capabilities are advertised (API.md). While the IndexDO
//   schema is not ready (`too_new`, or the DO cannot answer) the stage is
//   `scaffold`, capabilities are empty and indexing is the honest
//   `recovering` state, as crates/server/src/http/health.rs does without a
//   database; no indexing read is attempted against unmigrated storage.
// - With storage ready the Workers composition serves read, stats, follows,
//   notify and indexing (stage `backend`, api/examples/meta.json).
//   `publication` is added only for an owned, non-fixture prefix plus
//   ownership evidence (AppConfig.publication, namespace.rs
//   require_publication); the SPA write path is then live, so the stage is
//   `product`.
// - `lexiconPrefix` is the configured prefix, or null with the gate closed.
// - `indexing` is the DO's global Indexing truth.
// - The Node composition (ADR 0005 B14, B18) adds the v1.2 capabilities its
//   `meta` service lists (`ctx.app.meta`, built by node/features.ts from what
//   the production list wires: `writes` with the publication gate open,
//   `lastfm`, `listenbrainz` and `imports`, and `forwarding` only with the
//   owner's Last.fm key), after the v1.1 ones and in ACCOUNT_CAPABILITIES
//   order. Its stage reflects that composition: `product` exactly when it
//   writes (`writes`), else `backend`. A composition without the service (the
//   Workers entry, a test composition) keeps the ADR 0004 rule: `product` with
//   publication.
//
// Which config applies is the composition's choice, not this route's: the
// IndexDO parses AppConfig once in buildDeps (strict in production; the test
// entries' TestIndexDO passes allowFixturePrefix), and a DO whose parse fails
// cannot answer ready(), so meta is then `scaffold`. The Worker fetch path is
// shared by the production and test entries, so this route never re-parses or
// refuses config; it reads only the two namespace vars the DO's parse reads.
// namespaceView(env) equals `{prefix, publication}` of every AppConfig that
// parseConfig accepts for that env (health-meta.test.ts proves this), and the
// fixture prefix never yields publication.

import {
  ACCOUNT_CAPABILITIES,
  type AccountCapability,
  type Capability,
  type Indexing,
  type Meta,
  type MetaStage,
} from '@atmusic/core/api-types';
import { type AppConfig, FIXTURE_PREFIX, isValidPrefix } from '../config';
import type { EnvVars } from '../env';
import { json } from './json';
import type { RequestCtx, RouteDef } from './types';

/** What the Node composition initialised beyond the v1.1 capabilities (node/features.ts). */
export interface MetaService {
  readonly capabilities: readonly AccountCapability[];
}

declare module '../app/services' {
  interface AppServices {
    meta?: MetaService;
  }
}

/** The application version (the Rust workspace version, Cargo.toml). */
export const APP_VERSION = '0.1.0';

export const BASE_CAPABILITIES: readonly Capability[] = ['read', 'stats', 'follows', 'notify', 'indexing'];

export const RECOVERING: Readonly<Indexing> = {
  state: 'recovering',
  caughtUp: false,
  lastIndexedAt: null,
  lagSeconds: null,
};

/** The namespace fields of AppConfig that meta reports. */
export type NamespaceView = Pick<AppConfig, 'prefix' | 'publication'>;

/**
 * The namespace exactly as parseConfig derives it, without refusing anything:
 * an empty or invalid prefix gives null (an invalid one also fails the DO's
 * parse, so meta is `scaffold`), and publication needs an owned, non-fixture
 * prefix plus ownership evidence.
 */
export function namespaceView(env: Pick<EnvVars, 'LEXICON_PREFIX' | 'NAMESPACE_OWNERSHIP_REF'>): NamespaceView {
  const raw = (env.LEXICON_PREFIX ?? '').trim();
  const prefix = raw !== '' && isValidPrefix(raw) ? raw : null;
  const evidence = (env.NAMESPACE_OWNERSHIP_REF ?? '').trim() !== '';
  return { prefix, publication: prefix !== null && prefix !== FIXTURE_PREFIX && evidence };
}

/**
 * `composition`: the v1.2 capabilities the Node composition initialised
 * (`ctx.app.meta.capabilities`), or null where there is no such service.
 */
export function buildMeta(
  namespace: NamespaceView,
  storageReady: boolean,
  indexing: Indexing,
  composition: readonly AccountCapability[] | null = null,
): Meta {
  if (!storageReady) {
    return {
      name: 'atproto_music',
      version: APP_VERSION,
      stage: 'scaffold',
      capabilities: [],
      lexiconPrefix: namespace.prefix,
      indexing: { ...RECOVERING },
    };
  }
  const capabilities: Capability[] = [...BASE_CAPABILITIES];
  if (namespace.publication) capabilities.push('publication');
  if (composition !== null) {
    for (const capability of ACCOUNT_CAPABILITIES) {
      if (composition.includes(capability)) capabilities.push(capability);
    }
  }
  const writes = composition === null ? namespace.publication : composition.includes('writes');
  const stage: MetaStage = writes ? 'product' : 'backend';
  return {
    name: 'atproto_music',
    version: APP_VERSION,
    stage,
    capabilities,
    lexiconPrefix: namespace.prefix,
    indexing,
  };
}

export async function meta(_req: Request, ctx: RequestCtx): Promise<Response> {
  let storageReady = false;
  try {
    storageReady = (await ctx.index.ready()).status === 'ready';
  } catch {
    storageReady = false;
  }
  const indexing = storageReady ? await ctx.index.indexing() : RECOVERING;
  const composition = ctx.app?.meta?.capabilities ?? null;
  return json(buildMeta(namespaceView(ctx.env), storageReady, indexing, composition), 200);
}

export const routes: RouteDef[] = [{ method: 'GET', pattern: '/api/v1/meta', handler: meta }];
