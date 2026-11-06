// M1.4.2 safe_errors: the error envelope is the OpenAPI `Error` schema, the
// requestId is a UUID drawn from the injected Random, every code is served
// with its API.md status, and nothing about the failure leaks to the client.

import type { Random } from '@atmusic/core/deps';
import { ApiError, DEFAULT_STATUS, ERROR_CODES } from '@atmusic/core/errors';
import { seededRandom } from '@atmusic/core/test-support/random';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { expect, it } from 'vitest';
import error400 from '../../../api/examples/error-400.json';
import error404 from '../../../api/examples/error-404.json';
import error413 from '../../../api/examples/error-413.json';
import error422 from '../../../api/examples/error-422.json';
import error429 from '../../../api/examples/error-429.json';
import error502 from '../../../api/examples/error-502.json';
import error503 from '../../../api/examples/error-503.json';
import errorQueueFull from '../../../api/examples/error-queue-full.json';
import openapiText from '../../../api/openapi.yaml?raw';
import { ERROR_MESSAGES, errorResponse, rateLimitedResponse, toErrorResponse } from '../../src/http/error';
import { newRequestId, UUID_PATTERN } from '../../src/http/request-id';

function openapiValidator(schema: string) {
  const doc = JSON.parse(openapiText) as { components: unknown };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('at-utc-datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d+)?(Z|\+00:00)$/);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`);
  if (validate === undefined) throw new Error(`no schema ${schema}`);
  return (value: unknown) => {
    const ok = validate(value) as boolean;
    return ok ? 'valid' : ajv.errorsText(validate.errors);
  };
}

const errorSchema = openapiValidator('Error');
const uuidSchema = openapiValidator('Uuid');

/** A Random that counts how many bytes were drawn from it. */
function countingRandom(seed: number): Random & { drawn: number } {
  const inner = seededRandom(seed);
  const r = {
    drawn: 0,
    bytes(n: number) {
      r.drawn += n;
      return inner.bytes(n);
    },
    float: () => inner.float(),
  };
  return r;
}

it('envelope matches openapi Error schema with requestId UUID', async () => {
  // Request ids come from the injected Random only: deterministic per seed,
  // 16 bytes per id, RFC 9562 v4 layout, accepted by the OpenAPI Uuid schema.
  const random = countingRandom(7);
  const requestId = newRequestId(random);
  expect(random.drawn).toBe(16);
  expect(requestId).toMatch(UUID_PATTERN);
  expect(uuidSchema(requestId)).toBe('valid');
  expect(newRequestId(seededRandom(7))).toBe(requestId);
  const ids = new Set(Array.from({ length: 100 }, () => newRequestId(random)));
  expect(ids.size).toBe(100);
  expect(random.drawn).toBe(16 * 101);
  for (const id of ids) expect(id).toMatch(UUID_PATTERN);
  // An all-ones and an all-zero source still produce the v4/variant bits.
  const fixedBytes = (b: number): Random => ({ bytes: (n) => new Uint8Array(n).fill(b), float: () => 0 });
  expect(newRequestId(fixedBytes(0))).toBe('00000000-0000-4000-8000-000000000000');
  expect(newRequestId(fixedBytes(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');

  // Every code: its API.md status, JSON, no-store, schema-valid, fixed message, no fields.
  for (const code of ERROR_CODES) {
    const res = errorResponse(code, undefined, requestId);
    expect(res.status, code).toBe(DEFAULT_STATUS[code]);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(errorSchema(body), code).toBe('valid');
    expect(body).toEqual({ error: { code, message: ERROR_MESSAGES[code], requestId } });
    expect(Object.hasOwn(body.error, 'fields')).toBe(false);
  }

  // The frozen contract examples: same code and message for each status.
  const examples = [error400, error404, error413, error422, error429, error502, error503, errorQueueFull];
  const exampleStatus = [400, 404, 413, 422, 429, 502, 503, 503];
  for (const [i, example] of examples.entries()) {
    const code = example.error.code as (typeof ERROR_CODES)[number];
    expect(ERROR_CODES).toContain(code);
    const res = errorResponse(code, exampleStatus[i], example.error.requestId);
    expect(res.status).toBe(exampleStatus[i]);
    const body = (await res.json()) as typeof example;
    expect(body.error.code).toBe(example.error.code);
    expect(body.error.message).toBe(example.error.message);
    expect(body.error.requestId).toBe(example.error.requestId);
    expect(errorSchema(example)).toBe('valid');
  }

  // `fields` is present only when non-empty, with sorted keys (Rust BTreeMap order).
  const withFields = errorResponse('validation_failed', 422, requestId, {
    window: 'Expected all, 7d, 30d or 365d.',
    limit: 'Expected an integer between 1 and 100.',
  });
  expect(withFields.status).toBe(422);
  const fieldsText = await withFields.text();
  expect(fieldsText.indexOf('"limit"')).toBeLessThan(fieldsText.indexOf('"window"'));
  const fieldsBody = JSON.parse(fieldsText);
  expect(errorSchema(fieldsBody)).toBe('valid');
  expect(Object.keys(fieldsBody.error.fields)).toEqual(['limit', 'window']);
  const emptyFields = await errorResponse('validation_failed', 422, requestId, {}).json();
  expect(emptyFields).toEqual({
    error: { code: 'validation_failed', message: ERROR_MESSAGES.validation_failed, requestId },
  });

  // A thrown ApiError keeps code, status and fields but never its internal message.
  const api = toErrorResponse(
    new ApiError('validation_failed', 'internal: viewer did:plc:secret failed', { viewer: 'Expected a DID.' }),
    requestId,
  );
  expect(api.status).toBe(422);
  const apiText = await api.text();
  expect(apiText).not.toContain('internal');
  expect(apiText).not.toContain('did:plc:secret');
  expect(errorSchema(JSON.parse(apiText))).toBe('valid');
  expect(JSON.parse(apiText).error.fields).toEqual({ viewer: 'Expected a DID.' });

  // Anything else is a generic 500 with no stack trace, file path or message.
  const boom = new Error('CURSOR_KEY=00ff leaked at /home/june/worker/src/do/index-do.ts:42');
  const internal = toErrorResponse(boom, requestId);
  expect(internal.status).toBe(500);
  expect(internal.headers.get('cache-control')).toBe('no-store');
  const internalText = await internal.text();
  for (const leak of ['CURSOR_KEY', '/home/', 'index-do.ts', 'at ', 'Error:', String(boom.stack).slice(0, 20)]) {
    expect(internalText).not.toContain(leak);
  }
  expect(JSON.parse(internalText)).toEqual({
    error: { code: 'internal_error', message: ERROR_MESSAGES.internal_error, requestId },
  });
  expect(errorSchema(JSON.parse(internalText))).toBe('valid');
  const thrownString = toErrorResponse('a thrown string', requestId);
  expect(thrownString.status).toBe(500);
  expect(await thrownString.text()).not.toContain('a thrown string');

  // 429 carries Retry-After in whole seconds, at least 1.
  const limited = rateLimitedResponse(requestId, 1.2);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('2');
  expect(errorSchema(await limited.json())).toBe('valid');
  expect(rateLimitedResponse(requestId, 0).headers.get('retry-after')).toBe('1');

  // A non-error status is a programming error, not a response.
  expect(() => errorResponse('not_found', 200, requestId)).toThrow(RangeError);
  expect(() => errorResponse('not_found', 404.5, requestId)).toThrow(RangeError);
});
