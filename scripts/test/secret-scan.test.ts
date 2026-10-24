// Credential scan of the configuration examples and docs (plan case
// M6.1.3/secret_example_scan; ADR 0004 §8 "Server secrets"; W6-04).
//
// The operator-facing examples (worker/.dev.vars.example, .env.example,
// config/*.example*), the committed wrangler config, README.md and every text
// file under docs/ must contain no credential-shaped value: no PEM private
// key, JWT or provider token, no long random value assigned to a key, token,
// secret or password name, no literal piped into `wrangler secret put` and no
// literal bearer token. As in the Rust oracle (crates/server/tests/
// deployment.rs `secret_example_scan`), any word of exactly 64 hex digits
// (a line split on non-hex characters) is a literal 32-byte secret, whatever
// surrounds it. The only exception is DIGEST_RECORDS: historical
// verification records that are not operator examples, where a 64-hex word is
// allowed only as a labelled digest. Placeholders (empty values, `<…>`,
// `$VAR`, `$(openssl rand -hex 32)`) are allowed. The scanner itself is proven
// by negative controls built at runtime, so this file holds no such literal.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Finding {
  file: string;
  line: number;
  rule: string;
}

const SECRET_NAME = '[A-Za-z_][A-Za-z0-9_-]*?(?:key|token|secret|password|passphrase|credential)s?';
/** `NAME=value`, `NAME: value`, `"NAME": "value"`, `--name=value`. */
const ASSIGNMENT = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_])(${SECRET_NAME})["']?\s*(?:=|:)\s*["']?([^\s"'\`,;)}\]]*)`,
  'gi',
);
const RULES: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { rule: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { rule: 'api-key-sk', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  {
    rule: 'secret-put-literal',
    pattern:
      /\b(?:echo|printf)\s+(?:-[a-z]+\s+)?["']?[A-Za-z0-9+/=_-]{16,}["']?\s*\|\s*(?:npx\s+)?wrangler\s+secret\s+put\b/,
  },
  {
    rule: 'bearer-literal',
    pattern: /\bBearer\s+(?=[A-Za-z0-9._~+/-]*\d)(?=[A-Za-z0-9._~+/-]*[A-Za-z])[A-Za-z0-9._~+/-]{20,}=*/,
  },
];

/**
 * Files whose 64-hex words are documented non-secret SHA-256 digests (release
 * and verification evidence of the Rust candidate, retrieved-spec digests).
 * None is an operator example or a doc that tells anyone to set a secret. In
 * them a 64-hex word is still flagged unless it is labelled: `manifest` files
 * map repository paths to digests (`"path.ext": "<hex>"`), and `labelled`
 * files name the digest (SHA-256, sha256, artifact) on the same or the
 * previous line.
 */
const DIGEST_RECORDS: Readonly<Record<string, 'manifest' | 'labelled'>> = {
  'docs/VALIDATION.md': 'labelled',
  'docs/adr/0002-oauth.md': 'labelled',
  'docs/benchmarks/read_models.json': 'labelled',
  'docs/benchmarks/read_models.md': 'labelled',
  'docs/verification/backend-candidate.json': 'labelled',
  'docs/verification/backend-production-inputs.json': 'manifest',
  'docs/verification/backend.md': 'labelled',
  'docs/verification/live-evidence.json': 'labelled',
};
const DIGEST_LABEL = /sha-?256|artifact/i;
const MANIFEST_LINE = /^\s*"[A-Za-z0-9_./-]+\.[A-Za-z]+": "[0-9a-f]{64}",?$/;

/** Words of exactly 64 hex digits, split on non-hex characters as the oracle does. */
function hex64Words(line: string): string[] {
  return (line.match(/[0-9A-Fa-f]+/g) ?? []).filter((word) => word.length === 64);
}

function allowedDigest(file: string, lines: readonly string[], index: number): boolean {
  const kind = DIGEST_RECORDS[file];
  const line = lines[index] ?? '';
  if (kind === 'manifest') return MANIFEST_LINE.test(line);
  if (kind === 'labelled') return DIGEST_LABEL.test(line) || DIGEST_LABEL.test(lines[index - 1] ?? '');
  return false;
}

/** A value that looks like key material rather than a placeholder, word, path or URL. */
function credentialShaped(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, '');
  if (v.length < 16) return false;
  if (/^[0-9a-f]{32,}$/i.test(v)) return true; // hex key material (openssl rand -hex)
  if (!/^[A-Za-z0-9+/=_.-]+$/.test(v)) return false; // <placeholder>, $VAR, $(cmd), URLs, did:key
  if (/\.(?:json|jsonc|md|ts|tsx|js|rs|sh|py|toml|ya?ml|txt|example)$/i.test(v)) return false; // file paths
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(v) && !/\d{4,}/.test(v)) return false; // dotted/kebab identifiers
  // Random-looking: digits mixed with letters, long or in both cases.
  const upper = /[A-Z]/.test(v);
  const lower = /[a-z]/.test(v);
  return /\d/.test(v) && (upper || lower) && (v.length >= 20 || (upper && lower));
}

