// Scrobble form and publication states (W3-06; M7.2.2 form_validation /
// submit_retry / poll_terminal, M3.1.1 owner_and_validation, M3.4.1
// validation_matrix). The screen runs over the W2-07 outbox fixture: a real
// IndexedDB store (fake-indexeddb), the fake PDS behind a PdsSession, and a
// fake AppView whose records/status answers from the PDS. The runner is
// driven with `runDue()` and the frozen clock; nothing sleeps.

import { MSG_DISPLAY, MSG_DURATION, MSG_UUID } from '@atmusic/core/scrobble';
import { MSG_BOUNDS } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import { pollDelayMs } from '../../src/outbox/runner';
import {
  ALICE,
  buttonByText,
  click,
  type Mounted,
  mount,
  type OutboxWorld,
  outboxWorld,
  PREFIX,
  settle,
  text,
  type as typeInto,
  until,
} from './support';

const CREATE = 'com.atproto.repo.createRecord';
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function field(root: ParentNode, name: string): HTMLInputElement {
  const input = root.querySelector(`input[name="${name}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${name}`);
  return input;
}

function fieldErrors(root: ParentNode): Record<string, string> {
  return Object.fromEntries(
    Array.from(root.querySelectorAll('[data-field-error]')).map((el) => [
      el.getAttribute('data-field-error'),
      text(el),
    ]),
  );
}

function fill(root: ParentNode, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) typeInto(field(root, name), value);
}

async function openForm(world: OutboxWorld): Promise<HTMLElement> {
  mounted = mount('/scrobble', world.state, world.services);
  const main = mounted.main();
  await until(() => expect(main.querySelector('form')).not.toBeNull());
  return main;
}

/** Records every distinct (state, tone, text) the submission's status line shows. */
function recordStatuses(root: HTMLElement) {
  const seen: { state: string; tone: string; text: string }[] = [];
  const snap = () => {
    const el = root.querySelector('[data-op-id] .op-status');
    if (!el) return;
    const entry = {
      state: el.getAttribute('data-op-state') ?? '',
      tone: el.getAttribute('data-tone') ?? '',
      text: text(el),
    };
    const last = seen.at(-1);
    if (!last || last.state !== entry.state || last.text !== entry.text) seen.push(entry);
  };
  const observer = new MutationObserver(snap);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  return {
    seen,
    snap,
    stop: () => observer.disconnect(),
  };
}

async function submitValid(world: OutboxWorld, main: HTMLElement, track = 'Jóga') {
  fill(main, { artist: 'Björk', track, album: 'Homogenic', listenedAt: '2026-01-15T11:58:00Z' });
  click(buttonByText(main, 'Publish scrobble'));
  await until(async () => expect(await world.fx.store.count(ALICE)).toBe(1));
  const [op] = await world.fx.ops();
  await until(() => expect(main.querySelector(`[data-op-id="${op!.id}"]`)).not.toBeNull());
  return op!;
}

