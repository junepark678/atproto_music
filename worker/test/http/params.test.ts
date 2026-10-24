// Query and body admission (API.md list/stats limits, ADR 0004 §5.8 step 1,
// M3.1.2, M4.3.1, M5.1.2, M6.2.1 body_boundary). Each case is checked as the
// HTTP response a route returns: status, OpenAPI Error schema and `fields`.

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { expect, it } from 'vitest';
import openapiText from '../../../api/openapi.yaml?raw';
import { toErrorResponse } from '../../src/http/error';
import { json } from '../../src/http/json';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  parseLimit,
  parseScope,
  parseWindow,
  readJsonBody,
  STATS_LIMIT_DEFAULT,
  STATS_LIMIT_MAX,
} from '../../src/http/params';

const REQUEST_ID = '6f1c2a4e-9b3d-4c5e-8f70-1a2b3c4d5e6f';

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => ((validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors));
}
const errorSchema = openapiValidator('Error');

/** What a route does: parse, then 200 with the value or the error envelope. */
async function respond(parse: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return json({ value: await parse() }, 200);
  } catch (err) {
    return toErrorResponse(err, REQUEST_ID);
  }
}

async function ok(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { value: unknown }).value;
}

async function expectError(res: Response, status: number, code: string, fields?: Record<string, string>) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as { error: { code: string; requestId: string; fields?: Record<string, string> } };
  expect(errorSchema(body)).toBe('valid');
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(REQUEST_ID);
  if (fields === undefined) expect(body.error.fields).toBeUndefined();
  else expect(body.error.fields).toEqual(fields);
}

const q = (s: string) => new URLSearchParams(s);
const LIMIT_REASON = 'Expected an integer between 1 and 100.';

it('limit 0, -1, 1.5, 101 → 422 fields.limit; default 20; stats default 10', async () => {
  const list = (s: string) => respond(() => parseLimit(q(s), LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX));
  const stats = (s: string) => respond(() => parseLimit(q(s), STATS_LIMIT_DEFAULT, STATS_LIMIT_MAX));

  for (const bad of ['0', '-1', '1.5', '101', '', '+5', ' 5', '5 ', '1e2', '0x10', 'abc', '99999999999999999999']) {
    const query = `limit=${encodeURIComponent(bad)}`;
    await expectError(await list(query), 422, 'validation_failed', { limit: LIMIT_REASON });
    await expectError(await stats(query), 422, 'validation_failed', { limit: LIMIT_REASON });
  }
  // A repeated limit is rejected, not resolved to either value.
  await expectError(await list('limit=5&limit=6'), 422, 'validation_failed', {
    limit: 'Parameter must occur only once.',
  });

  // Defaults, and both boundaries are served exactly (no clamping).
  expect(LIST_LIMIT_DEFAULT).toBe(20);
  expect(STATS_LIMIT_DEFAULT).toBe(10);
  expect(await ok(await list(''))).toBe(20);
  expect(await ok(await list('cursor=abc&scope=global'))).toBe(20);
  expect(await ok(await stats(''))).toBe(10);
  expect(await ok(await stats('window=7d'))).toBe(10);
  for (const [raw, value] of [
    ['1', 1],
    ['100', 100],
    ['050', 50],
    ['20', 20],
  ] as const) {
    expect(await ok(await list(`limit=${raw}`))).toBe(value);
    expect(await ok(await stats(`limit=${raw}`))).toBe(value);
  }
  // The cap is the caller's max: a lower max rejects what a higher one accepts.
  await expectError(await respond(() => parseLimit(q('limit=11'), 5, 10)), 422, 'validation_failed', {
    limit: 'Expected an integer between 1 and 10.',
  });
  expect(() => parseLimit(q(''), 0, 100)).toThrow(RangeError);
  expect(() => parseLimit(q(''), 101, 100)).toThrow(RangeError);
});