function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const { rule, pattern } of RULES) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
    }
    if (hex64Words(line).length > 0 && !allowedDigest(file, lines, index)) {
      findings.push({ file, line: index + 1, rule: 'hex-64' });
    }
    for (const match of line.matchAll(ASSIGNMENT)) {
      const value = match[2] ?? '';
      if (credentialShaped(value)) findings.push({ file, line: index + 1, rule: `assignment:${match[1]}` });
    }
  });
  return findings;
}

const TEXT_EXTENSIONS = /\.(?:md|json|jsonc|ya?ml|txt|toml|example)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (TEXT_EXTENSIONS.test(name)) out.push(full);
  }
  return out;
}

/** The files this scan covers, repository-relative. */
function scannedFiles(): string[] {
  const fixed = [
    'worker/.dev.vars.example',
    '.env.example',
    'config/atmusic.env.example',
    'config/atmusic.workers.example.jsonc',
    'worker/wrangler.jsonc',
    'README.md',
  ];
  const docs = walk(join(ROOT, 'docs')).map((f) => relative(ROOT, f).split(sep).join('/'));
  return [...fixed, ...docs];
}

/** Assignment lines (`NAME=` at line start, comments excluded) of an env-style file. */
function assignments(text: string): string[] {
  return text.split('\n').filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l));
}

