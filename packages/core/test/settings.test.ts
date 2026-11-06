/// <reference types="vite/client" />
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { MSG_REQUIRED_STRING } from '@atmusic/core/scrobble';
import {
  buildSettingsRecord,
  INDEXING_VALUES,
  MSG_INDEXING,
  MSG_SETTINGS_RKEY,
  MSG_SETTINGS_TYPE,
  SETTINGS_RKEY,
  validateSettingsRecord,
} from '@atmusic/core/settings';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { MSG_BOUNDS } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import settingsLexicon from '../../../lexicons/settings.json?raw';

const P = FIXTURE_PREFIX;
const RECEIPT_NS = 1_768_478_400_000_000_000n; // 2026-01-15T12:00:00Z
const err = (field: string, message: string) => ({ ok: false, reason: { field, code: 'invalid_field', message } });
const remote = (over: Record<string, unknown> = {}) => ({
  $type: `${P}.settings`,
  indexing: 'disabled',
  createdAt: '2026-01-15T11:00:00Z',
  ...over,
});

it('settings record requires key self and indexing enum', () => {
  // The constants follow the lexicon (key literal:self, indexing enum).
  const lexicon = JSON.parse(settingsLexicon);
  expect(lexicon.id).toBe(`${P}.settings`);
  expect(lexicon.defs.main.key).toBe(`literal:${SETTINGS_RKEY}`);
  expect(lexicon.defs.main.record.properties.indexing.enum).toEqual([...INDEXING_VALUES]);
  expect(lexicon.defs.main.record.required).toEqual(['indexing', 'createdAt']);

  for (const indexing of ['enabled', 'disabled']) {
    expect(validateSettingsRecord(remote({ indexing }), P, RECEIPT_NS, 'self')).toEqual({
      ok: true,
      row: {
        record: remote({ indexing }),
        indexing,
        createdAt: '2026-01-15T11:00:00.000000000Z',
        createdAtNs: 1_768_474_800_000_000_000n,
      },
    });
  }
  // Any other record key is not the settings record.
  for (const rkey of ['3jzfcijpj2z2a', 'Self', 'self ', 'settings', '']) {
    expect(validateSettingsRecord(remote(), P, RECEIPT_NS, rkey)).toEqual(err('rkey', MSG_SETTINGS_RKEY));
  }
  // indexing must be exactly one of the enum values.
  for (const indexing of ['paused', 'Disabled', '', ' disabled']) {
    expect(validateSettingsRecord(remote({ indexing }), P, RECEIPT_NS, 'self')).toEqual(err('indexing', MSG_INDEXING));
  }
  for (const indexing of [false, 0, null]) {
    expect(validateSettingsRecord(remote({ indexing }), P, RECEIPT_NS, 'self')).toEqual(
      err('indexing', MSG_REQUIRED_STRING),
    );
  }
  const { indexing: _i, ...noIndexing } = remote();
  expect(validateSettingsRecord(noIndexing, P, RECEIPT_NS, 'self')).toEqual(err('indexing', MSG_REQUIRED_STRING));
  // $type and createdAt follow the shared record rules.
  expect(validateSettingsRecord(remote({ $type: `${P}.scrobble` }), P, RECEIPT_NS, 'self')).toEqual(
    err('$type', MSG_SETTINGS_TYPE),
  );
  const { createdAt: _c, ...noCreatedAt } = remote();
  expect(validateSettingsRecord(noCreatedAt, P, RECEIPT_NS, 'self')).toEqual(err('createdAt', MSG_REQUIRED_STRING));
  expect(validateSettingsRecord(remote({ createdAt: '2026-01-15T12:05:00Z' }), P, RECEIPT_NS, 'self').ok).toBe(true);
  expect(validateSettingsRecord(remote({ createdAt: '2026-01-15T12:05:01Z' }), P, RECEIPT_NS, 'self')).toEqual(
    err('createdAt', MSG_BOUNDS),
  );
  expect(validateSettingsRecord('disabled', P, RECEIPT_NS, 'self')).toEqual(err('body', 'expected a JSON object'));
  // Open lexicon object: unknown fields are ignored and dropped.
  const extended = validateSettingsRecord(remote({ reason: 'privacy' }), P, RECEIPT_NS, 'self');
  expect(extended.ok && extended.row.record).toEqual(remote());

  // The SPA's disconnect/reconnect record, written at SETTINGS_RKEY.
  const clock = fixedClock();
  const built = buildSettingsRecord('disabled', P, clock);
  expect(built).toEqual({
    ok: true,
    record: { $type: 'com.example.atmusic.settings', indexing: 'disabled', createdAt: '2026-01-15T12:00:00Z' },
  });
  if (!built.ok) throw new Error('unreachable');
  expect(validateSettingsRecord(built.record, P, RECEIPT_NS, SETTINGS_RKEY)).toMatchObject({
    ok: true,
    row: { indexing: 'disabled' },
  });
  expect(buildSettingsRecord('enabled', P, clock)).toMatchObject({ ok: true, record: { indexing: 'enabled' } });
  expect(buildSettingsRecord('off', P, clock)).toEqual(err('indexing', MSG_INDEXING));
  expect(buildSettingsRecord(true, P, clock)).toEqual(err('indexing', MSG_INDEXING));
  expect(() => buildSettingsRecord('disabled', 'NotAPrefix', clock)).toThrow(RangeError);
});