it('invalid window/scope → 422 with field name', async () => {
  for (const bad of ['', '7D', '1d', 'all ', 'week', '365', '30d,7d']) {
    await expectError(
      await respond(() => parseWindow(q(`window=${encodeURIComponent(bad)}`))),
      422,
      'validation_failed',
      { window: 'Expected all, 7d, 30d or 365d.' },
    );
  }
  await expectError(await respond(() => parseWindow(q('window=7d&window=7d'))), 422, 'validation_failed', {
    window: 'Parameter must occur only once.',
  });
  expect(await ok(await respond(() => parseWindow(q(''))))).toBe('all');
  for (const w of ['all', '7d', '30d', '365d'])
    expect(await ok(await respond(() => parseWindow(q(`window=${w}`))))).toBe(w);

  for (const bad of ['', 'Global', 'followers', 'following ', 'all']) {
    await expectError(
      await respond(() => parseScope(q(`scope=${encodeURIComponent(bad)}`))),
      422,
      'validation_failed',
      { scope: 'Expected global or following.' },
    );
  }
  await expectError(await respond(() => parseScope(q('scope=global&scope=following'))), 422, 'validation_failed', {
    scope: 'Parameter must occur only once.',
  });
  expect(await ok(await respond(() => parseScope(q(''))))).toBe('global');
  expect(await ok(await respond(() => parseScope(q('scope=global'))))).toBe('global');
  expect(await ok(await respond(() => parseScope(q('scope=following&viewer=did:plc:x'))))).toBe('following');
});

it('body over cap → 413; malformed JSON → 400', async () => {
  const CAP = 2048;
  const post = (body: BodyInit, headers?: HeadersInit) =>
    new Request('https://music.example.test/api/v1/notify', { method: 'POST', body, headers });
  const read = (req: Request) => respond(() => readJsonBody(req, CAP));

  // Exactly at the cap is parsed; one byte over is 413. Bytes, not characters, count.
  const pad = (n: number) => JSON.stringify({ uri: 'x'.repeat(n - 10) });
  expect(new TextEncoder().encode(pad(CAP)).length).toBe(CAP);
  expect(await ok(await read(post(pad(CAP))))).toEqual({ uri: 'x'.repeat(CAP - 10) });
  await expectError(await read(post(pad(CAP + 1))), 413, 'payload_too_large');
  const accents = (n: number) => `"${'é'.repeat(n)}"`; // 2 + 2n bytes
  expect(await ok(await read(post(accents(1023))))).toBe('é'.repeat(1023));
  await expectError(await read(post(accents(1024))), 413, 'payload_too_large');

  // A streamed body without Content-Length is cut off at the first chunk over the cap.
  let pulled = 0;
  const chunk = new Uint8Array(1000).fill(0x20);
  const endless = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  await expectError(await read(post(endless)), 413, 'payload_too_large');
  expect(pulled).toBe(3);

  // A declared Content-Length over the cap is refused before any body byte is read.
  let declaredPulls = 0;
  const declared = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        declaredPulls++;
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  await expectError(await read(post(declared, { 'content-length': String(CAP + 1) })), 413, 'payload_too_large');
  expect(declaredPulls).toBe(0);

  // Malformed JSON, empty bodies, a BOM and invalid UTF-8 are 400 invalid_json.
  const malformed: BodyInit[] = [
    '{"uri":',
    '',
    '{"uri":"a",}',
    "{'uri':'a'}",
    'NaN',
    '{"uri":"a"} trailing',
    '﻿{"uri":"a"}',
    new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
  ];
  for (const body of malformed) await expectError(await read(post(body)), 400, 'invalid_json');
  const noBody = new Request('https://music.example.test/api/v1/notify', { method: 'POST' });
  await expectError(await read(noBody), 400, 'invalid_json');

  // Well-formed bodies of any JSON type come back exactly.
  expect(await ok(await read(post('{"did":"did:plc:abc"}')))).toEqual({ did: 'did:plc:abc' });
  expect(await ok(await read(post(' [1, 2] ')))).toEqual([1, 2]);
});
