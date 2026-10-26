// api/openapi.yaml compiled with AJV for the acceptance suites (W6-01,
// ADR 0004 §10.3 "Every HTTP test asserts … schema, through AJV"). TEST-ONLY.
//
// Every response an acceptance test receives goes through `checkResponse`:
// - the request's path is matched against the OpenAPI `paths` templates, and
//   the (method, path, status) must be declared there: an undocumented status
//   is a contract violation, not a pass;
// - the JSON body is validated against that response's
//   `content["application/json"].schema` (components resolved in place).
// The custom string formats mirror scripts/validate_contracts.py (the
// contract validator), written independently of the code under test.

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import openapiText from '../../../../api/openapi.yaml?raw';

interface MediaType {
  schema?: unknown;
}
interface ResponseObject {
  content?: Record<string, MediaType>;
}
interface Operation {
  operationId?: string;
  responses: Record<string, ResponseObject>;
}
interface Spec {
  info: { version: string };
  paths: Record<string, Record<string, Operation | unknown>>;
  components: Record<string, unknown>;
}

export const SPEC = JSON.parse(openapiText) as Spec;

// Unicode White_Space (validate_contracts.py UNICODE_WHITE_SPACE).
const WHITE_SPACE = new Set('\u0009\u000a\u000b\u000c\u000d \u0085                 　');

function trimWs(value: string): string {
  const cps = [...value];
  let a = 0;
  let b = cps.length;
  while (a < b && WHITE_SPACE.has(cps[a] as string)) a++;
  while (b > a && WHITE_SPACE.has(cps[b - 1] as string)) b--;
  return cps.slice(a, b).join('');
}

function validTimestamp(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|\+00:00)$/.test(value)) return false;
  const [date, time] = value.split('T') as [string, string];
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, s] = time.slice(0, 8).split(':').map(Number) as [number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > days) return false;
  return y >= 1970;
}

function validDid(value: string): boolean {
  return (
    value.length <= 2048 && /^did:[a-z]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+$/.test(value) && !value.endsWith(':')
  );
}

function validNsid(value: string): boolean {
  const parts = value.split('.');
  if (parts.length < 3 || value.length > 317 || !/^[A-Za-z]/.test(parts[0] ?? '')) return false;
  const last = parts[parts.length - 1] as string;
  return (
    parts.slice(0, -1).every((p) => p.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(p)) &&
    last.length <= 63 &&
    /^[A-Za-z][A-Za-z0-9]*$/.test(last)
  );
}

function validAtUri(value: string): boolean {
  if (!value.startsWith('at://')) return false;
  const parts = value.slice(5).split('/');
  if (parts.length !== 3) return false;
  const [did, nsid, rkey] = parts as [string, string, string];
  return (
    validDid(did) &&
    validNsid(nsid) &&
    rkey.length >= 1 &&
    rkey.length <= 512 &&
    rkey !== '.' &&
    rkey !== '..' &&
    /^[A-Za-z0-9._~:-]+$/.test(rkey)
  );
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Non-canonical trailing bits would not round-trip.
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** CIDv1, DAG-CBOR codec, SHA-256 multihash, 32-byte digest, canonical base32. */
function validCid(value: string): boolean {
  if (!/^b[a-z2-7]+$/.test(value)) return false;
  const raw = base32Decode(value.slice(1));
  return raw !== null && raw.length === 36 && raw[0] === 1 && raw[1] === 0x71 && raw[2] === 0x12 && raw[3] === 0x20;
}

function validHandle(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  const labels = value.split('.');
  return (
    labels.length >= 2 &&
    !/^[0-9]/.test(labels[labels.length - 1] as string) &&
    labels.every((l) => l.length >= 1 && l.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l))
  );
}

function validMusicText(value: string): boolean {
  return trimWs(value) !== '' && [...value].length <= 256 && new TextEncoder().encode(value).length <= 1024;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(ajv);
ajv.addFormat('at-utc-datetime', { type: 'string', validate: validTimestamp });
ajv.addFormat('at-did', { type: 'string', validate: validDid });
ajv.addFormat('at-record-uri', { type: 'string', validate: validAtUri });
ajv.addFormat('at-record-cid', { type: 'string', validate: validCid });
ajv.addFormat('at-handle', { type: 'string', validate: validHandle });
ajv.addFormat('music-text', { type: 'string', validate: validMusicText });
ajv.addKeyword({
  keyword: 'x-maxUtf8Bytes',
  type: 'string',
  schemaType: 'number',
  validate: (max: number, data: string) => new TextEncoder().encode(data).length <= max,
});
ajv.addSchema({ $id: 'openapi', components: SPEC.components });

const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

interface CompiledPath {
  template: string;
  segments: string[];
}

const PATHS: CompiledPath[] = Object.keys(SPEC.paths).map((template) => ({ template, segments: template.split('/') }));

/** The OpenAPI path template matching a raw request path, or null. */
export function pathTemplate(pathname: string): string | null {
  const got = pathname.split('/');
  // Exact templates first, so `/api/v1/feed` never loses to a `{param}` sibling.
  const candidates = PATHS.filter(
    (p) =>
      p.segments.length === got.length &&
      p.segments.every((s, i) => (s.startsWith('{') && s.endsWith('}') ? got[i] !== '' : s === got[i])),
  ).sort(
    (a, b) => a.segments.filter((s) => s.startsWith('{')).length - b.segments.filter((s) => s.startsWith('{')).length,
  );
  return candidates[0]?.template ?? null;
}

const compiled = new Map<string, ValidateFunction>();

function validatorFor(template: string, method: string, status: number): ValidateFunction {
  const key = `${method} ${template} ${status}`;
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  const item = SPEC.paths[template];
  const m = method.toLowerCase();
  if (item === undefined || !METHODS.has(m) || item[m] === undefined) {
    throw new Error(`openapi: ${method} ${template} is not an operation`);
  }
  const op = item[m] as Operation;
  const response = op.responses[String(status)];
  if (response === undefined) {
    throw new Error(`openapi: ${method} ${template} does not declare status ${status}`);
  }
  const schema = response.content?.['application/json']?.schema;
  if (schema === undefined) throw new Error(`openapi: ${method} ${template} ${status} has no JSON schema`);
  // Rewrite local refs into the registered component document.
  const rewritten = JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"openapi#/components/'));
  const validate = ajv.compile(rewritten);
  compiled.set(key, validate);
  return validate;
}

export interface ResponseLike {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * 'valid', or the reason `res` (to `method` `url`) violates api/openapi.yaml:
 * an undeclared status, a non-JSON content type, or a schema error.
 */
export function checkResponse(method: string, url: string, res: ResponseLike): string {
  const pathname = new URL(url, 'https://music.example.test').pathname;
  const template = pathTemplate(pathname);
  if (template === null) return `openapi: no path template for ${pathname}`;
  let validate: ValidateFunction;
  try {
    validate = validatorFor(template, method, res.status);
  } catch (error) {
    return (error as Error).message;
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json')) return `openapi: content-type ${type} is not application/json`;
  return (validate(res.body) as boolean) ? 'valid' : `${template} ${res.status}: ${ajv.errorsText(validate.errors)}`;
}

/** 'valid', or AJV's error text for `value` against components.schemas[name]. */
export function schema(name: string, value: unknown): string {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return (validate(value) as boolean) ? 'valid' : ajv.errorsText(validate.errors);
}