describe('web/test/routes/scrobble.test.tsx', () => {
  it('invalid input shows field errors and creates no outbox operation', async () => {
    const world = await outboxWorld();
    const main = await openForm(world);
    // The default listenedAt is the injected clock's instant.
    expect(field(main, 'listenedAt').value).toBe('2026-01-15T12:00:00Z');

    fill(main, {
      artist: 'Björk',
      track: '',
      album: '   ',
      listenedAt: '2026-01-15T12:05:01Z', // now + 301 s
      durationSeconds: '0',
      recordingMbid: 'not-a-uuid',
    });
    click(buttonByText(main, 'Publish scrobble'));
    await until(() => expect(Object.keys(fieldErrors(main))).toHaveLength(5));
    expect(fieldErrors(main)).toEqual({
      track: 'Enter the track.',
      album: MSG_DISPLAY,
      listenedAt: MSG_BOUNDS,
      durationSeconds: MSG_DURATION,
      recordingMbid: MSG_UUID,
    });
    expect(field(main, 'track').getAttribute('aria-invalid')).toBe('true');
    expect(field(main, 'track').getAttribute('aria-describedby')).toBe('track-error');
    expect(field(main, 'artist').hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(field(main, 'track'));

    // Other invalid values, one at a time: a fraction and an over-long duration.
    fill(main, { track: 'Jóga', album: '', listenedAt: '2026-01-15T12:00:00Z', recordingMbid: '' });
    fill(main, { durationSeconds: '1.5' });
    click(buttonByText(main, 'Publish scrobble'));
    await until(() => expect(fieldErrors(main)).toEqual({ durationSeconds: MSG_DURATION }));
    fill(main, { durationSeconds: '86401' });
    click(buttonByText(main, 'Publish scrobble'));
    await settle();
    expect(fieldErrors(main)).toEqual({ durationSeconds: MSG_DURATION });

    // Nothing was persisted or sent while any field was invalid.
    expect(await world.fx.store.count()).toBe(0);
    expect(world.fx.session.sent).toEqual([]);
    expect(world.api.count('POST /api/v1/notify')).toBe(0);
    expect(main.querySelector('[data-op-id]')).toBeNull();

    // Boundary values are valid: listenedAt = now + 300 s, duration 86400, a
    // White_Space-padded artist and an upper-case MBID (lowercased).
    fill(main, {
      artist: '  Björk  ',
      track: 'Jóga',
      album: 'Homogenic',
      listenedAt: '2026-01-15T12:05:00Z',
      durationSeconds: '86400',
      recordingMbid: '13F12616-51D7-4023-A70B-A288CED4693A',
    });
    click(buttonByText(main, 'Publish scrobble'));
    await until(async () => expect(await world.fx.store.count(ALICE)).toBe(1));
    expect(fieldErrors(main)).toEqual({});
    const [op] = await world.fx.ops();
    expect(op).toMatchObject({
      kind: 'scrobble_create',
      state: 'queued',
      attempts: 0,
      collection: `${PREFIX}.scrobble`,
    });
    expect(op!.record).toEqual({
      $type: `${PREFIX}.scrobble`,
      artist: 'Björk',
      track: 'Jóga',
      album: 'Homogenic',
      listenedAt: '2026-01-15T12:05:00.000000000Z',
      createdAt: op!.record!.createdAt,
      durationSeconds: 86400,
      recordingMbid: '13f12616-51d7-4023-a70b-a288ced4693a',
    });
    expect(String(op!.record!.createdAt).startsWith('2026-01-15T12:00:00')).toBe(true);
    expect(op!.uri).toBe(`at://${ALICE}/${PREFIX}.scrobble/${op!.rkey}`);
    // Persisted before any attempt: still no request to the PDS.
    expect(world.fx.session.sent).toEqual([]);
    await until(() => expect(text(main.querySelector(`[data-op-id="${op!.id}"] .op-status`))).toBe('Scrobble queued'));
    // The form was reset for the next scrobble.
    expect(field(main, 'track').value).toBe('');
  });

  it('status progresses queued→published→indexed from mocked records/status', async () => {
    const world = await outboxWorld();
    world.fx.appView.pendingPolls = 2;
    const main = await openForm(world);
    const statuses = recordStatuses(main);
    const op = await submitValid(world, main);
    statuses.snap();
    expect(statuses.seen.at(-1)).toEqual({ state: 'queued', tone: 'pending', text: 'Scrobble queued' });
    expect(world.services.ticker.active()).toBe(1);

    // One pass: createRecord, then notify {uri}; the AppView has not verified it yet.
    await world.outbox.runner.runDue();
    await until(() =>
      expect(statuses.seen.at(-1)).toEqual({
        state: 'published',
        tone: 'pending',
        text: 'Scrobble published to your PDS; waiting for the index',
      }),
    );
    expect(world.fx.session.sentTo(CREATE)).toHaveLength(1);
    expect(world.fx.session.sentTo(CREATE)[0]!.body).toMatchObject({ repo: ALICE, rkey: op.rkey, record: op.record });
    expect(world.fx.appView.notified).toEqual([{ uri: op.uri }]);
    expect(world.fx.appView.statusPolls).toEqual([]);

    // Two polls answer pending: still published, never claimed indexed.
    for (const polls of [0, 1]) {
      world.clock.advance(pollDelayMs(polls));
      await world.outbox.runner.runDue();
      await until(() => expect(world.fx.appView.statusPolls).toHaveLength(polls + 1));
      await settle();
      expect(statuses.seen.at(-1)?.state).toBe('published');
    }
    // The third poll sees the verified record.
    world.clock.advance(pollDelayMs(2));
    expect(await world.outbox.runner.runDue()).toBeNull();
    await until(() =>
      expect(statuses.seen.at(-1)).toEqual({
        state: 'indexed',
        tone: 'success',
        text: 'Indexed: visible in your public history',
      }),
    );
    statuses.stop();
    expect(world.fx.appView.statusPolls).toEqual([op.uri, op.uri, op.uri]);
    expect(await world.fx.store.get(op.id)).toMatchObject({ state: 'indexed', attempts: 1, dueAt: null });
    // The visible order: queued → (sending) → published → indexed, success only at the end.
    const states = statuses.seen.map((s) => s.state).filter((s) => s !== 'running');
    expect(states).toEqual(['queued', 'published', 'indexed']);
    expect(statuses.seen.filter((s) => s.tone === 'success').map((s) => s.state)).toEqual(['indexed']);
    // Terminal: the screen stopped re-reading the outbox.
    expect(world.services.ticker.active()).toBe(0);
  });

  it('excluded or failed status shows the failure code, stops polling and never shows published success', async () => {
    // A. The PDS rejects the record: failed with its code, never published.
    const failing = await outboxWorld();
    failing.fx.pds.fail({ nsid: CREATE }, { kind: 'status', status: 400, error: 'InvalidRecord', message: 'bad' });
    let main = await openForm(failing);
    let statuses = recordStatuses(main);
    const rejected = await submitValid(failing, main);
    expect(await failing.outbox.runner.runDue()).toBeNull();
    await until(() =>
      expect(statuses.seen.at(-1)).toEqual({
        state: 'failed',
        tone: 'failed',
        text: 'Scrobble failed (invalid_record)',
      }),
    );
    statuses.stop();
    expect(statuses.seen.some((s) => s.state === 'published' || s.state === 'indexed' || s.tone === 'success')).toBe(
      false,
    );
    expect(await failing.fx.store.get(rejected.id)).toMatchObject({ state: 'failed', failureCode: 'invalid_record' });
    expect(failing.fx.pds.count(CREATE)).toBe(1);
    expect(failing.fx.appView.notified).toEqual([]);
    expect(failing.fx.appView.statusPolls).toEqual([]);
    // Polling stopped: no ticker, and later passes send nothing.
    expect(failing.services.ticker.active()).toBe(0);
    failing.clock.advance(600_000);
    expect(await failing.outbox.runner.runDue()).toBeNull();
    expect(failing.fx.pds.count(CREATE)).toBe(1);
    mounted?.unmount();
    mounted = null;

    // B. The PDS accepts it but the AppView excludes it: excluded (reason, code).
    const excluded = await outboxWorld();
    main = await openForm(excluded);
    statuses = recordStatuses(main);
    const op = await submitValid(excluded, main, 'Hunter');
    const reason = 'listenedAt: timestamp must be between 1970-01-01 and receipt time plus 300 seconds';
    excluded.fx.appView.override(op.uri, (truth) => ({
      uri: op.uri,
      state: 'excluded',
      reason,
      indexing: truth.indexing,
    }));
    await excluded.outbox.runner.runDue();
    excluded.clock.advance(pollDelayMs(0));
    expect(await excluded.outbox.runner.runDue()).toBeNull();
    await until(() =>
      expect(statuses.seen.at(-1)).toEqual({
        state: 'failed',
        tone: 'failed',
        text: `Excluded by the index: ${reason} (record_excluded)`,
      }),
    );
    statuses.stop();
    expect(await excluded.fx.store.get(op.id)).toMatchObject({
      state: 'failed',
      failureCode: 'record_excluded',
      reason,
      dueAt: null,
    });
    expect(statuses.seen.some((s) => s.state === 'indexed' || s.tone === 'success')).toBe(false);
    expect(text(main.querySelector(`[data-op-id="${op.id}"]`))).not.toMatch(/indexed|visible in your public history/i);
    // Exactly one poll; nothing polls after the terminal answer.
    expect(excluded.fx.appView.statusPolls).toEqual([op.uri]);
    expect(excluded.services.ticker.active()).toBe(0);
    excluded.clock.advance(600_000);
    expect(await excluded.outbox.runner.runDue()).toBeNull();
    excluded.services.ticker.tickAll();
    await settle();
    expect(excluded.fx.appView.statusPolls).toEqual([op.uri]);
  });
});
