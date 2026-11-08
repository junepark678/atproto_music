import { describe, expect, it, vi } from 'vitest';
import { createCoverArtClient } from '../../src/node/cover-art-client';

const id = '01234567-89ab-4cde-8fab-0123456789ab';
describe('Cover Art Archive client', () => {
  it('falls back from release 404 to release-group and returns accepted bytes', async () => {
    const policyFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }));
    const fetchArt = createCoverArtClient({ policyFetch: policyFetch as never, root: 'https://coverartarchive.test/' });
    expect(Array.from((await fetchArt(id, id)) ?? [])).toEqual([1, 2]);
    expect(String(policyFetch.mock.calls[0]?.[0])).toContain(`/release/${id}/front-250`);
    expect(String(policyFetch.mock.calls[1]?.[0])).toContain(`/release-group/${id}/front-250`);
  });

  it('allows two archive redirects and refuses a third', async () => {
    const policyFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://archive.org/a' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://ia800.archive.org/b' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([8]), { headers: { 'content-type': 'image/jpeg' } }));
    const run = createCoverArtClient({ policyFetch: policyFetch as never, root: 'https://coverartarchive.test/' });
    expect(Array.from((await run(id)) ?? [])).toEqual([8]);
    expect(policyFetch).toHaveBeenCalledTimes(3);
    const third = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://archive.org/a' } }));
    await expect(
      createCoverArtClient({ policyFetch: third as never, root: 'https://coverartarchive.test/' })(id),
    ).rejects.toThrow(/redirect/i);
    expect(third).toHaveBeenCalledTimes(3);
  });

  it.each([
    'http://archive.org/a',
    'https://archive.org.evil.test/a',
    'https://user@archive.org/a',
    'https://archive.org:8443/a',
    'https://127.0.0.1/a',
  ])('refuses unsafe redirect %s before another request', async (location) => {
    const policyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(
      createCoverArtClient({ policyFetch: policyFetch as never, root: 'https://coverartarchive.test/' })(id),
    ).rejects.toThrow(/redirect/i);
    expect(policyFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses redirects without Location before another request', async () => {
    const policyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    await expect(
      createCoverArtClient({ policyFetch: policyFetch as never, root: 'https://coverartarchive.test/' })(id),
    ).rejects.toThrow(/redirect/i);
    expect(policyFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', async (type) => {
    const policyFetch = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'content-type': type } }));
    expect(
      Array.from(
        (await createCoverArtClient({ policyFetch: policyFetch as never, root: 'https://coverartarchive.test/' })(
          id,
        )) ?? [],
      ),
    ).toEqual([1]);
  });

  it('accepts exactly 512 KiB and rejects a stream one byte over', async () => {
    const response = (size: number) => new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png' } });
    const exact = vi.fn().mockResolvedValue(response(512 * 1024));
    expect(
      (await createCoverArtClient({ policyFetch: exact as never, root: 'https://coverartarchive.test/' })(id))
        ?.byteLength,
    ).toBe(512 * 1024);
    const over = vi.fn().mockResolvedValue(response(512 * 1024 + 1));
    await expect(
      createCoverArtClient({ policyFetch: over as never, root: 'https://coverartarchive.test/' })(id),
    ).rejects.toThrow(/512 KiB/);
  });

  it('rejects non-image media types', async () => {
    const policyFetch = vi.fn().mockResolvedValue(new Response('no', { headers: { 'content-type': 'text/html' } }));
    await expect(
      createCoverArtClient({ policyFetch: policyFetch as never, root: 'https://coverartarchive.test/' })(id),
    ).rejects.toThrow(/content type/);
  });
});
