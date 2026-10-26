// scripts/install-local.sh (ADR 0005 §14.1, §14.3, §3.2; N4-02), run as the
// real script from a disposable git checkout with a temporary HOME. npm, npx,
// node, systemctl, loginctl and systemd-creds are stand-in scripts first on
// PATH that append their arguments, working directory and (for node --init)
// the names of their environment variables to a log; the stand-in npx
// "build" writes main.mjs and the stand-in npm writes web/dist, the stand-in
// node prints the embedded sha for --version and, for --init, creates the
// database file, reports run.ready and exits 0 on SIGTERM as the server does.
// Git is the real git on the disposable checkout. Nothing is installed into
// the real ~/.config/systemd/user, and no real systemctl or loginctl runs.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=atmusic test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

/** A stand-in command: logs `<name>\t<cwd>\t<args...>` (tab-separated) and runs `body`. */
function stub(bin: string, name: string, log: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s\\t%s' ${JSON.stringify(name)} "$PWD"; printf '\\t%s' "$@"; printf '\\n'; } >>${JSON.stringify(log)}
${body}
`,
  );
  chmodSync(path, 0o755);
}

interface Call {
  name: string;
  cwd: string;
  args: string[];
}

function calls(log: string): Call[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [name, cwd, ...args] = l.split('\t');
      return { name: name as string, cwd: cwd as string, args };
    });
}

describe('install-local.sh', () => {
  it('with a temporary HOME, install-local builds releases/<sha> with npm ci --ignore-scripts, runs main.mjs --init only when the database is missing, switches current atomically, installs both units and prints, but does not run, the linger command', () => {
    const root = mkdtempSync(join(tmpdir(), 'atmusic-install-'));
    dirs.push(root);
    const home = join(root, 'home');
    const runtime = join(root, 'run');
    const bin = join(root, 'bin');
    const log = join(root, 'calls.log');
    const initEnvLog = join(root, 'init-env.log');
    for (const d of [home, runtime, bin]) mkdirSync(d, { recursive: true, mode: 0o700 });

    // The checkout the installer is run from: the script and the units.
    const src = join(root, 'src');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'install-local.sh'), join(src, 'scripts', 'install-local.sh'));
    cpSync(join(REPO, 'config', 'systemd'), join(src, 'config', 'systemd'), { recursive: true });
    writeFileSync(join(src, 'README.md'), 'one\n');
    git(src, 'init', '-q');
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'release one');
    const sha1 = git(src, 'rev-parse', 'HEAD');

    stub(
      bin,
      'npm',
      log,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a template
      'if [[ "${1:-}" == run && "${2:-}" == build:web ]]; then mkdir -p web/dist; echo "<!doctype html>" > web/dist/index.html; fi',
    );
    stub(
      bin,
      'npx',
      log,
      'mkdir -p worker/dist/node; git rev-parse HEAD > worker/dist/node/.sha; echo "// bundle" > worker/dist/node/main.mjs',
    );
    stub(
      bin,
      'node',
      log,
      `main=''; init=0; version=0
for a in "$@"; do case "$a" in *.mjs) main="$a";; --init) init=1;; --version) version=1;; esac; done
if ((version == 1)); then cat "$(dirname "$main")/.sha"; exit 0; fi
if ((init == 1)); then
  env | cut -d= -f1 | sort > ${JSON.stringify(initEnvLog)}
  printf 'ATMUSIC_LISTEN=%s INGEST_MODE=%s STATE_DIRECTORY=%s\\n' "\${ATMUSIC_LISTEN:-}" "\${INGEST_MODE:-}" "\${STATE_DIRECTORY:-}" >> ${JSON.stringify(initEnvLog)}
  mkdir -p "$STATE_DIRECTORY"; : > "$STATE_DIRECTORY/atmusic.db"
  trap 'exit 0' TERM
  echo '{"listen":"127.2.0.1:8888","level":"info","event":"run.ready"}'
  while :; do sleep 0.05; done
