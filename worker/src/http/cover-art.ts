import { errorResponse, toErrorResponse } from './error';
import { invalidField } from './params';
import type { RequestCtx, RouteDef } from './types';

export const COVER_ART_PATTERN = '/api/v1/cover-art/{releaseMbid}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function coverArt(_req: Request, ctx: RequestCtx, params: Record<string, string>): Promise<Response> {
  const id = params.releaseMbid;
  if (!id || !UUID.test(id))
    return toErrorResponse(invalidField('releaseMbid', 'Expected a release UUID.'), ctx.requestId);
  try {
    const image = await ctx.index.coverArt(id, ctx.clock.nowMs());
    if (!image) return errorResponse('not_found', 404, ctx.requestId);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType))
      return errorResponse('not_found', 404, ctx.requestId);
    const body = image.bytes.buffer.slice(
      image.bytes.byteOffset,
      image.bytes.byteOffset + image.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': image.mimeType,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    return toErrorResponse(err, ctx.requestId);
  }
}
export const routes: RouteDef[] = [{ method: 'GET', pattern: COVER_ART_PATTERN, handler: coverArt }];
