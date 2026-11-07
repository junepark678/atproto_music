import type { ScrobbleBatchRecord } from '@atmusic/core/scrobble-batch';
import { MAX_CBOR_BYTES, MAX_CREATE_BODY_BYTES } from '@atmusic/core/scrobble-batch';
import { describe, expect, it } from 'vitest';
import { fitsScrobbleBatch, measureScrobbleBatch } from '../src/scrobble-batch-size';

const record = {
  $type: 'org.example.music.scrobbleBatch',
  createdAt: '2026-01-15T12:00:00.000Z',
  listens: [
    {
      id: '3jzfcijpj2z2a',
      artist: 'Björk',
      track: 'Jóga',
      listenedAt: '2026-01-15T11:59:00.000Z',
      createdAt: '2026-01-15T12:00:00.000Z',
    },
  ],
};

describe('scrobbleBatch size', () => {
  it('counts DAG-CBOR and exact UTF-8 JSON request bytes', () => {
    const measured = measureScrobbleBatch(record, {
      repo: 'did:plc:abcdefghijklmnopqrstuvwx',
      collection: 'org.example.music.scrobbleBatch',
      rkey: '3jzfcijpj2z2a',
    });
    const expectedBody = JSON.stringify({
      ...{
        repo: 'did:plc:abcdefghijklmnopqrstuvwx',
        collection: 'org.example.music.scrobbleBatch',
        rkey: '3jzfcijpj2z2a',
      },
      record,
    });
    expect(measured.createBodyBytes).toBe(new TextEncoder().encode(expectedBody).byteLength);
    expect(measured.cborBytes).toBeGreaterThan(0);
    expect(fitsScrobbleBatch(measured)).toBe(true);
  });

  it('uses inclusive exact bounds', () => {
    expect(fitsScrobbleBatch({ cborBytes: MAX_CBOR_BYTES, createBodyBytes: MAX_CREATE_BODY_BYTES })).toBe(true);
    expect(fitsScrobbleBatch({ cborBytes: MAX_CBOR_BYTES + 1, createBodyBytes: 1 })).toBe(false);
    expect(fitsScrobbleBatch({ cborBytes: 1, createBodyBytes: MAX_CREATE_BODY_BYTES + 1 })).toBe(false);
  });

  it('counts non-ASCII as UTF-8 bytes rather than JS string length', () => {
    const unicodeRecord: ScrobbleBatchRecord = { ...record, listens: [{ ...record.listens[0]!, artist: '🎵' }] };
    const measured = measureScrobbleBatch(unicodeRecord, {
      repo: 'did:plc:abcdefghijklmnopqrstuvwx',
      collection: 'org.example.music.scrobbleBatch',
      rkey: '3jzfcijpj2z2a',
    });
    expect(measured.createBodyBytes).toBeGreaterThan(JSON.stringify(unicodeRecord).length);
  });
});
