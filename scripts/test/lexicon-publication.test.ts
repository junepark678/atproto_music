import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { batchManifestDigest, validateBatchManifest } from '../check-batch-publication';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = 'docs/verification/lexicon-publication/manifest.json';

const COLLECTIONS = ['scrobble', 'follow', 'love', 'settings'] as const;
type Collection = (typeof COLLECTIONS)[number];

interface PublicationRecord {
  nsid: string;
  contentSha256: string;
}

interface PublicationManifest {
  prefix: string;
  records: PublicationRecord[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
}

/** Serialize objects with recursively sorted keys, preserving arrays and JSON scalars. */
function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function productionDocument(collection: Collection, prefix: string): JsonValue {
  const document = readJson<JsonValue>(`lexicons/${collection}.json`);
  if (document === null || Array.isArray(document) || typeof document !== 'object') {
    throw new Error(`lexicons/${collection}.json must be a JSON object`);
  }
  return { ...document, id: `${prefix}.${collection}` };
}

function contentSha256(document: JsonValue): string {
  return createHash('sha256').update(stableJson(document), 'utf8').digest('hex');
}

const manifest = readJson<PublicationManifest>(MANIFEST_PATH);

describe('published production Lexicon contract', () => {
  it('maps each fixture schema root id to its production NSID exactly once', () => {
    expect(manifest.prefix).toBe('dev.pythonplayer123.music');
    expect(manifest.records).toHaveLength(COLLECTIONS.length);
    expect(manifest.records.map(({ nsid }) => nsid).sort()).toEqual(
      COLLECTIONS.map((collection) => `${manifest.prefix}.${collection}`).sort(),
    );

    for (const collection of COLLECTIONS) {
      const fixture = readJson<{ id: string }>(`lexicons/${collection}.json`);
      expect(fixture.id).toBe(`com.example.atmusic.${collection}`);
      const record = manifest.records.filter(({ nsid }) => nsid === `${manifest.prefix}.${collection}`);
      expect(record).toHaveLength(1);
      expect(productionDocument(collection, manifest.prefix)).toMatchObject({
        id: record[0]?.nsid,
      });
    }
  });

  it.each(COLLECTIONS)('%s matches its published content digest and detects a schema edit', (collection) => {
    const record = manifest.records.find(({ nsid }) => nsid === `${manifest.prefix}.${collection}`);
    expect(record, `manifest record for ${collection}`).toBeDefined();
    const document = productionDocument(collection, manifest.prefix);
    expect(contentSha256(document)).toBe(record?.contentSha256);

    // A disposable in-memory required-field edit must trip this same per-schema guard.
    if (document === null || Array.isArray(document) || typeof document !== 'object') {
      throw new Error(`production schema for ${collection} must be an object`);
    }
    const edited = structuredClone(document);
    const defs = edited.defs;
    if (defs === null || Array.isArray(defs) || typeof defs !== 'object') {
      throw new Error(`production schema for ${collection} must have defs`);
    }
    const main = defs.main;
    if (main === null || Array.isArray(main) || typeof main !== 'object') {
      throw new Error(`production schema for ${collection} must have defs.main`);
    }
    const schemaRecord = main.record;
    if (schemaRecord === null || Array.isArray(schemaRecord) || typeof schemaRecord !== 'object') {
      throw new Error(`production schema for ${collection} must have defs.main.record`);
    }
    const required = schemaRecord.required;
    if (!Array.isArray(required)) {
      throw new Error(`production schema for ${collection} must declare required fields`);
    }
    required.push('contractMutation');
    expect(contentSha256(edited)).not.toBe(record?.contentSha256);
  });
});

describe('batch publication receipt guard', () => {
  it('requires the existing four schemas and scrobbleBatch with reviewed public evidence', () => {
    const prefix = 'dev.pythonplayer123.music';
    const receipt = {
      authorityDid: 'did:plc:gsichz64a5qpjvmjktkltkw2',
      ownershipRef: 'dns:_lexicon.music.pythonplayer123.dev TXT',
      prefix,
      verifiedAt: '2026-11-07T12:00:00Z',
      records: [...COLLECTIONS, 'scrobbleBatch'].map((collection) => ({
        nsid: `${prefix}.${collection}`,
        uri: `at://did:plc:gsichz64a5qpjvmjktkltkw2/com.atproto.lexicon.schema/${prefix}.${collection}`,
        cid: `bafyrei${'a'.repeat(52)}`,
        contentSha256: 'a'.repeat(64),
        publicRetrieval: `https://pds.example/xrpc/com.atproto.repo.getRecord?collection=${prefix}.${collection}`,
        match: true,
      })),
    };
    expect(() => validateBatchManifest(receipt)).not.toThrow();
    expect(() => validateBatchManifest({ ...receipt, records: receipt.records.slice(0, 4) })).toThrow(/exactly five/);
    expect(() =>
      validateBatchManifest({
        ...receipt,
        records: receipt.records.map((record) =>
          record.nsid.endsWith('.scrobbleBatch') ? { ...record, match: false } : record,
        ),
      }),
    ).toThrow(/match=true/);
    expect(batchManifestDigest(new TextEncoder().encode(JSON.stringify(receipt)))).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
