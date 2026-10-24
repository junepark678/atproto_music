// Route contract (ADR 0004 §4.3, §4.4). Frozen in Wave 0.
// Each worker/src/http/<name>.ts exports `routes: RouteDef[]`; only
// worker/src/router.ts (W5-01) concatenates them.

import type { Clock } from '@atmusic/core/deps';
import type { IndexRpc } from '../do/contracts';
import type { Env } from '../env';

export interface RequestCtx {
  env: Env;
  index: IndexRpc;
  requestId: string;
  clock: Clock;
  /** HMAC key derived from CURSOR_KEY, imported once per isolate. */
  cursorKey: CryptoKey;
  /** From CF-Connecting-IP after inbound x-atmusic-* headers are stripped. */
  clientIp: string;
}

export interface RouteDef {
  method: 'GET' | 'POST';
  /** Path pattern with `{name}` segments, e.g. `/api/v1/users/{did}/stats`. */
  pattern: string;
  handler(req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response>;
}
