// Settings screen (W3-06; M7.2.3 export_download / disconnect_text, M6.4.3
// privacy_consistency). Disconnect and reconnect go through the W2-07 outbox
// over the fake PDS (a real signed repo); the fake AppView's records/status
// reports `suppressed` once the opt-out record says disabled.

import { collectionsFor } from '@atmusic/core/namespace';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteRecord, runUntilIdle, SCROBBLE_INPUT } from '../support/fake-pds-browser';
import {
  ALICE,
  buttonByText,
  click,
  FakeSessionPort,
  META_READ_ONLY,
  type Mounted,
  mount,
  ORIGIN,
  outboxWorld,
  PREFIX,
  settle,
  text,
  until,
  words,
} from './support';

const SETTINGS = collectionsFor(PREFIX).settings;
const SCROBBLE = collectionsFor(PREFIX).scrobble;
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function confirmPanel(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-confirm="disconnect"]');
}

describe('web/test/routes/settings.test.tsx', () => {
  it('disconnect requires confirmation and enqueues settings op', async () => {
    const world = await outboxWorld();
    const { fx } = world;
    mounted = mount('/settings', world.state, world.services);
    const main = mounted.main();
    await until(() => expect(buttonByText(main, 'Disconnect…')).not.toBeNull());
    expect(text(main.querySelector('[data-indexing]'))).toBe('This AppView indexes your public music records.');

    // Opening the confirmation writes nothing; cancelling closes it.
    click(buttonByText(main, 'Disconnect…'));
    await until(() => expect(confirmPanel(main)).not.toBeNull());
    expect(await fx.store.count()).toBe(0);
    click(buttonByText(confirmPanel(main)!, 'Cancel'));
    await until(() => expect(confirmPanel(main)).toBeNull());
    await settle();
    expect(await fx.store.count()).toBe(0);
    expect(fx.session.sent).toEqual([]);

    // Confirmed: exactly one settings_put {indexing: "disabled"} at settings/self.
    click(buttonByText(main, 'Disconnect…'));
    await until(() => expect(confirmPanel(main)).not.toBeNull());
    click(buttonByText(confirmPanel(main)!, 'Confirm disconnect'));
    await until(async () => expect(await fx.store.count(ALICE)).toBe(1));
    const [op] = await fx.ops();
    expect(op).toMatchObject({
      kind: 'settings_put',
      collection: SETTINGS,
      rkey: 'self',
      uri: `at://${ALICE}/${SETTINGS}/self`,
      state: 'queued',
      attempts: 0,
    });
    expect(op!.record).toMatchObject({ $type: SETTINGS, indexing: 'disabled' });
    await until(() => expect(confirmPanel(main)).toBeNull());
    await until(() => expect(text(main.querySelector('.settings-op'))).toBe('Disconnect: Setting queued'));
    // While it is pending, neither "disconnected" nor another action is offered.
    expect(main.querySelector('[data-indexing]')).toBeNull();
    expect(buttonByText(main, 'Disconnect…')).toBeNull();
    expect(buttonByText(main, 'Reconnect')).toBeNull();

    // The runner writes it with putRecord, notifies, and the index reports suppressed.
    await runUntilIdle(world.outbox.runner, world.clock);
    expect(fx.session.sentTo('com.atproto.repo.putRecord').map((r) => r.body)).toEqual([
      { repo: ALICE, collection: SETTINGS, rkey: 'self', record: op!.record },
    ]);
    expect(fx.appView.notified).toEqual([{ uri: op!.uri }]);
    expect((await remoteRecord(fx, SETTINGS, 'self'))?.value).toMatchObject({ indexing: 'disabled' });
    await until(() =>
      expect(text(main.querySelector('.settings-op'))).toBe('Disconnect: Saved: verified by the index'),
    );
    await until(() => expect(main.querySelector('[data-indexing="disabled"]')).not.toBeNull());
    expect(buttonByText(main, 'Reconnect')).not.toBeNull();

    // Reconnect enqueues the opposite intent behind it.
    click(buttonByText(main, 'Reconnect'));
    await until(async () => expect(await fx.store.count(ALICE)).toBe(2));
    const second = (await fx.ops())[1]!;
    expect(second).toMatchObject({ kind: 'settings_put', rkey: 'self', state: 'queued' });
    expect(second.record).toMatchObject({ indexing: 'enabled' });
    await until(() => expect(text(main.querySelector('.settings-op'))).toBe('Reconnect: Setting queued'));
  });

  it('disconnect confirmation states that public PDS records and the opt-out record remain and claims no erasure', async () => {
    const world = await outboxWorld();
    const { fx } = world;
    // Alice has a published scrobble on her PDS.
    const created = await world.outbox.scrobble(SCROBBLE_INPUT);
    if (!created.ok) throw new Error('fixture scrobble rejected');
    await runUntilIdle(world.outbox.runner, world.clock);
    expect(await remoteRecord(fx, SCROBBLE, created.op.rkey)).not.toBeNull();

    mounted = mount('/settings', world.state, world.services);
    const main = mounted.main();
    await until(() => expect(buttonByText(main, 'Disconnect…')).not.toBeNull());
    click(buttonByText(main, 'Disconnect…'));
    await until(() => expect(confirmPanel(main)).not.toBeNull());
    const panel = confirmPanel(main)!;
    const said = words(panel);

    expect(text(panel.querySelector('legend'))).toBe('Disconnect from this AppView?');
    // The export is offered first, inside the confirmation.
    const exportLink = panel.querySelector('a.export-link');
    expect(exportLink?.getAttribute('href')).toBe(`${ORIGIN}/api/v1/users/${ALICE}/export`);
    expect(exportLink?.getAttribute('download')).toBe('music-export.json');
    // What stays: the PDS records, public; the opt-out record, public.
    expect(said).toContain('Your scrobbles and follows remain in your PDS as public records.');
    expect(said).toContain('Nothing is taken out of your PDS, and other apps can still read them.');
    expect(said).toContain('The opt-out record is public too: anyone can see that you opted out.');
    expect(said).toContain('It stays in your repository until you reconnect.');
    expect(said).toContain('Disconnecting publishes an opt-out record ( settings/self with indexing: "disabled" )');
    // No erasure is claimed anywhere on the screen.
    const screen = words(main);
    expect(screen).not.toMatch(/\b(eras(e|ed|es|ure)|wipe[sd]?|purge[sd]?|permanently)\b/i);
    expect(screen).not.toMatch(/\b(will be|are|is|have been|has been|gets?) (deleted|removed|erased)\b/i);
    expect(screen).not.toMatch(/\bdelete[sd]? (your|all)\b/i);

    // Confirming really leaves the scrobble in the PDS and publishes the public opt-out record.
    click(buttonByText(panel, 'Confirm disconnect'));
    await until(async () => expect(await fx.store.count(ALICE)).toBe(2));
    await runUntilIdle(world.outbox.runner, world.clock);
    expect(await remoteRecord(fx, SCROBBLE, created.op.rkey)).not.toBeNull();
    expect((await remoteRecord(fx, SETTINGS, 'self'))?.value).toMatchObject({ $type: SETTINGS, indexing: 'disabled' });
    expect(fx.session.sentTo('com.atproto.repo.deleteRecord')).toEqual([]);
    await until(() => expect(main.querySelector('[data-indexing="disabled"]')).not.toBeNull());
    expect(words(main.querySelector('[data-indexing="disabled"]'))).toBe(
      'Indexing is turned off for your account: your public opt-out record tells this AppView not to index it.',
    );
    expect(words(main)).not.toMatch(/\b(eras(e|ed|es|ure)|wipe[sd]?|permanently)\b/i);
  });

  it('export action downloads /api/v1/users/<did>/export as music-export.json', async () => {
    // Export needs no publication capability: a read-only deployment offers it too.
    const world = await outboxWorld({ meta: META_READ_ONLY, port: new FakeSessionPort() });
    mounted = mount('/settings', world.state, world.services);
    const main = mounted.main();
    await until(() => expect(main.querySelector('a.export-link')).not.toBeNull());
    const link = main.querySelector('a.export-link') as HTMLAnchorElement;
    expect(text(link)).toBe('Download your data (music-export.json)');
    expect(link.getAttribute('download')).toBe('music-export.json');
    const url = new URL(link.href);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/api/v1/users/${ALICE}/export`);
    expect(url.search).toBe('');
    expect(link.getAttribute('href')).toBe(world.state.api.exportUrl(ALICE));

    // A download link is left to the browser: the SPA router does not navigate.
    let defaultPrevented: boolean | null = null;
    const spy = (event: Event) => {
      defaultPrevented = event.defaultPrevented;
      event.preventDefault(); // happy-dom would otherwise try to load the URL
    };
    window.addEventListener('click', spy);
    link.click();
    window.removeEventListener('click', spy);
    expect(defaultPrevented).toBe(false);
    await settle();
    expect(location.pathname).toBe('/settings');
    expect(text(main.querySelector('h1'))).toBe('Settings');
    // No disconnect without publication, and the export itself sent no API request.
    expect(buttonByText(main, 'Disconnect…')).toBeNull();
    expect(world.api.requests.some((r) => r.path.endsWith('/export'))).toBe(false);
  });
});
