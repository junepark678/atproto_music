import { encode } from '@atcute/cbor';
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

  it('checks independently encoded records immediately below and above each byte cap', () => {
    const request = {
      repo: 'did:plc:abcdefghijklmnopqrstuvwx',
      collection: 'org.example.music.scrobbleBatch',
      rkey: '3jzfcijpj2z2a',
    };
    const independent = (candidate: ScrobbleBatchRecord) => ({
      cborBytes: new Uint8Array(encode(candidate)).byteLength,
      createBodyBytes: new TextEncoder().encode(JSON.stringify({ ...request, record: candidate })).byteLength,
    });
    const make = (track: string): ScrobbleBatchRecord => ({
      ...record,
      listens: [{ ...record.listens[0]!, track }],
    });
    const largest = (limit: number, size: (candidate: ScrobbleBatchRecord) => number, char: string) => {
      let low = 0;
      let high = limit + 1;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (size(make(char.repeat(middle))) <= limit) low = middle;
        else high = middle;
      }
      return low;
    };

    const cborLength = largest(MAX_CBOR_BYTES, (candidate) => independent(candidate).cborBytes, 'x');
    const cborAt = make('x'.repeat(cborLength));
    const cborOver = make('x'.repeat(cborLength + 1));
    expect(independent(cborAt).cborBytes).toBeLessThanOrEqual(MAX_CBOR_BYTES);
    expect(independent(cborOver).cborBytes).toBeGreaterThan(MAX_CBOR_BYTES);
    expect(measureScrobbleBatch(cborAt, request)).toEqual(independent(cborAt));
    expect(fitsScrobbleBatch(measureScrobbleBatch(cborAt, request))).toBe(true);
    expect(fitsScrobbleBatch(measureScrobbleBatch(cborOver, request))).toBe(false);

    // Quotes add an extra JSON escape byte per code point while DAG-CBOR stores
    // each UTF-8 byte once, allowing the independent request-body cap to bind.
    const bodyLength = largest(MAX_CREATE_BODY_BYTES, (candidate) => independent(candidate).createBodyBytes, '"');
    const bodyAt = make('"'.repeat(bodyLength));
    const bodyOver = make('"'.repeat(bodyLength + 1));
    expect(independent(bodyAt).createBodyBytes).toBeLessThanOrEqual(MAX_CREATE_BODY_BYTES);
    expect(independent(bodyOver).createBodyBytes).toBeGreaterThan(MAX_CREATE_BODY_BYTES);
    expect(independent(bodyAt).cborBytes).toBeLessThan(MAX_CBOR_BYTES);
    expect(measureScrobbleBatch(bodyAt, request)).toEqual(independent(bodyAt));
    expect(fitsScrobbleBatch(measureScrobbleBatch(bodyAt, request))).toBe(true);
    expect(fitsScrobbleBatch(measureScrobbleBatch(bodyOver, request))).toBe(false);
  });
});
