// GET /health/live and GET /health/ready (API.md, M1.4.2 as amended by A1).
//
// Live is answered locally and never touches the IndexDO. Ready asks the DO
// for its schema state: `ready` is 200 `{status:'ready'}`; `too_new` (storage
// written by newer code), or a DO that cannot answer, is 503 `not_ready`.

import type { HealthLive, HealthReady } from '@atmusic/core/api-types';
import { DEFAULT_STATUS } from '@atmusic/core/errors';
import { errorResponse } from './error';
import { json } from './json';
import type { RequestCtx, RouteDef } from './types';

export async function live(): Promise<Response> {
  const body: HealthLive = { status: 'live' };
  return json(body, 200);
}

export async function ready(_req: Request, ctx: RequestCtx): Promise<Response> {
  let status: 'ready' | 'too_new' | 'unavailable';
  try {
    status = (await ctx.index.ready()).status;
  } catch {
    status = 'unavailable';
  }
  if (status !== 'ready') return errorResponse('not_ready', DEFAULT_STATUS.not_ready, ctx.requestId);
  const body: HealthReady = { status: 'ready' };
  return json(body, 200);
}

export const routes: RouteDef[] = [
  { method: 'GET', pattern: '/health/live', handler: live },
  { method: 'GET', pattern: '/health/ready', handler: ready },
];
