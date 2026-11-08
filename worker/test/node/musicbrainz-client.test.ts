import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { createMusicBrainzClient, escapeLucene, MB_CAPS } from '../../src/musicbrainz/client';
import { bindPolicyFetch, createPolicyFetch } from '../../src/node/policy-fetch';
import { FakeMusicBrainz, MUSICBRAINZ_HOST } from './support/fake-musicbrainz';

const ROOT = `https://${MUSICBRAINZ_HOST}/ws/2/`;

function client(fake: FakeMusicBrainz) {
  const clock = fixedClock();
  expect(clock.nowMs()).toBe(Date.parse('2026-01-15T12:00:00Z'));
  const transport = routerTransport({ hosts: { [MUSICBRAINZ_HOST]: fake } });
  return createMusicBrainzClient({
    fetch: bindPolicyFetch(createPolicyFetch({ transport }), MB_CAPS),
    apiRoot: ROOT,
    version: '1.2.3',
  });
}

describe('MusicBrainz client', () => {
  it('looks up recording MBIDs with JSON format, required includes, and repository-only user agent', async () => {
    const fake = new FakeMusicBrainz();
    fake.response = { status: 200, body: { id: 'recording-id', title: 'Song' } };
    const result = await client(fake).lookupRecording('recording-id');
    expect(result).toEqual({ kind: 'ok', value: { id: 'recording-id', title: 'Song' } });
    expect(fake.requests[0]?.path).toBe('/ws/2/recording/recording-id');
    expect(fake.requests[0]?.params.get('fmt')).toBe('json');
    expect(fake.requests[0]?.params.get('inc')).toBe('artists+releases+release-groups+isrcs');
    expect(fake.requests[0]?.headers.get('user-agent')).toBe(
      'atmusic/1.2.3 ( https://github.com/junepark678/atproto_music )',
    );
    expect(fake.requests[0]?.headers.get('user-agent')).not.toMatch(/@|did:|email/i);
  });

  it('builds an escaped Lucene search with fmt=json and a bounded default result count', async () => {
    const fake = new FakeMusicBrainz();
    fake.response = { status: 200, body: { recordings: [{ id: 'r1' }], count: 1, offset: 0 } };
    const result = await client(fake).searchRecordings({
      artist: 'A/B',
      recording: 'A "Song" + One',
      release: 'Album (Deluxe)',
    });
    expect(result.kind).toBe('ok');
    expect(fake.requests[0]?.params.get('fmt')).toBe('json');
    expect(fake.requests[0]?.params.get('limit')).toBe('5');
    expect(fake.requests[0]?.params.get('query')).toBe(
      'recording:"A \\"Song\\" \\+ One" AND artist:"A\\/B" AND release:"Album \\(Deluxe\\)"',
    );
    expect(escapeLucene('x:y')).toBe('x\\:y');
  });

  it('classifies 404, other statuses, malformed JSON shapes, and transport failures', async () => {
    const fake = new FakeMusicBrainz();
    fake.response = { status: 404, body: { error: 'not found' } };
    expect(await client(fake).lookupRecording('missing')).toEqual({ kind: 'not_found' });
    fake.response = { status: 503, body: { error: 'busy' } };
    expect(await client(fake).searchRecordings({ artist: 'A', recording: 'T' })).toEqual({
      kind: 'status',
      status: 503,
    });
    fake.response = { status: 200, body: '{not json' };
    expect(await client(fake).searchRecordings({ artist: 'A', recording: 'T' })).toEqual({ kind: 'malformed' });
    fake.response = { status: 200, body: { results: [] } };
    expect(await client(fake).searchRecordings({ artist: 'A', recording: 'T' })).toEqual({ kind: 'malformed' });
    const offline = createMusicBrainzClient({
      fetch: bindPolicyFetch(createPolicyFetch({ transport: routerTransport({}) }), MB_CAPS),
      apiRoot: ROOT,
      version: '1.2.3',
    });
    expect(await offline.lookupRecording('x')).toEqual({ kind: 'network' });
  });
});