describe('scripts/test/secret-scan.test.ts', () => {
  it('worker/.dev.vars.example, .env.example and docs contain no credential-shaped values', () => {
    // Negative controls: every rule fires on a generated sample, and the
    // documented placeholder forms do not.
    const hex = Array.from({ length: 32 }, (_, i) => ((i * 37 + 11) % 256).toString(16).padStart(2, '0')).join('');
    const mixed = `${'Q7x'.repeat(6)}9kP2`;
    const samples: Record<string, string> = {
      'assignment:CURSOR_KEY': `CURSOR_KEY=${hex}`,
      'assignment:ADMIN_TOKEN': `"ADMIN_TOKEN": "${mixed}"`,
      'assignment:CLOUDFLARE_API_TOKEN': `export CLOUDFLARE_API_TOKEN=${mixed}`,
      'pem-private-key': ['-----BEGIN', 'EC PRIVATE KEY-----'].join(' '),
      jwt: `${['eyJhbGciOiJFUzI1NiJ9', 'eyJzdWIiOiJkaWQ6cGxjOnRlc3QifQ', 'c2lnbmF0dXJlYnl0ZXM'].join('.')}`,
      'github-token': `ghp_${'a1B2'.repeat(9)}`,
      'aws-access-key': `aws_id = ${['AK', 'IA'].join('')}${'Q7X2'.repeat(4)}`,
      'slack-token': `SLACK=${['xo', 'xb'].join('')}-${'1234567890'}-${'a1B2c3D4e5'}`,
      'gitlab-token': `${['gl', 'pat'].join('')}-${'a1B2_c3D4-'.repeat(2)}`,
      'api-key-sk': `${['s', 'k'].join('')}-${'a1B2c3D4'.repeat(3)}`,
      'secret-put-literal': `echo ${hex} | npx wrangler secret put CURSOR_KEY`,
      'bearer-literal': `Authorization: Bearer ${mixed}`,
    };
    for (const [rule, sample] of Object.entries(samples)) {
      const rules = scanText('sample', sample).map((f) => f.rule);
      expect(rules, `${rule} sample: ${sample.slice(0, 20)}…`).toContain(rule);
    }
    // Every pattern rule has a generated sample above, so none is unproven.
    for (const { rule } of RULES) expect(Object.keys(samples), `no negative control for ${rule}`).toContain(rule);
    // The prefixed sk- forms fire too, and near misses of the provider
    // patterns (too short, or not at a word start) do not.
    for (const variant of ['ant-', 'proj-']) {
      const sample = `${['s', 'k'].join('')}-${variant}${'a1B2c3D4'.repeat(3)}`;
      expect(
        scanText('sample', sample).map((f) => f.rule),
        variant,
      ).toContain('api-key-sk');
    }
    for (const nearMiss of [
      `${['AK', 'IA'].join('')}${'Q7X2'.repeat(3)}`, // 12 characters after the prefix, not 16
      `${['xo', 'xb'].join('')}-short`,
      `${['gl', 'pat'].join('')}-${'a1B2'.repeat(4)}`, // 16, not 20
      `task-${'a1B2c3D4'.repeat(3)}`, // sk- not at a word start
    ]) {
      expect(scanText('sample', nearMiss), nearMiss).toEqual([]);
    }
    // The oracle's rule: a 64-hex word is a literal secret wherever it sits,
    // with or without a secret-shaped name, in either case, and even when a
    // line calls it a digest outside the digest records.
    const bareHex = [
      hex,
      hex.toUpperCase(),
      `CURSOR_KEY value ${hex}`,
      `wrangler secret put CURSOR_KEY <<< ${hex}`,
      `bundle sha256 ${hex}`,
      `\`${hex}\``,
      `x${hex}`, // x is not a hex digit, so the word is still 64 long
    ];
    for (const sample of bareHex) {
      expect(
        scanText('docs/deployment.md', sample).map((f) => f.rule),
        sample.slice(0, 24),
      ).toContain('hex-64');
    }
    // Exactly 64, as the oracle: 63 or 65 digits are not this rule's match.
    expect(scanText('docs/deployment.md', hex.slice(1))).toEqual([]);
    expect(scanText('docs/deployment.md', `a${hex}`)).toEqual([]);
    // The digest records allow only labelled digests: an unlabelled 64-hex
    // word in one of them is still flagged.
    expect(scanText('docs/VALIDATION.md', `- Archive SHA256: \`${hex}\``)).toEqual([]);
    expect(scanText('docs/adr/0002-oauth.md', `The text has SHA-256\n\`${hex}\`.`)).toEqual([]);
    expect(
      scanText('docs/verification/backend-production-inputs.json', `  "crates/core/src/lib.rs": "${hex}",`),
    ).toEqual([]);
    for (const [file, sample] of [
      ['docs/VALIDATION.md', `CURSOR_KEY ${hex}`],
      ['docs/adr/0002-oauth.md', `Some text\n${hex}`],
      ['docs/verification/backend-production-inputs.json', `  "CURSOR_KEY": "${hex}",`],
    ] as const) {
      expect(
        scanText(file, sample).map((f) => f.rule),
        `${file}: ${sample.slice(0, 12)}`,
      ).toContain('hex-64');
    }
    const placeholders = [
      'CURSOR_KEY=',
      'CURSOR_KEY=<64 hex characters from openssl rand -hex 32>',
      'ADMIN_TOKEN="$(openssl rand -hex 32)"',
      'export ADMIN_TOKEN="$ADMIN_TOKEN"',
      'openssl rand -hex 32 | npx wrangler secret put CURSOR_KEY',
      'Authorization: Bearer <ADMIN_TOKEN>',
      'cursorKey: CryptoKey',
      'signingKey: did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
      'bundle sha256 <64 hex digits printed by check-bundle>',
      'commit 8e158427716087b12e03cde41aaf225bb66ca0b8',
      'CURSOR_KEY (required, at least 32 bytes) and ADMIN_TOKEN (optional)',
    ];
    for (const text of placeholders) expect(scanText('placeholder', text), text).toEqual([]);

    // The real files.
    const files = scannedFiles();
    expect(files).toContain('docs/deployment.md');
    expect(files).toContain('docs/operations.md');
    expect(files.length).toBeGreaterThan(20);
    const findings = files.flatMap((file) => scanText(file, readFileSync(join(ROOT, file), 'utf8')));
    expect(findings).toEqual([]);
    // Every digest record is a scanned file, and none is an operator example
    // or a doc this package rewrote for operators.
    for (const record of Object.keys(DIGEST_RECORDS)) expect(files).toContain(record);
    for (const operatorFile of [
      'worker/.dev.vars.example',
      '.env.example',
      'config/atmusic.env.example',
      'README.md',
      'docs/deployment.md',
      'docs/backup.md',
      'docs/operations.md',
      'docs/workers.md',
      'docs/releases.md',
    ]) {
      expect(DIGEST_RECORDS[operatorFile], operatorFile).toBeUndefined();
    }

    // worker/.dev.vars.example names the secrets with empty values only.
    const devVars = readFileSync(join(ROOT, 'worker/.dev.vars.example'), 'utf8');
    expect(assignments(devVars)).toEqual(['CURSOR_KEY=']);
    expect(devVars).toMatch(/^# ADMIN_TOKEN=$/m);
    // .env.example and config/atmusic.env.example are pointers to it, with no
    // variables of the retired Rust executable left to fill in.
    for (const pointer of ['.env.example', 'config/atmusic.env.example']) {
      const text = readFileSync(join(ROOT, pointer), 'utf8');
      expect(text, pointer).toContain('worker/.dev.vars.example');
      expect(assignments(text), pointer).toEqual([]);
      expect(text, pointer).not.toMatch(/ATMUSIC_ENCRYPTION_KEY|ATMUSIC_METRICS_TOKEN/);
    }
  });
});
