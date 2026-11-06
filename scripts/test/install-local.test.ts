// scripts/install-local.sh (ADR 0005 §14.1, §14.3, §3.2; N4-02), run as the
// real script from a disposable git checkout with a temporary HOME. npm, npx,
// node, systemctl, loginctl and systemd-creds are stand-in scripts first on
// PATH that append their arguments, working directory and (for node --init)
// the names of their environment variables to a log; the stand-in npx
// "build" writes main.mjs and the stand-in npm writes web/dist, the stand-in
// node prints the embedded sha for --version; one --init fixture reports ready
// and exits on SIGTERM, while the timeout fixture withholds readiness and ignores
// SIGTERM so the installer's bounded SIGKILL escalation is exercised.
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
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs: string[] = [];
const preserveDirsOnCleanup = new Set<string>();
const linuxProcessInfo = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return { state: fields[0], startTime: fields[19] };
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    return undefined;
  }
};
const processIsReaped = (pid: number, startTime: string) => {
  const info = linuxProcessInfo(pid);
  return info === undefined || info.startTime !== startTime;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (preserveDirsOnCleanup.delete(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
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
    const initPidFile = join(root, 'init-pid');
    const initStopMarker = join(root, 'init-stop');
    for (const d of [home, runtime, bin]) mkdirSync(d, { recursive: true, mode: 0o700 });

    // The checkout the installer is run from: the script and the units.
    const src = join(root, 'src');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'install-local.sh'), join(src, 'scripts', 'install-local.sh'));
    cpSync(join(REPO, 'scripts', 'run_init.py'), join(src, 'scripts', 'run_init.py'));
    cpSync(join(REPO, 'config', 'systemd'), join(src, 'config', 'systemd'), { recursive: true });
    const servicePath = join(src, 'config', 'systemd', 'atmusic.service');
    const serviceContents = readFileSync(servicePath, 'utf8').replace(
      '\nEnvironment=NODE_ENV=production',
      '\n    Environment=NODE_ENV=production',
    );
    expect(serviceContents).toContain('    Environment=NODE_ENV=production');
    writeFileSync(servicePath, serviceContents);
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
  starttime="$(awk '{print $22}' "/proc/$$/stat")"
  printf '%s %s\\n' "$$" "$starttime" > ${JSON.stringify(initPidFile)} || exit 3
  [[ -n "$starttime" ]] || exit 3
  env | cut -d= -f1 | sort > ${JSON.stringify(initEnvLog)}
  printf '%s\\n' '__INIT_ENV_VALUES__' >> ${JSON.stringify(initEnvLog)}
  printf 'ATMUSIC_CLIENT_IP_HEADER=%s\\n' "\${ATMUSIC_CLIENT_IP_HEADER:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'ATMUSIC_LISTEN=%s\\n' "\${ATMUSIC_LISTEN:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'ATMUSIC_PUBLIC_ORIGIN=%s\\n' "\${ATMUSIC_PUBLIC_ORIGIN:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'ATMUSIC_SECRETS_FILE=%s\\n' "\${ATMUSIC_SECRETS_FILE:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'ATMUSIC_SIGNIN_DIDS=%s\\n' "\${ATMUSIC_SIGNIN_DIDS:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'FIXTURE_TEXT=%s\\n' "\${FIXTURE_TEXT:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'HOME=%s\\n' "\${HOME:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'INGEST_MODE=%s\\n' "\${INGEST_MODE:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'NODE_ENV=%s\\n' "\${NODE_ENV:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'PATH=%s\\n' "\${PATH:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'STATE_DIRECTORY=%s\\n' "\${STATE_DIRECTORY:-}" >> ${JSON.stringify(initEnvLog)}
  printf 'XDG_RUNTIME_DIR=%s\\n' "\${XDG_RUNTIME_DIR:-}" >> ${JSON.stringify(initEnvLog)}
  mkdir -p "$STATE_DIRECTORY"; : > "$STATE_DIRECTORY/atmusic.db"
  trap 'exit 0' TERM
  echo '{"listen":"127.2.0.1:8888","level":"info","event":"run.ready"}'
  while [[ ! -e ${JSON.stringify(initStopMarker)} ]]; do sleep 0.05; done
fi
exit 3`,
    );
    for (const name of ['systemctl', 'loginctl', 'systemd-creds']) stub(bin, name, log, 'exit 0');

    // The operator's config: atmusic.env and a plaintext secrets file for the init run.
    mkdirSync(join(home, '.config', 'atmusic'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, '.config', 'atmusic', 'atmusic.env'),
      '# test\nATMUSIC_CLIENT_IP_HEADER=cf-connecting-ip\nATMUSIC_SIGNIN_DIDS="did:plc:abcdefghijklmnopqrstuvwx"\nFIXTURE_TEXT="quoted space *"\n',
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
      spawnSync('bash', [join(src, 'scripts', 'install-local.sh'), ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 15_000,
      });

    // --- First install: build, units, --init, switch, printed commands. -------
    const prefix = join(home, '.local', 'lib', 'atmusic');
    const release1 = join(prefix, 'releases', sha1);
    const current = join(prefix, 'current');
    rmSync(initPidFile, { force: true });
    rmSync(initStopMarker, { force: true });
    const first = install();
    let firstInitPid = 0;
    let firstInitStartTime = '';
    try {
      expect(existsSync(initPidFile), `${first.stdout}\n${first.stderr}`).toBe(true);
      const [pidText, startTime] = readFileSync(initPidFile, 'utf8').trim().split(/\s+/);
      firstInitPid = Number(pidText);
      firstInitStartTime = startTime ?? '';
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      expect(firstInitPid).toBeGreaterThan(0);
      expect(firstInitStartTime).toBeTruthy();
      expect(processIsReaped(firstInitPid, firstInitStartTime)).toBe(true);
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
      const summaryIndex = initEnv.indexOf('__INIT_ENV_VALUES__');
      expect(summaryIndex).toBeGreaterThan(0);
      expect(initEnv.slice(0, summaryIndex).filter((name) => !['_', 'PWD', 'SHLVL'].includes(name))).toEqual(
        [
          'ATMUSIC_CLIENT_IP_HEADER',
          'ATMUSIC_LISTEN',
          'ATMUSIC_PUBLIC_ORIGIN',
          'ATMUSIC_SECRETS_FILE',
          'ATMUSIC_SIGNIN_DIDS',
          'FIXTURE_TEXT',
          'HOME',
          'INGEST_MODE',
          'NODE_ENV',
          'PATH',
          'STATE_DIRECTORY',
          'XDG_RUNTIME_DIR',
        ].sort(),
      );
      const expectedInitEnv = {
        ATMUSIC_CLIENT_IP_HEADER: 'cf-connecting-ip',
        ATMUSIC_LISTEN: '127.2.0.1:8888',
        ATMUSIC_PUBLIC_ORIGIN: 'https://music.214510.xyz',
        ATMUSIC_SECRETS_FILE: secrets,
        ATMUSIC_SIGNIN_DIDS: 'did:plc:abcdefghijklmnopqrstuvwx',
        FIXTURE_TEXT: 'quoted space *',
        HOME: home,
        INGEST_MODE: 'off',
        NODE_ENV: 'production',
        PATH: env.PATH,
        STATE_DIRECTORY: join(home, '.local', 'state', 'atmusic'),
        XDG_RUNTIME_DIR: runtime,
      };
      const environmentLines = initEnv.slice(summaryIndex + 1, summaryIndex + 1 + Object.keys(expectedInitEnv).length);
      const observedInitEnv = Object.fromEntries(
        environmentLines.map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      expect(observedInitEnv).toEqual(expectedInitEnv);
      for (const name of ['NODE_OPTIONS', 'HTTPS_PROXY', 'LANG', 'LC_CTYPE']) expect(initEnv, name).not.toContain(name);
      expect(existsSync(join(stateDir, 'atmusic.db'))).toBe(true);
      expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);

      // current is a relative symlink to the release, switched by rename (no current.tmp left).
      expect(lstatSync(current).isSymbolicLink()).toBe(true);
      expect(readlinkSync(current)).toBe(`releases/${sha1}`);
      expect(existsSync(join(prefix, 'current.tmp'))).toBe(false);

      // Both units, byte for byte from the release.
      const unitDir = join(home, '.config', 'systemd', 'user');
      for (const unit of ['atmusic.service', 'atmusic.socket']) {
        expect(readFileSync(join(unitDir, unit), 'utf8'), unit).toBe(
          readFileSync(join(release1, 'config', 'systemd', unit), 'utf8'),
        );
        expect(lstatSync(join(unitDir, unit)).mode & 0o777).toBe(0o644);
      }

      // Printed, not run: no systemctl, loginctl or systemd-creds call at all.
      expect(first.stdout).toContain('  loginctl enable-linger\n');
      expect(first.stdout).toContain('  systemctl --user daemon-reload\n');
      expect(first.stdout).toContain('  systemctl --user enable --now atmusic\n');
      expect(calls(log).filter((c) => ['systemctl', 'loginctl', 'systemd-creds'].includes(c.name))).toEqual([]);
    } finally {
      writeFileSync(initStopMarker, 'stop\n');
      const identityVerified = firstInitPid > 0 && firstInitStartTime.length > 0;
      let reaped = identityVerified && processIsReaped(firstInitPid, firstInitStartTime);
      for (let attempt = 0; identityVerified && attempt < 20 && !reaped; attempt++) {
        execFileSync('sleep', ['0.05']);
        reaped = processIsReaped(firstInitPid, firstInitStartTime);
      }
      if (!reaped) preserveDirsOnCleanup.add(root);
      expect(reaped, `first-install init child not reaped; fixture preserved at ${root}`).toBe(true);
    }

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

  it('restores unit/link state on failures, retries cleanly, and retains recovery copies if rollback itself fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'atmusic-install-failure-'));
    dirs.push(root);
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const tmpDir = join(root, 'tmp');
    const log = join(root, 'calls.log');
    const failOnce = join(root, 'failed-build.once');
    const failSwitchOnce = join(root, 'failed-switch.once');
    const allowRestoreFailure = join(root, 'allow-restore-failure');
    const failRestoreOnce = join(root, 'failed-restore.once');
    const initPidFile = join(root, 'init-pid');
    const initStopMarker = join(root, 'init-stop');
    const failRunInit = join(root, 'fail-run-init.once');
    const secretsFile = join(root, 'fixture-secrets.json');
    const prefix = join(home, '.local', 'lib', 'atmusic');
    const oldSha = 'a'.repeat(40);
    const oldRelease = join(prefix, 'releases', oldSha);
    const current = join(prefix, 'current');
    const unitDir = join(home, '.config', 'systemd', 'user');
    for (const d of [home, bin, tmpDir, join(home, '.local', 'state', 'atmusic'), oldRelease, unitDir])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    // A fixture database avoids --init; the old release/link/units model an upgrade.
    writeFileSync(join(home, '.local', 'state', 'atmusic', 'atmusic.db'), 'fixture database');
    writeFileSync(join(oldRelease, '.atmusic-release'), `${oldSha}\n`);
    execFileSync('ln', ['-s', `releases/${oldSha}`, current]);
    for (const unit of ['atmusic.service', 'atmusic.socket']) writeFileSync(join(unitDir, unit), `old ${unit}\n`);
    chmodSync(join(unitDir, 'atmusic.service'), 0o444);
    writeFileSync(secretsFile, '{}');
    chmodSync(secretsFile, 0o600);
    writeFileSync(join(prefix, 'current.tmp'), 'operator-owned current temp\n');
    for (const unit of ['atmusic.service', 'atmusic.socket'])
      writeFileSync(join(unitDir, `${unit}.tmp`), `operator-owned ${unit} temp\n`);
    const assertTempSentinels = () => {
      expect(readFileSync(join(prefix, 'current.tmp'), 'utf8')).toBe('operator-owned current temp\n');
      for (const unit of ['atmusic.service', 'atmusic.socket'])
        expect(readFileSync(join(unitDir, `${unit}.tmp`), 'utf8')).toBe(`operator-owned ${unit} temp\n`);
    };

    const src = join(root, 'src');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'scripts', 'install-local.sh'), join(src, 'scripts', 'install-local.sh'));
    cpSync(join(REPO, 'scripts', 'run_init.py'), join(src, 'scripts', 'run_init.py'));
    cpSync(join(REPO, 'config', 'systemd'), join(src, 'config', 'systemd'), { recursive: true });
    writeFileSync(join(src, 'README.md'), 'failure retry fixture\n');
    git(src, 'init', '-q');
    git(src, 'add', '-A');
    git(src, 'commit', '-q', '-m', 'retryable release');
    const sha = git(src, 'rev-parse', 'HEAD');

    stub(
      bin,
      'npm',
      log,
      `if [[ "\${1:-}" == ci && "\${2:-}" == --ignore-scripts && ! -e ${JSON.stringify(failOnce)} ]]; then
  : > ${JSON.stringify(failOnce)}
  exit 23
fi
if [[ "\${1:-}" == run && "\${2:-}" == build:web ]]; then
  mkdir -p web/dist
  printf '%s\\n' '<!doctype html>' > web/dist/index.html
fi`,
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
      `main=''; version=0; init=0
for a in "$@"; do case "$a" in *.mjs) main="$a";; --version) version=1;; --init) init=1;; esac; done
if ((version == 1)); then cat "$(dirname "$main")/.sha"; exit 0; fi
if ((init == 1)); then starttime="$(awk '{print $22}' "/proc/$$/stat")"; printf '%s %s\\n' "$$" "$starttime" > ${JSON.stringify(initPidFile)} || exit 3; [[ -n "$starttime" ]] || exit 3; trap '' TERM; while [[ ! -e ${JSON.stringify(initStopMarker)} ]]; do sleep 0.05; done; exit 0; fi
exit 3`,
    );
    stub(
      bin,
      'python3',
      log,
      `if [[ -e ${JSON.stringify(failRunInit)} && "\${2:-}" == */run_init.py && "\${3:-}" != --check ]]; then
  printf '%s\\n' 'fixture: simulated supervisor cleanup failure' >&2
  exit 75
fi
exec /usr/bin/python3 "$@"`,
    );
    stub(
      bin,
      'mv',
      log,
      `if [[ "\${1:-}" == -Tf && "\${@: -1}" == ${JSON.stringify(current)} && ! -e ${JSON.stringify(failSwitchOnce)} ]]; then
  : > ${JSON.stringify(failSwitchOnce)}
  exit 23
fi
if [[ "\${1:-}" == -Tf && "\${3:-}" == */.atmusic-unit-restore.*/atmusic.service && -e ${JSON.stringify(allowRestoreFailure)} && "\${4:-}" == */atmusic.service && ! -e ${JSON.stringify(failRestoreOnce)} ]]; then
  : > ${JSON.stringify(failRestoreOnce)}
  exit 24
fi
exec /usr/bin/mv "$@"`,
    );
    for (const name of ['systemctl', 'loginctl', 'systemd-creds']) stub(bin, name, log, 'exit 0');

    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: tmpDir,
      ATMUSIC_SECRETS_FILE: secretsFile,
      ATMUSIC_INIT_TIMEOUT_SECONDS: '1',
      ATMUSIC_INIT_STOP_GRACE_SECONDS: '1',
      BASH_ENV: '',
    };
    const install = () =>
      spawnSync('bash', [join(src, 'scripts', 'install-local.sh')], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 15_000,
      });
    const release = join(prefix, 'releases', sha);

    env.ATMUSIC_INIT_TIMEOUT_SECONDS = '901';
    const invalidInitTimeout = install();
    expect(invalidInitTimeout.status, `${invalidInitTimeout.stdout}\n${invalidInitTimeout.stderr}`).toBe(1);
    expect(invalidInitTimeout.stderr).toContain('ATMUSIC_INIT_TIMEOUT_SECONDS must be between 1 and 900');
    expect(calls(log)).toEqual([]);
    env.ATMUSIC_INIT_TIMEOUT_SECONDS = '1';

    const failed = install();
    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).toBe(23);
    expect(existsSync(release)).toBe(true); // git worktree remains, but has no completion marker
    expect(existsSync(join(release, '.atmusic-release'))).toBe(false);
    expect(readlinkSync(current)).toBe(`releases/${oldSha}`);
    expect(readFileSync(join(unitDir, 'atmusic.service'), 'utf8')).toBe(`old atmusic.service\n`);
    expect(readFileSync(join(home, '.local', 'state', 'atmusic', 'atmusic.db'), 'utf8')).toBe('fixture database');
    assertTempSentinels();
    expect(calls(log).map((c) => [c.name, c.cwd, c.args.join(' ')])).toEqual([['npm', release, 'ci --ignore-scripts']]);

    const switchFailed = install();
    expect(switchFailed.status, `${switchFailed.stdout}\n${switchFailed.stderr}`).toBe(23);
    expect(switchFailed.stdout).toContain(`removing the incomplete release ${release}`);
    expect(readFileSync(join(release, '.atmusic-release'), 'utf8')).toBe(`${sha}\n`);
    expect(readlinkSync(current)).toBe(`releases/${oldSha}`);
    assertTempSentinels(); // fixed-name paths owned by the test operator were untouched
    expect(readFileSync(join(home, '.local', 'state', 'atmusic', 'atmusic.db'), 'utf8')).toBe('fixture database');
    for (const unit of ['atmusic.service', 'atmusic.socket'])
      expect(readFileSync(join(unitDir, unit), 'utf8')).toBe(`old ${unit}\n`); // rollback restored both units
    expect(lstatSync(join(unitDir, 'atmusic.service')).mode & 0o777).toBe(0o444);

    const retried = install();
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(retried.stdout).toContain(`release ${sha} is already built`);
    expect(readlinkSync(current)).toBe(`releases/${sha}`);
    assertTempSentinels();
    const db = join(home, '.local', 'state', 'atmusic', 'atmusic.db');
    rmSync(db);
    for (const unit of ['atmusic.service', 'atmusic.socket']) writeFileSync(join(unitDir, unit), `pre-init ${unit}\n`);
    mkdirSync(join(home, '.config', 'atmusic'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.config', 'atmusic', 'atmusic.env'), 'ATMUSIC_CLIENT_IP_HEADER=cf-connecting-ip\n');
    rmSync(initPidFile, { force: true });
    rmSync(initStopMarker, { force: true });
    const initStarted = performance.now();
    const initTimedOut = install();
    let initPid = 0;
    let initStartTime = '';
    let initWorkdir: string | undefined;
    try {
      expect(existsSync(initPidFile), `${initTimedOut.stdout}\n${initTimedOut.stderr}`).toBe(true);
      const [pidText, startTime] = readFileSync(initPidFile, 'utf8').trim().split(/\s+/);
      initPid = Number(pidText);
      initStartTime = startTime ?? '';
      initWorkdir = /retaining initialization workdir ([^\s]+) because/.exec(initTimedOut.stderr)?.[1];
      expect(performance.now() - initStarted).toBeLessThan(10_000);
      expect(initTimedOut.status, `${initTimedOut.stdout}\n${initTimedOut.stderr}`).toBe(1);
      expect(initTimedOut.stderr).toContain('main.mjs --init did not report ready');
      expect(initTimedOut.stderr).toContain('sending SIGKILL');
      expect(Number.isInteger(initPid)).toBe(true);
      expect(initStartTime).toBeTruthy();
      expect(processIsReaped(initPid, initStartTime)).toBe(true); // installer reaped the normal SIGKILL exit
      expect(readlinkSync(current)).toBe(`releases/${sha}`);
      assertTempSentinels();
      expect(existsSync(db)).toBe(false);
      expect(readdirSync(tmpDir)).toEqual([]); // composed initialization cleanup removed its workdir
      for (const unit of ['atmusic.service', 'atmusic.socket'])
        expect(readFileSync(join(unitDir, unit), 'utf8')).toBe(`pre-init ${unit}\n`);
    } finally {
      writeFileSync(initStopMarker, 'stop\\n');
      const identityVerified = initPid > 0 && initStartTime.length > 0;
      let reaped = identityVerified && processIsReaped(initPid, initStartTime);
      for (let attempt = 0; identityVerified && attempt < 20 && !reaped; attempt++) {
        execFileSync('sleep', ['0.05']);
        reaped = processIsReaped(initPid, initStartTime);
      }
      if (initWorkdir && reaped) rmSync(initWorkdir, { recursive: true, force: true });
      if (!reaped) preserveDirsOnCleanup.add(root);
      expect(reaped, `timeout init child not reaped; fixture preserved at ${root}`).toBe(true);
    }

    writeFileSync(failRunInit, 'enabled\n');
    const signalFailureStarted = performance.now();
    const initSignalFailure = install();
    rmSync(failRunInit, { force: true });
    const retainedWorkdir = /retaining initialization workdir ([^\s]+) because/.exec(initSignalFailure.stderr)?.[1];
    expect(performance.now() - signalFailureStarted).toBeLessThan(10_000);
    expect(initSignalFailure.status, `${initSignalFailure.stdout}\n${initSignalFailure.stderr}`).toBe(1);
    expect(initSignalFailure.stderr).toContain('fixture: simulated supervisor cleanup failure');
    expect(retainedWorkdir).toBeTruthy();
    if (!retainedWorkdir) throw new Error(initSignalFailure.stderr);
    expect(existsSync(retainedWorkdir)).toBe(true);
    expect(readdirSync(tmpDir)).toHaveLength(1);
    expect(existsSync(db)).toBe(false);
    expect(readlinkSync(current)).toBe(`releases/${sha}`);
    assertTempSentinels();
    for (const unit of ['atmusic.service', 'atmusic.socket'])
      expect(readFileSync(join(unitDir, unit), 'utf8')).toBe(`pre-init ${unit}\n`);
    rmSync(retainedWorkdir, { recursive: true, force: true });
    expect(readdirSync(tmpDir)).toEqual([]);

    writeFileSync(db, 'fixture database');
    rmSync(failSwitchOnce);
    writeFileSync(allowRestoreFailure, 'enabled');
    for (const unit of ['atmusic.service', 'atmusic.socket'])
      writeFileSync(join(unitDir, unit), `pre-rollback ${unit}\n`);
    const rollbackFailed = install();
    expect(rollbackFailed.status, `${rollbackFailed.stdout}\n${rollbackFailed.stderr}`).toBe(23);
    expect(rollbackFailed.stderr).toContain('could not fully restore prior unit files');
    const recoveryDir = /recovery copies retained at ([^\r\n]+)/.exec(rollbackFailed.stderr)?.[1];
    expect(recoveryDir).toBeTruthy();
    if (!recoveryDir) throw new Error(rollbackFailed.stderr);
    expect(existsSync(recoveryDir)).toBe(true);
    expect(readFileSync(join(recoveryDir, 'atmusic.service'), 'utf8')).toBe('pre-rollback atmusic.service\n');
    expect(readFileSync(join(recoveryDir, 'atmusic.socket'), 'utf8')).toBe('pre-rollback atmusic.socket\n');
    expect(readlinkSync(current)).toBe(`releases/${sha}`);
    assertTempSentinels();
    expect(readFileSync(join(unitDir, 'atmusic.socket'), 'utf8')).toBe('pre-rollback atmusic.socket\n');
    expect(readFileSync(join(unitDir, 'atmusic.service'), 'utf8')).toBe(
      readFileSync(join(REPO, 'config', 'systemd', 'atmusic.service'), 'utf8'),
    );
    const buildCalls = calls(log)
      .filter((c) => ['npm', 'npx', 'node'].includes(c.name))
      .map((c) => [c.name, c.cwd, c.args.join(' ')]);
    expect(buildCalls).toEqual([
      ['npm', release, 'ci --ignore-scripts'],
      ['npm', release, 'ci --ignore-scripts'],
      ['npm', release, 'run build:web'],
      ['npx', release, 'tsx scripts/build-server.ts'],
      ['node', root, `${release}/worker/dist/node/main.mjs --version`],
      ['node', release, `--enable-source-maps ${release}/worker/dist/node/main.mjs --init`],
    ]);
    expect(calls(log).filter((c) => c.name === 'mv' && c.args[0] === '-Tf' && c.args.at(-1) === current)).toHaveLength(
      3,
    );
    expect(calls(log).filter((c) => ['systemctl', 'loginctl', 'systemd-creds'].includes(c.name))).toEqual([]);
  }, 60_000);
});
