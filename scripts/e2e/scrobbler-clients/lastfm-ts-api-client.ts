// Exercises the pinned lastfm-ts-api package as a desktop client against the
// e2e bundle. The parent handles the app's signed-in approval route over IPC;
// this child never stores credentials in output or sends them to a fake AS.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const client = require('lastfm-ts-api') as {
  LastFMAuth: new (
    apiKey: string,
    secret: string,
    callback?: unknown,
    config?: { hostname: string; path: string },
  ) => { getToken(): Promise<unknown>; getSession(params: { token: string }): Promise<unknown> };
  LastFMTrack: new (
    apiKey: string,
    secret: string,
    sessionKey: string,
    config?: { hostname: string; path: string },
  ) => { scrobbleMany(items: unknown[]): Promise<unknown>; updateNowPlaying(params: unknown): Promise<unknown> };
  LastFMUser: new (
    apiKey: string,
    secret: string,
    sessionKey: string,
    config?: { hostname: string; path: string },
  ) => { getRecentTracks(params: unknown): Promise<unknown> };
};

const HOST = 'music.214510.xyz';
const USER = process.env.ATMUSIC_E2E_LASTFM_USER;
const API_KEY = process.env.ATMUSIC_E2E_LASTFM_API_KEY;
const API_SECRET = process.env.ATMUSIC_E2E_LASTFM_SHARED_SECRET;
const APPROVAL_TIMEOUT_MS = 15_000;

interface PendingApproval {
  resolve: () => void;
  reject: () => void;
  timeout: NodeJS.Timeout;
}

let nextId = 0;
const pending = new Map<number, PendingApproval>();

function send(value: unknown): void {
  if (!process.send?.(value)) throw new Error('client IPC unavailable');
}

process.on('message', (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return;
  const message = raw as { type?: unknown; id?: unknown; result?: unknown };
  if (message.type !== 'answer' || typeof message.id !== 'number') return;
  if (message.id === 0) return;
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timeout);
  pending.delete(message.id);
  if (message.result === true) request.resolve();
  else request.reject();
});

function requestApproval(token: string): Promise<void> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('approval timeout'));
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    send({ type: 'command', id, action: 'approveLastfmToken', apiKey: API_KEY, token });
  });
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) throw new Error('invalid response');
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== 'string' || field.length === 0) throw new Error('invalid response');
  return field;
}

async function main(): Promise<void> {
  if (!API_KEY || !API_SECRET || !USER) throw new Error('missing client configuration');
  const config = { hostname: HOST, path: '/2.0/' };
  const auth = new client.LastFMAuth(API_KEY, API_SECRET, undefined, config);
  const token = stringField(await auth.getToken(), 'token');
  await requestApproval(token);

  const sessionResult = await auth.getSession({ token });
  const session =
    typeof sessionResult === 'object' && sessionResult !== null && 'session' in sessionResult
      ? (sessionResult as { session?: unknown }).session
      : sessionResult;
  const sessionKey = stringField(session, 'key');
  const sessionName = stringField(session, 'name');

  const track = new client.LastFMTrack(API_KEY, API_SECRET, sessionKey, config);
  const user = new client.LastFMUser(API_KEY, API_SECRET, sessionKey, config);
  const now = Math.floor(Number(process.env.ATMUSIC_E2E_NOW_MS ?? Date.UTC(2026, 0, 15, 12, 0, 0)) / 1000);
  await track.scrobbleMany([
    { artist: 'E2E Artist', track: 'First Track', timestamp: now - 120 },
    { artist: 'E2E Artist', track: 'Second Track', timestamp: now - 60 },
  ]);
  await track.updateNowPlaying({ artist: 'E2E Artist', track: 'Now Playing' });
  const recent = await user.getRecentTracks({ user: sessionName || USER, limit: 10 });
  const recentTracks =
    typeof recent === 'object' && recent !== null && 'recenttracks' in recent
      ? (recent as { recenttracks?: { track?: unknown } }).recenttracks?.track
      : undefined;
  if (!Array.isArray(recentTracks)) throw new Error('invalid read response');

  // Return only the assertions the parent needs. Never return the redeemable
  // auth token, session key, API credentials, or raw library response.
  send({
    type: 'answer',
    id: 0,
    result: {
      sessionEstablished: true,
      scrobbleBatchSize: 2,
      recentTrackCount: recentTracks.length,
      recentTrackNames: recentTracks.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const name = (item as Record<string, unknown>).name;
        return typeof name === 'string' ? [name] : [];
      }),
    },
  });
  process.disconnect?.();
}

main().catch(() => {
  for (const request of pending.values()) clearTimeout(request.timeout);
  pending.clear();
  send({ type: 'error', error: 'lastfm-ts-api client failed' });
  process.disconnect?.();
  process.exitCode = 1;
});