fi
exit 3`,
    );
    for (const name of ['systemctl', 'loginctl', 'systemd-creds']) stub(bin, name, log, 'exit 0');

    // The operator's config: atmusic.env and a plaintext secrets file for the init run.
    mkdirSync(join(home, '.config', 'atmusic'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, '.config', 'atmusic', 'atmusic.env'),
      '# test\nATMUSIC_CLIENT_IP_HEADER=cf-connecting-ip\nATMUSIC_SIGNIN_DIDS="did:plc:abcdefghijklmnopqrstuvwx"\n',
    );
    const secrets = join(root, 'secrets.json');
    writeFileSync(secrets, '{}');
    chmodSync(secrets, 0o600);

    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_RUNTIME_DIR: runtime,
      ATMUSIC_SECRETS_FILE: secrets,
      // Inherited from a user manager, it must never reach the init run.
      NODE_OPTIONS: '--require /tmp/evil.js',
      HTTPS_PROXY: 'http://proxy.example.test:3128',
      LANG: 'C',
    };
    const install = (...args: string[]) =>
      spawnSync('bash', [join(src, 'scripts', 'install-local.sh'), ...args], { cwd: root, env, encoding: 'utf8' });

    // --- First install: build, units, --init, switch, printed commands. -------
    const first = install();
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const prefix = join(home, '.local', 'lib', 'atmusic');
    const release1 = join(prefix, 'releases', sha1);
    const firstCalls = calls(log);
    expect(firstCalls.map((c) => [c.name, c.cwd, c.args.join(' ')])).toEqual([
      ['npm', release1, 'ci --ignore-scripts'],
      ['npm', release1, 'run build:web'],
      ['npx', release1, 'tsx scripts/build-server.ts'],
      ['node', root, `${release1}/worker/dist/node/main.mjs --version`],
      ['node', release1, `--enable-source-maps ${release1}/worker/dist/node/main.mjs --init`],
    ]);
    // The release is a checkout of the commit, marked complete.
    expect(git(release1, 'rev-parse', 'HEAD')).toBe(sha1);
    expect(readFileSync(join(release1, '.atmusic-release'), 'utf8')).toBe(`${sha1}\n`);

    // The init run: the unit's Environment= values, atmusic.env, STATE_DIRECTORY,
    // INGEST_MODE=off and the secrets file, and no inherited variable.
    const stateDir = join(home, '.local', 'state', 'atmusic');
    const initEnv = readFileSync(initEnvLog, 'utf8').split('\n');
    for (const name of [
      'ATMUSIC_CLIENT_IP_HEADER',
      'ATMUSIC_LISTEN',
      'ATMUSIC_PUBLIC_ORIGIN',
      'ATMUSIC_SECRETS_FILE',
      'ATMUSIC_SIGNIN_DIDS',
      'INGEST_MODE',
      'NODE_ENV',
      'STATE_DIRECTORY',
    ]) {
      expect(initEnv, name).toContain(name);
    }
    for (const name of ['NODE_OPTIONS', 'HTTPS_PROXY', 'LANG']) expect(initEnv, name).not.toContain(name);
    expect(initEnv).toContain(`ATMUSIC_LISTEN=127.2.0.1:8888 INGEST_MODE=off STATE_DIRECTORY=${stateDir}`);
    expect(existsSync(join(stateDir, 'atmusic.db'))).toBe(true);
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);

    // current is a relative symlink to the release, switched by rename (no current.tmp left).
    const current = join(prefix, 'current');
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).toBe(`releases/${sha1}`);
    expect(existsSync(join(prefix, 'current.tmp'))).toBe(false);

    // Both units, byte for byte from the release.
    const unitDir = join(home, '.config', 'systemd', 'user');
    for (const unit of ['atmusic.service', 'atmusic.socket']) {
      expect(readFileSync(join(unitDir, unit), 'utf8'), unit).toBe(
        readFileSync(join(REPO, 'config', 'systemd', unit), 'utf8'),
      );
      expect(lstatSync(join(unitDir, unit)).mode & 0o777).toBe(0o644);
    }

    // Printed, not run: no systemctl, loginctl or systemd-creds call at all.
    expect(first.stdout).toContain('  loginctl enable-linger\n');
    expect(first.stdout).toContain('  systemctl --user daemon-reload\n');
    expect(first.stdout).toContain('  systemctl --user enable --now atmusic\n');
    expect(firstCalls.filter((c) => ['systemctl', 'loginctl', 'systemd-creds'].includes(c.name))).toEqual([]);

    // --- Upgrade to a second commit: the database exists, so no --init. -------
    writeFileSync(join(src, 'README.md'), 'two\n');
    git(src, 'commit', '-q', '-am', 'release two');
    const sha2 = git(src, 'rev-parse', 'HEAD');
    const before = calls(log).length;
    const second = install();
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    const release2 = join(prefix, 'releases', sha2);
    expect(
      calls(log)
        .slice(before)
        .map((c) => [c.name, c.cwd, c.args.join(' ')]),
    ).toEqual([
      ['npm', release2, 'ci --ignore-scripts'],
      ['npm', release2, 'run build:web'],
      ['npx', release2, 'tsx scripts/build-server.ts'],
      ['node', root, `${release2}/worker/dist/node/main.mjs --version`],
    ]);
    expect(second.stdout).toContain('exists; the server migrates it itself on start');
    expect(readlinkSync(current)).toBe(`releases/${sha2}`);
    expect(existsSync(join(prefix, 'current.tmp'))).toBe(false);
    // The previous release stays for rollback.
    expect(readFileSync(join(release1, '.atmusic-release'), 'utf8')).toBe(`${sha1}\n`);

    // --- Re-running for an installed release rebuilds nothing. ----------------
    const again = calls(log).length;
    const rerun = install('--rev', sha1);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(calls(log).slice(again)).toEqual([]);
    expect(readlinkSync(current)).toBe(`releases/${sha1}`);
    expect(calls(log).filter((c) => ['systemctl', 'loginctl'].includes(c.name))).toEqual([]);
  }, 120_000);
});
