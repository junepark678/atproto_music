// scripts/check-node-bundle.ts (N3-07): the Node bundle guard. The suite
// builds the real main.mjs once into a temporary directory (never into
// worker/dist/node), runs the guard over it as the positive control, then
// feeds it metafiles and sources with exactly one defect each.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMain, MAIN_METAFILE } from '../build-server.ts';
import {
  analyzeNodeBundle,
  type BundleFacts,
  configuredConditions,
  type Finding,
  type Metafile,
  MIN_SCANNED_FILES,
  runGuard,
  scanSource,
  workerNodeCryptoBuild,
} from '../check-node-bundle.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
const NODE_BUILD = 'node_modules/@atcute/crypto/dist/keypairs/secp256k1-node.js';
const WEB_BUILD = 'node_modules/@atcute/crypto/dist/keypairs/secp256k1-web.js';

let dist: string;
let base: BundleFacts;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'atmusic-guard-'));
  await buildMain(dist, SHA);
  base = {
    metafile: JSON.parse(readFileSync(join(dist, MAIN_METAFILE), 'utf8')) as Metafile,
    inputHashes: JSON.parse(readFileSync(join(dist, 'main.inputs.json'), 'utf8')) as Record<string, string>,
    text: readFileSync(join(dist, 'main.mjs'), 'utf8'),
  };
}, 120_000);

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

const realSource = (path: string) => readFileSync(join(REPO, path), 'utf8');

function clone(facts: BundleFacts): BundleFacts {
  return JSON.parse(JSON.stringify(facts)) as BundleFacts;
}

function analyze(
  main: BundleFacts,
  options: { e2e?: BundleFacts; sources?: Record<string, string>; crypto?: string } = {},
): Finding[] {
  return analyzeNodeBundle({
    main,
    e2e: options.e2e ?? null,
    expectedCryptoBuild: options.crypto ?? NODE_BUILD,
    readSource: (path) => options.sources?.[path] ?? realSource(path),
  }).findings;
}

function withInput(facts: BundleFacts, path: string, imports: Array<{ path: string; external?: boolean }> = []) {
  const next = clone(facts);
  next.metafile.inputs[path] = { bytes: 1, imports };
  return next;
}

const rules = (findings: readonly Finding[]) => findings.map((f) => `${f.rule}:${f.file}`);

