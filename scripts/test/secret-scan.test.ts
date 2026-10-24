// Credential scan of the configuration examples and docs (plan case
// M6.1.3/secret_example_scan; ADR 0004 §8 "Server secrets"; W6-04).
//
// The operator-facing examples (worker/.dev.vars.example, .env.example,
// config/*.example*), the committed wrangler config, README.md and every text
// file under docs/ must contain no credential-shaped value: no PEM private
// key, JWT or provider token, no long random value assigned to a key, token,
// secret or password name, no literal piped into `wrangler secret put` and no
// literal bearer token. Placeholders (empty values, `<…>`, `$VAR`,
// `$(openssl rand -hex 32)`) are allowed. The scanner itself is proven by
// negative controls built at runtime, so this file holds no such literal.

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
      'secret-put-literal': `echo ${hex} | npx wrangler secret put CURSOR_KEY`,
      'bearer-literal': `Authorization: Bearer ${mixed}`,
    };
    for (const [rule, sample] of Object.entries(samples)) {
      const rules = scanText('sample', sample).map((f) => f.rule);
      expect(rules, `${rule} sample: ${sample.slice(0, 20)}…`).toContain(rule);
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
      `bundle sha256 ${hex}`,
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
