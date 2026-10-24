// Test-only Durable Object: real DO SQLite with the production migrations
// applied in its constructor, as IndexDO does (ADR 0004 §6, §10.1). Module
// tests reach its storage through runInDurableObject and `doDb`.

import { DurableObject } from 'cloudflare:workers';
import { type Db, doDb } from '../../src/do/db';
import { type MigrateResult, migrate } from '../../src/do/migrate';
import type { EnvSecrets, EnvVars } from '../../src/env';

export interface HarnessEnv extends EnvVars, Pick<EnvSecrets, 'CURSOR_KEY'> {
  HARNESS: DurableObjectNamespace<HarnessDO>;
}

declare global {
  namespace Cloudflare {
    interface Env extends HarnessEnv {}
    interface GlobalProps {
      // Spelled out rather than `typeof import('./entry')`, which is circular.
      mainModule: { default: ExportedHandler<HarnessEnv>; HarnessDO: typeof HarnessDO };
    }
  }
}

export class HarnessDO extends DurableObject<HarnessEnv> {
  readonly db: Db;
  /** Set before any request is delivered (blockConcurrencyWhile). */
  migration: MigrateResult | null = null;

  constructor(ctx: DurableObjectState, env: HarnessEnv) {
    super(ctx, env);
    this.db = doDb(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      this.migration = migrate(ctx.storage);
    });
  }

  override async fetch(): Promise<Response> {
    return Response.json({ migration: this.migration });
  }
}
