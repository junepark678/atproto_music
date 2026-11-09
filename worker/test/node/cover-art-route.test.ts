import { describe, expect, it, vi } from 'vitest';
import { coverArt } from '../../src/http/cover-art';

const id = '01234567-89ab-4cde-8fab-0123456789ab';
function ctx(image: { mimeType: string; bytes: Uint8Array } | null) {
  const coverArtRpc = vi.fn().mockResolvedValue(image);
  return {
    value: { index: { coverArt: coverArtRpc } as never, clock: { nowMs: () => 100 } as never, requestId: 'r' } as never,
    coverArtRpc,
  };
}
describe('cover art API', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'serves cached %s bytes with safe cache headers',
    async (mimeType) => {
      const x = ctx({ mimeType, bytes: new Uint8Array([1, 2, 3]) });
      const response = await coverArt(new Request(`https://music.test/api/v1/cover-art/${id}`), x.value, {
        releaseMbid: id,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(mimeType);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toContain('max-age=86400');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
      expect(x.coverArtRpc).toHaveBeenCalledWith(id, 100);
    },
  );
  it('returns 404 on misses and 422 on malformed ids without any outbound dependency', async () => {
    const x = ctx(null);
    expect((await coverArt(new Request('https://music.test/x'), x.value, { releaseMbid: id })).status).toBe(404);
    expect((await coverArt(new Request('https://music.test/x'), x.value, { releaseMbid: 'bad' })).status).toBe(422);
    expect(x.coverArtRpc).toHaveBeenCalledTimes(1);
  });
});
