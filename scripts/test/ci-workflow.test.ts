// CI's Rust job also runs Python regressions which invoke TS fixture gates.
// Actionlint validates YAML separately; these assertions protect prerequisite
// ordering that actionlint cannot infer from the subprocess dependency graph.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');

function job(name: string): string {
  const found = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm').exec(workflow);
  if (found === null) throw new Error(`missing CI job ${name}`);
  return found[1] as string;
}

describe('CI runtime prerequisites', () => {
  for (const [name, gate] of [
    ['check', 'bash scripts/check.sh'],
    ['ts', 'bash scripts/check-ts.sh'],
  ] as const) {
    it(`${name} installs pinned Node and locked workspaces before its mixed-language gate`, () => {
      const text = job(name);
      expect(text).toContain('uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
      expect(text).toContain('node-version-file: .nvmrc');
      const node = text.indexOf('node-version-file: .nvmrc');
      const install = text.indexOf('run: npm ci');
      const run = text.indexOf(`run: ${gate}`);
      expect(node).toBeGreaterThanOrEqual(0);
      expect(install).toBeGreaterThan(node);
      expect(run).toBeGreaterThan(install);
    });
  }
});

it('TypeScript and candidate gates pin Python 3.13 for streaming archive checks', () => {
  const ts = job('ts');
  const candidate = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/node-candidate.yml', import.meta.url)),
    'utf8',
  );
  for (const text of [ts, candidate]) {
    expect(text).toContain('uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065');
    expect(text).toContain('python-version: "3.13"');
    expect(text.indexOf('python-version: "3.13"')).toBeLessThan(text.indexOf('run: bash scripts/check-ts.sh'));
  }
});

it('CI and candidate checkouts do not persist credentials into artifacts', () => {
  const candidate = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/node-candidate.yml', import.meta.url)),
    'utf8',
  );
  for (const text of [job('check'), job('ts'), candidate]) {
    expect(text).toContain('persist-credentials: false');
  }
});

it('Node candidate workflow is manual, pinned, tested, audited and checksum-checked, with read-only permissions and no release publication', () => {
  const candidate = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/node-candidate.yml', import.meta.url)),
    'utf8',
  );
  expect(candidate).toContain('workflow_dispatch:');
  expect(candidate).not.toMatch(/^ {2}(?:push|pull_request):/m);
  expect(candidate).toContain('contents: read');
  expect(candidate).not.toContain('contents: write');
  expect(candidate).not.toMatch(/gh release|actions\/download-artifact/);
  expect(candidate).toContain('node-version-file: .nvmrc');
  expect(candidate).toContain('npm ci --ignore-scripts');
  const gate = candidate.indexOf('run: bash scripts/check-ts.sh');
  const acceptance = candidate.indexOf('run: npx tsx scripts/acceptance/node-recovery.ts');
  const packaging = candidate.indexOf('npx tsx scripts/package-node-release.ts --tag');
  expect(gate).toBeGreaterThan(candidate.indexOf('npm ci --ignore-scripts'));
  expect(acceptance).toBeGreaterThan(gate);
  expect(packaging).toBeGreaterThan(acceptance);
  expect(candidate).toContain('run: npm audit --omit=dev');
  expect(candidate).toContain('sha256sum -c SHA256SUMS');
});

// The full gate includes deploy.test.ts, which fails if actionlint is absent
// or not v1.7.7. Installing Go's module is not enough without GITHUB_PATH.
it('every full TypeScript gate workflow installs and exposes actionlint v1.7.7 before testing', () => {
  const candidate = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/node-candidate.yml', import.meta.url)),
    'utf8',
  );
  for (const text of [job('ts'), candidate]) {
    const install = text.indexOf(
      'GOBIN="$RUNNER_TEMP/bin" go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7',
    );
    const expose = text.indexOf('echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"');
    const gate = text.indexOf('run: bash scripts/check-ts.sh');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(expose).toBeGreaterThan(install);
    expect(gate).toBeGreaterThan(expose);
    expect(text.slice(install, gate)).not.toMatch(/continue-on-error|\|\| true/);
  }
});
