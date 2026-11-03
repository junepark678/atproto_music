// Exercises the pinned lastfm-ts-api package as a desktop client. The e2e
// runner starts this file with the HTTPS loopback preload and services its
// authorization notification through the fake Last.fm process.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const client = require('lastfm-ts-api') as {
  LastFMAuth: new (...args: unknown[]) => { getToken(): Promise<unknown>; getSession(params: { token: string }): Promise<unknown> };
  LastFMTrack: new (...args: unknown[]) => { scrobbleMany(items: unknown[]): Promise<unknown>; updateNowPlaying(params: unknown): Promise<unknown> };
  LastFMUser: new (...args: unknown[]) => { getRecentTracks(params: unknown): Promise<unknown> };
};

const API_KEY = 'e2e-lastfm-api-key';
const API_SECRET = 'e2e-lastfm-api-secret';
const USER = 'e2e-lastfm-user';

function send(value: unknown): void {
  if (!process.send?.(value)) throw new Error('Last.fm client requires the e2e IPC parent');
}

let nextId = 0;
const pending = new Map<number, () => void>();
process.on('message', (raw: unknown) => {
  const message = raw as { type?: unknown; id?: unknown };
  if (message.type === 'answer' && typeof message.id === 'number') {
    pending.get(message.id)?.();
    pending.delete(message.id);
  }
});

async function waitForAuthorization(token: string): Promise<void> {
  const id = ++nextId;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timed out waiting for fake Last.fm desktop authorization'));
    }, 10_000);
    pending.set(id, () => {
      clearTimeout(timeout);
      resolve();
    });
    send({ type: 'command', id, action: 'authorizeLastfmToken', token, user: USER });
  });
}

async function main(): Promise<void> {
  const config = { hostname: 'music.214510.xyz', path: '/2.0/' };
  const auth = new client.LastFMAuth(API_KEY, API_SECRET, undefined, config);
  const tokenResult = await auth.getToken();
  const token = typeof tokenResult === 'string'
    ? tokenResult
    : String((tokenResult as { token?: unknown })?.token ?? '');
  if (!token) throw new Error('lastfm-ts-api auth.getToken returned no token');
  await waitForAuthorization(token);

  const sessionResult = await auth.getSession({ token });
  const session = (sessionResult as { session?: { key?: string; name?: string } })?.session ?? sessionResult as { key?: string; name?: string };
  if (!session?.key) throw new Error('lastfm-ts-api auth.getSession returned no session key');

  const track = new client.LastFMTrack(API_KEY, API_SECRET, session.key, config);
  const user = new client.LastFMUser(API_KEY, API_SECRET, session.key, config);
  const now = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
  await track.scrobbleMany([
    { artist: 'E2E Artist', track: 'First Track', timestamp: now - 120 },
    { artist: 'E2E Artist', track: 'Second Track', timestamp: now - 60 },
  ]);
  await track.updateNowPlaying({
    artist: 'E2E Artist',
    track: 'Now Playing',
  });
  const recent = await user.getRecentTracks({ user: session.name ?? USER, limit: 10 });

  send({ type: 'answer', id: 0, result: { token, session: session.name ?? USER, recent } });
}

main().catch((error: unknown) => {
  send({ type: 'error', error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});