describe('check-node-bundle', () => {
  it('the guard fails when main.mjs has a test-support, worker/test or router-transport input, com.example.atmusic handling, or a cloudflare: import', () => {
    // The real bundle is clean: the positive control.
    expect(analyze(base)).toEqual([]);

    expect(rules(analyze(withInput(base, 'packages/core/test-support/clock.ts')))).toContain(
      'input:packages/core/test-support/clock.ts',
    );
    expect(analyze(withInput(base, 'worker/test/node/support/app.ts')).map((f) => f.message)).toContain(
      'main.mjs bundles a worker/test module',
    );
    const router = analyze(withInput(base, 'packages/atproto/test-support/router-transport.ts')).map((f) => f.message);
    expect(router).toContain('main.mjs bundles the fixture router transport');
    expect(router).toContain('main.mjs bundles a test-support module');

    // The fixture prefix outside its two definitions.
    const meta = 'worker/src/http/meta.ts';
    const handled = analyze(base, {
      sources: {
        [meta]: `${realSource(meta)}\nexport const isFixture = (p: string) => p === 'com.example.atmusic';\n`,
      },
    });
    expect(rules(handled)).toEqual([`fixture:${meta}`]);
    expect(handled[0]?.message).toMatch(/^com\.example\.atmusic handled at line \d+$/);
    const optIn = analyze(base, {
      sources: { [meta]: `${realSource(meta)}\nparseConfig(env, { allowFixturePrefix: true });\n` },
    });
    expect(optIn.map((f) => f.message)).toContainEqual(expect.stringMatching(/^allowFixturePrefix: true at line/));
    // The definitions themselves pass (they are in the clean bundle above).
    expect(scanSource('worker/src/config.ts', realSource('worker/src/config.ts'))).toEqual([]);
    expect(scanSource('packages/core/src/namespace.ts', realSource('packages/core/src/namespace.ts'))).toEqual([]);

    // cloudflare: imports, in the metafile or the bundle text.
    const imported = withInput(base, 'worker/src/node/compose.ts', [{ path: 'cloudflare:workers', external: true }]);
    imported.metafile.inputs['worker/src/node/compose.ts'] = {
      ...(base.metafile.inputs['worker/src/node/compose.ts'] ?? {}),
      imports: [{ path: 'cloudflare:workers', external: true }],
    };
    expect(analyze(imported).map((f) => f.message)).toContain('imports cloudflare:workers');
    const text = clone(base);
    text.text = `import { DurableObject } from "cloudflare:workers";\n${base.text}`;
    expect(analyze(text).map((f) => `${f.file}: ${f.message}`)).toEqual([
      'main.mjs: the bundle imports cloudflare:workers',
    ]);
  });

  it('the guard fails when main.mjs has worker/src/do/index-do.ts, worker/src/scheduled.ts, worker/src/env.ts, worker/src/index.ts or worker/src/router.ts as an input', () => {
    for (const input of [
      'worker/src/do/index-do.ts',
      'worker/src/scheduled.ts',
      'worker/src/env.ts',
      'worker/src/index.ts',
      'worker/src/router.ts',
    ]) {
      const findings = analyze(withInput(base, input), { sources: { [input]: 'export {};\n' } });
      expect([input, findings.map((f) => `${f.rule}:${f.file}: ${f.message}`)]).toEqual([
        input,
        [`input:${input}: main.mjs bundles a Workers-only module`],
      ]);
    }
    // The host-neutral replacements are inputs of the real bundle.
    expect(Object.keys(base.metafile.inputs)).toEqual(
      expect.arrayContaining(['worker/src/http/routes.ts', 'worker/src/app/index-core.ts']),
    );
  });

  it("the guard fails when the bundle's @atcute/crypto entry differs from the one the worker-node project resolves, and prints the git sha and bundle SHA-256 otherwise", () => {
    // Node's resolution of #keypairs/secp256k1 for the worker package.
    expect(workerNodeCryptoBuild(REPO)).toBe(NODE_BUILD);
    expect(Object.keys(base.metafile.inputs)).toContain(NODE_BUILD);
    expect(configuredConditions("resolve: { conditions: ['browser'] }")).toEqual(['browser']);
    expect(configuredConditions('// conditions: ["browser"]\nexport default {}')).toEqual([]);

    // A bundle of the other build.
    const web = clone(base);
    const entry = web.metafile.inputs[NODE_BUILD];
    delete web.metafile.inputs[NODE_BUILD];
    web.metafile.inputs[WEB_BUILD] = entry ?? { bytes: 1 };
    expect(analyze(web).map((f) => f.message)).toEqual([
      `the bundle's @atcute/crypto build is ${WEB_BUILD}, the worker-node project resolves ${NODE_BUILD}`,
    ]);
    // The CLI over the real build with a mismatching expectation: exit 1.
    const err: string[] = [];
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(runGuard({ dist, root: REPO, expectedCryptoBuild: WEB_BUILD }, io)).toBe(1);
    expect(err.join('\n')).toContain(`FAIL [crypto] main.mjs: the bundle's @atcute/crypto build is ${NODE_BUILD}`);
    expect(out).toEqual([]);

    // Otherwise: exit 0, the git sha main.mjs --version reports and the bundle SHA-256.
    err.length = 0;
    expect(runGuard({ dist, root: REPO }, io)).toBe(0);
    expect(err).toEqual([]);
    const sha256 = createHash('sha256')
      .update(readFileSync(join(dist, 'main.mjs')))
      .digest('hex');
    expect(out).toContain(`git sha ${SHA}`);
    expect(out).toContain(`bundle sha256 ${sha256}  main.mjs`);
    expect(out[0]).toMatch(/^PASS check-node-bundle: \d+ sources scanned/);
  }, 60_000);

  it('a production source passing fixtureOrigins: true, fixture: true as an option, routerTransport or a test-support import fails the call-site scan, while url-policy.ts fixture handling and the fixtureOrigins?: boolean parameter pass; a scan of fewer than 60 files fails as vacuous', () => {
    const file = 'worker/src/node/features.ts';
    const scan = (source: string) => scanSource(file, source).map((f) => f.message);
    expect(scan('const config = parseNodeConfig(env, { fixtureOrigins: true });\n')).toEqual([
      'fixtureOrigins: true at line 1',
    ]);
    expect(scan('const t = Object.assign(transport, {\n  fixture: true,\n});\n')).toEqual([
      'fixture: true passed as a value at line 2',
    ]);
    expect(scan("import { routerTransport } from '@atmusic/atproto/test-support/router-transport';\n")).toEqual([
      'imports from a test-support path',
      'routerTransport at line 1',
    ]);
    expect(scan("const fake = await import('../../test-support/fake-pds');\n")).toEqual([
      'imports from a test-support path',
    ]);
    expect(scan('const t = fixtureTransport(hosts);\n')).toEqual(['fixtureTransport at line 1']);
    expect(scan('const c = fixedClock();\nconst r = seededRandom(1);\n')).toEqual([
      'fixedClock at line 1',
      'seededRandom at line 2',
    ]);
    // Comments and strings are not call sites; a type position is not a value.
    expect(scan('// parseNodeConfig(env, { fixtureOrigins: true })\n/* routerTransport */\n')).toEqual([]);
    expect(scan("const message = 'requires a Transport marked fixture: true';\n")).toEqual([]);
    expect(scan('export type T = Transport & { readonly fixture: true };\n')).toEqual([]);
    expect(scan('export interface Opts {\n  fixtureOrigins?: boolean;\n}\n')).toEqual([]);
    // The real fixture-mode modules pass.
    for (const path of [
      'packages/atproto/src/net/url-policy.ts',
      'packages/atproto/src/net/safe-fetch.ts',
      'packages/atproto/src/identity/did-doc.ts',
      'worker/src/node/config.ts',
    ]) {
      expect([path, scanSource(path, realSource(path))]).toEqual([path, []]);
    }
    // Inside the bundle analysis, a defect in one input is reported against it.
    const config = 'worker/src/node/run.ts';
    const bad = analyze(base, {
      sources: { [config]: `${realSource(config)}\nparseNodeConfig(env, { fixtureOrigins: true });\n` },
    });
    expect(rules(bad)).toEqual([`fixture:${config}`]);

    // Non-vacuity: at least 60 files, and the opt-in parameter must be found.
    const ours = Object.keys(base.metafile.inputs).filter((p) => /^(worker\/src|packages\/[^/]+\/src)\//.test(p));
    expect(ours.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    const small = clone(base);
    for (const p of ours.filter((p) => p !== 'worker/src/node/config.ts').slice(MIN_SCANNED_FILES - 2)) {
      delete small.metafile.inputs[p];
    }
    expect(analyze(small).map((f) => `${f.rule}: ${f.message}`)).toEqual([
      `vacuous: the call-site scan covered ${MIN_SCANNED_FILES - 1} files, fewer than ${MIN_SCANNED_FILES}`,
    ]);
    const noParam = analyze(base, {
      sources: {
        'worker/src/node/config.ts': realSource('worker/src/node/config.ts').replace(
          /fixtureOrigins\?: boolean/g,
          'fixtureOrigins: boolean | undefined',
        ),
      },
    });
    expect(noParam.map((f) => `${f.rule}: ${f.message}`)).toEqual([
      'vacuous: the opt-in parameter `fixtureOrigins?: boolean` was not found',
    ]);
  });

  it('an e2e.mjs whose worker/src or packages/*/src inputs differ from main.mjs in any file other than worker/src/node/main.ts, or that adds an input outside worker/test/e2e, worker/test/node/support and test-support, fails', () => {
    const e2eOf = (facts: BundleFacts): BundleFacts => {
      const e2e = clone(facts);
      delete e2e.metafile.inputs['worker/src/node/main.ts'];
      delete e2e.inputHashes['worker/src/node/main.ts'];
      for (const input of [
        'worker/test/e2e/node-entry.ts',
        'worker/test/node/support/fake-lastfm.ts',
        'packages/atproto/test-support/router-transport.ts',
      ]) {
        e2e.metafile.inputs[input] = { bytes: 1 };
        e2e.inputHashes[input] = 'f'.repeat(64);
      }
      return e2e;
    };
    // The positive control: same sources, only allowed additions, no main.ts.
    expect(analyze(base, { e2e: e2eOf(base) })).toEqual([]);

    const changed = e2eOf(base);
    changed.inputHashes['worker/src/node/compose.ts'] = '0'.repeat(64);
    expect(analyze(base, { e2e: changed }).map((f) => `${f.file}: ${f.message}`)).toEqual([
      'worker/src/node/compose.ts: differs between main.mjs and e2e.mjs',
    ]);
    const missing = e2eOf(base);
    delete missing.metafile.inputs['packages/core/src/cursor.ts'];
    expect(analyze(base, { e2e: missing }).map((f) => `${f.file}: ${f.message}`)).toEqual([
      'packages/core/src/cursor.ts: is a main.mjs input missing from e2e.mjs',
    ]);
    for (const extra of [
      'worker/src/node/e2e-only.ts',
      'worker/test/http/meta.test.ts',
      'node_modules/left-pad/index.js',
    ]) {
      const added = e2eOf(base);
      added.metafile.inputs[extra] = { bytes: 1 };
      expect(analyze(base, { e2e: added }).map((f) => `${f.file}: ${f.message}`)).toEqual([
        `${extra}: e2e.mjs adds an input outside worker/test/e2e, worker/test/node/support and test-support`,
      ]);
    }
    const withMain = e2eOf(base);
    withMain.metafile.inputs['worker/src/node/main.ts'] = base.metafile.inputs['worker/src/node/main.ts'] ?? {
      bytes: 1,
    };
    withMain.inputHashes['worker/src/node/main.ts'] = base.inputHashes['worker/src/node/main.ts'] ?? '';
    expect(analyze(base, { e2e: withMain }).map((f) => `${f.file}: ${f.message}`)).toEqual([
      'worker/src/node/main.ts: e2e.mjs bundles the production entry',
    ]);

    // The CLI reads e2e.mjs and its metafiles from the dist directory when present.
    const copy = mkdtempSync(join(tmpdir(), 'atmusic-guard-e2e-'));
    try {
      cpSync(dist, copy, { recursive: true });
      const e2e = e2eOf(base);
      e2e.inputHashes['packages/core/src/cursor.ts'] = '1'.repeat(64);
      writeFileSync(join(copy, 'e2e.mjs'), 'export {};\n');
      writeFileSync(join(copy, 'e2e.meta.json'), JSON.stringify(e2e.metafile));
      writeFileSync(join(copy, 'e2e.inputs.json'), JSON.stringify(e2e.inputHashes));
      const err: string[] = [];
      expect(runGuard({ dist: copy, root: REPO }, { out: () => {}, err: (l) => err.push(l) })).toBe(1);
      expect(err).toContain('FAIL [e2e] packages/core/src/cursor.ts: differs between main.mjs and e2e.mjs');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 60_000);

  it('a main.mjs input other than pinned-transport.ts, policy-fetch.ts and the documented fallback sites that references globalThis.fetch or fetchTransport, or a createIdentityResolver call without transport, fails the unpinned-fetch rule', () => {
    const file = 'worker/src/lastfm/client.ts';
    const scan = (source: string, path = file) => scanSource(path, source).map((f) => f.message);
    expect(scan('export const get = (u: string) => globalThis.fetch(u);\n')).toEqual([
      'references globalThis.fetch at line 1',
    ]);
    expect(scan("import { fetchTransport } from '@atmusic/atproto/transport';\nconst t = fetchTransport;\n")).toEqual([
      'references fetchTransport at line 1',
    ]);
    expect(scan('export async function get(u: string) {\n  return await fetch(u);\n}\n')).toEqual([
      'calls the global fetch at line 2',
    ]);
    expect(scan('const r = ok ? fetch(a) : null;\n')).toEqual(['calls the global fetch at line 1']);
    // A method named fetch is a definition, not a call.
    expect(scan('const x = {\n  async fetch(request) {\n    return handle(request);\n  },\n};\n')).toEqual([]);
    expect(scan('interface F {\n  fetch(did: string): Promise<Response>;\n}\n')).toEqual([]);
    expect(scan('const r = await transport.fetch(req);\n')).toEqual([]);
    // The allowed sites.
    for (const path of [
      'worker/src/node/pinned-transport.ts',
      'worker/src/node/policy-fetch.ts',
      'packages/atproto/src/identity/resolver.ts',
      'packages/atproto/src/identity/handle.ts',
      'packages/atproto/src/net/safe-fetch.ts',
      'packages/atproto/src/transport.ts',
    ]) {
      expect([path, scan('const f = globalThis.fetch;\nconst t = fetchTransport;\n', path)]).toEqual([path, []]);
    }
    // run.ts may only install the stub.
    expect(scan('globalThis.fetch = unpinnedFetchStub as typeof fetch;\n', 'worker/src/node/run.ts')).toEqual([]);
    expect(scan('globalThis.fetch = myFetch;\n', 'worker/src/node/run.ts')).toEqual([
      'references globalThis.fetch at line 1',
    ]);

    // Production calls must pass their transport (or fetch for the OAuth client).
    expect(scan('const r = createIdentityResolver({ clock, cache });\n')).toEqual([
      'createIdentityResolver(…) at line 1 does not pass its transport property (ADR 0005 §3.5)',
    ]);
    expect(scan('const r = createIdentityResolver({ transport, clock });\n')).toEqual([]);
    expect(scan('const r = createIdentityResolver({ transport: deps.transport, clock });\n')).toEqual([]);
    expect(scan('const h = createHandleResolver({ ...options });\n')).toEqual([
      'createHandleResolver(…) at line 1 does not pass its transport property (ADR 0005 §3.5)',
    ]);
    expect(scan('const o = { transport: t, clock };\nconst s = createSafeFetch(o);\n')).toEqual([]);
    expect(scan('const s = createSafeFetch(options);\n')).toEqual([
      'createSafeFetch(…) at line 1 does not pass its transport property (ADR 0005 §3.5)',
    ]);
    expect(scan('const options = { clientMetadata, keyset };\nconst c = new NodeOAuthClient(options);\n')).toEqual([
      'new NodeOAuthClient(…) at line 2 does not pass its fetch property (ADR 0005 §3.5)',
    ]);
    expect(
      scan(
        'const options: Opts = {\n  clientMetadata,\n  fetch: bound,\n};\nconst c = new NodeOAuthClient(options);\n',
      ),
    ).toEqual([]);
    // The real OAuth client module (an input once N4-01 composes it) passes.
    expect(scanSource('worker/src/bff/oauth-client.ts', realSource('worker/src/bff/oauth-client.ts'))).toEqual([]);

    // In the bundle analysis: an input with an unpinned path fails the guard.
    const compose = 'worker/src/node/compose.ts';
    const findings = analyze(base, {
      sources: { [compose]: `${realSource(compose)}\nexport const leak = () => fetch('https://plc.directory/x');\n` },
    });
    expect(findings.map((f) => `${f.rule}:${f.file}`)).toEqual([`unpinned_fetch:${compose}`]);
  });
});
