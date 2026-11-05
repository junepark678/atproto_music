// Shared app-side helpers for the integrated N8 client replays. Responses and
// transport failures are deliberately reduced to fixed diagnostics so that
// cookies, OAuth parameters, API keys, and client credentials cannot escape.

import type { LocalCookieJar } from './cookie-jar';
import { jsonWithoutLeak } from './safe-http';

export const REPLAY_APP_ERROR = 'scrobbler e2e app protocol failed';

export interface ReplayReply {
  status: number;
  body: unknown;
}

export async function replayAppRequest(
  jar: LocalCookieJar,
  path: string,
  init: RequestInit = {},
  acceptedStatuses: readonly number[] = [200],
): Promise<ReplayReply> {
  let response: Response;
  try {
    response = await jar.request(path, init);
  } catch {
    throw new Error(REPLAY_APP_ERROR);
  }
  if (!acceptedStatuses.includes(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(REPLAY_APP_ERROR);
  }
  return { status: response.status, body: await jsonWithoutLeak(response, 'scrobbler e2e app') };
}

export async function replayAppJson(
  jar: LocalCookieJar,
  path: string,
  value: unknown,
  options: {
    method?: 'POST' | 'PUT' | 'PATCH';
    csrfToken: string;
    publicOrigin: string;
    acceptedStatuses?: readonly number[];
  },
): Promise<ReplayReply> {
  let body: string;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    body = serialized;
  } catch {
    throw new Error(REPLAY_APP_ERROR);
  }
  return replayAppRequest(
    jar,
    path,
    {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        origin: options.publicOrigin,
        'x-csrf-token': options.csrfToken,
      },
      body,
    },
    options.acceptedStatuses ?? [200, 201],
  );
}

export function replayObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(REPLAY_APP_ERROR);
  return value as Record<string, unknown>;
}

export function replayString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(REPLAY_APP_ERROR);
  return value;
}

export function replayNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(REPLAY_APP_ERROR);
  return value;
}
