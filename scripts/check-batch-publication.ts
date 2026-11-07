#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const collections = ['scrobble', 'follow', 'love', 'settings', 'scrobbleBatch'] as const;

interface BatchManifest {
  authorityDid: string;
  ownershipRef: string;
  prefix: string;
  verifiedAt: string;
  records: Array<{
    nsid: string;
    uri: string;
    cid: string;
    contentSha256: string;
    publicRetrieval: string;
    match: boolean;
  }>;
}

export function validateBatchManifest(value: unknown): asserts value is BatchManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('manifest must be an object');
  const manifest = value as Partial<BatchManifest>;
  if (typeof manifest.prefix !== 'string' || manifest.prefix.length === 0) throw new Error('prefix is required');
  if (typeof manifest.authorityDid !== 'string' || !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(manifest.authorityDid))
    throw new Error('authorityDid must be a DID');
  if (typeof manifest.ownershipRef !== 'string' || manifest.ownershipRef.length === 0)
    throw new Error('ownershipRef is required');
  if (
    typeof manifest.verifiedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(manifest.verifiedAt)
  )
    throw new Error('verifiedAt must be an ISO UTC timestamp');
  if (!Array.isArray(manifest.records) || manifest.records.length !== collections.length)
    throw new Error('batch manifest must contain exactly five schema records');
  const expected = collections.map((name) => `${manifest.prefix}.${name}`).sort();
  const actual = manifest.records.map((record) => record?.nsid).sort();
  if (actual.some((nsid) => typeof nsid !== 'string') || JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('batch manifest must contain the four published collections and scrobbleBatch exactly once');
  for (const record of manifest.records) {
    if (record === null || typeof record !== 'object') throw new Error('every schema receipt must be an object');
    if (record.match !== true) throw new Error(`${record.nsid} must be reviewed with match=true`);
    if (
      typeof record.uri !== 'string' ||
      !record.uri.startsWith(`at://${manifest.authorityDid}/com.atproto.lexicon.schema/`) ||
      !record.uri.endsWith(`/${record.nsid}`)
    )
      throw new Error(`${record.nsid} URI must be its authority lexicon.schema record`);
    if (typeof record.cid !== 'string' || !/^b[a-z2-7]{50,}$/.test(record.cid))
      throw new Error(`${record.nsid} must have a verified CID`);
    if (typeof record.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.contentSha256))
      throw new Error(`${record.nsid} must have a SHA-256 content digest`);
    if (typeof record.publicRetrieval !== 'string' || !record.publicRetrieval.startsWith('https://'))
      throw new Error(`${record.nsid} needs a public HTTPS retrieval URL`);
  }
}

export function batchManifestDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined || process.argv.length !== 3) {
    process.stderr.write('usage: npx tsx scripts/check-batch-publication.ts <reviewed-manifest.json>\n');
    process.exitCode = 2;
    return;
  }
  const bytes = readFileSync(resolve(path));
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  validateBatchManifest(value);
  process.stdout.write(`${batchManifestDigest(bytes)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
