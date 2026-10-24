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
//   `publication` is added only when the config has an owned, non-fixture
//   prefix plus ownership evidence (AppConfig.publication, namespace.rs
//   require_publication); the SPA write path is then live, so the stage is
//   `product`.
// - `lexiconPrefix` is the configured prefix, or null with the gate closed.
// - `indexing` is the DO's global Indexing truth.

import type { Capability, Indexing, Meta, MetaStage } from '@atmusic/core/api-types';
import { type AppConfig, parseConfig } from '../config';
import type { Env } from '../env';
import { json } from './json';
import type { RequestCtx, RouteDef } from './types';

/** The application version (the Rust workspace version, Cargo.toml). */
export const APP_VERSION = '0.1.0';

export const BASE_CAPABILITIES: readonly Capability[] = ['read', 'stats', 'follows', 'notify', 'indexing'];

export const RECOVERING: Readonly<Indexing> = {
  state: 'recovering',
  caughtUp: false,
  lastIndexedAt: null,
  lagSeconds: null,
};

export type ConfigSource = (env: Env) => AppConfig;

const parsed = new WeakMap<Env, AppConfig>();

/** Production config source: the strict parseConfig (fixture prefix refused), once per env object. */
export const strictConfig: ConfigSource = (env) => {
  let config = parsed.get(env);
  if (config === undefined) {
    config = parseConfig(env);
    parsed.set(env, config);
  }
  return config;
};

export function buildMeta(config: AppConfig, storageReady: boolean, indexing: Indexing): Meta {
  if (!storageReady) {
    return {
      name: 'atproto_music',
      version: APP_VERSION,
      stage: 'scaffold',
      capabilities: [],
      lexiconPrefix: config.prefix,
      indexing: { ...RECOVERING },
    };
  }
  const capabilities: Capability[] = [...BASE_CAPABILITIES];
  if (config.publication) capabilities.push('publication');
  const stage: MetaStage = config.publication ? 'product' : 'backend';
  return { name: 'atproto_music', version: APP_VERSION, stage, capabilities, lexiconPrefix: config.prefix, indexing };
}

/**
 * The meta routes over a config source. RequestCtx carries no AppConfig, so
 * the config is derived from `ctx.env`; `routes` uses the strict production
 * parse, and only test entries build their own with `allowFixturePrefix`.
 */
export function createMetaRoutes(configFor: ConfigSource = strictConfig): RouteDef[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/meta',
      async handler(_req: Request, ctx: RequestCtx): Promise<Response> {
        const config = configFor(ctx.env);
        let storageReady = false;
        try {
          storageReady = (await ctx.index.ready()).status === 'ready';
        } catch {
          storageReady = false;
        }
        const indexing = storageReady ? await ctx.index.indexing() : RECOVERING;
        return json(buildMeta(config, storageReady, indexing), 200);
      },
    },
  ];
}

export const routes: RouteDef[] = createMetaRoutes();
