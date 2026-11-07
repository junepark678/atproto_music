import { describe, expect, it } from 'vitest';
import {
  formatLocalDate,
  formatLocalTime,
  localInputToUtc,
  scrubDids,
  toLocalInput,
  zoneName,
} from '../../src/components/format';
import { emptyForm, formInput, validateForm } from '../../src/routes/scrobble';
import { setTimeZone } from '../setup';

const AT = Date.UTC(2026, 0, 15, 11, 0, 0); // 2026-01-15T11:00:00Z
const clock = { nowMs: () => AT };
const values = (listenedAt: string) => ({
  artist: 'Artist',
  track: 'Track',
  album: '',
  listenedAt,
  durationSeconds: '',
  recordingMbid: '',
});

describe('web/test/components/local-time.test.ts', () => {
  it('renders times in the pinned UTC zone with the viewer locale formatter', () => {
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(AT);
    expect(formatLocalTime('2026-01-15T11:00:00Z')).toBe(expected);
    expect(formatLocalTime('not a time')).toBe('not a time');
    expect(toLocalInput(AT)).toBe('2026-01-15T11:00:00');
  });

  it('Asia/Seoul renders local times and the scrobble form round-trips local input to the UTC instant', () => {
    setTimeZone('Asia/Seoul');
    const shown = formatLocalTime('2026-01-15T11:00:00Z', { zone: true });
    expect(shown).toBe(
      `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(AT)} ${zoneName(AT)}`,
    );
    expect(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23' }).format(AT)).toBe('20');
    expect(zoneName(AT)).toMatch(/\+9|KST/);
    expect(formatLocalDate('2026-01-15T20:00:00Z')).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(Date.UTC(2026, 0, 16)),
    );

    // The form is prefilled with local now and sends the UTC instant.
    expect(emptyForm(clock).listenedAt).toBe('2026-01-15T20:00:00');
    expect(formInput(values('2026-01-15T20:00:00')).input.listenedAt).toBe('2026-01-15T11:00:00Z');
    expect(formInput(values('2026-01-15T20:00')).input.listenedAt).toBe('2026-01-15T11:00:00Z');
    expect(localInputToUtc('2026-01-15T11:00:00Z')).toBe('2026-01-15T11:00:00Z');

    // At most 5 minutes in the future, measured on the converted instant.
    expect(validateForm(values('2026-01-15T20:04:00'), 'com.example.atmusic', clock).listenedAt).toBeUndefined();
    expect(validateForm(values('2026-01-15T20:06:00'), 'com.example.atmusic', clock).listenedAt).toBeDefined();
  });

  it('scrubs DIDs from server-provided text', () => {
    expect(scrubDids('cannot follow did:plc:aaaaaaaaaaaaaaaaaaaaaaaa or did:web:music.example.com.')).toBe(
      'cannot follow an account or an account.',
    );
  });
});
