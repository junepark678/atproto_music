import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('deploys the exact checked master commit and avoids rebuilding an already running release', () => {
  const root = mkdtempSync(join(tmpdir(), 'atmusic-deploy-'));
  try {
    const remote = join(root, 'remote');
    const checkout = join(root, 'checkout');
    const bin = join(root, 'bin');
    const runtime = join(root, 'run');
    for (const dir of [join(remote, 'scripts'), bin, runtime]) mkdirSync(dir, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const script = fileURLToPath(new URL('../deploy-master.sh', import.meta.url));
    cpSync(script, join(remote, 'scripts', 'deploy-master.sh'));
    writeFileSync(
      join(remote, 'scripts', 'install-local.sh'),
      `#!/usr/bin/env bash
set -eu
[[ "$1" == --no-init && "$2" == --rev && "$3" == "$TARGET_SHA" && "$(git rev-parse HEAD)" == "$TARGET_SHA" ]]
printf 'install\\n' >>"$DEPLOY_LOG"
mkdir -p "$PREFIX/releases/$3"
ln -sfn "releases/$3" "$PREFIX/current"
`,
    );
    git(remote, 'init', '-b', 'master');
    git(remote, 'add', '.');
    git(remote, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Running release');
    const installed = git(remote, 'rev-parse', 'HEAD');
    git(root, 'clone', remote, checkout);
    const origin = 'https://github.com/example/atmusic';
    git(checkout, 'remote', 'set-url', 'origin', origin);
    git(checkout, 'config', `url.${remote}.insteadOf`, origin);
    git(
      remote,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'New release',
    );
    const target = git(remote, 'rev-parse', 'HEAD');

    const prefix = join(root, '.local', 'lib', 'atmusic');
    const current = join(prefix, 'current');
    const log = join(root, 'calls');
    const verdict = join(root, 'workflow');
    mkdirSync(join(prefix, 'releases', installed), { recursive: true });
    symlinkSync(`releases/${installed}`, current);
    const stub = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
    stub(
      'curl',
      `case "\${@: -1}" in
    "https://api.github.com/repos/example/atmusic/actions/workflows/ci.yml/runs?branch=master&event=push&head_sha=$TARGET_SHA&per_page=1") cat "$CI_RESPONSE" ;;
    http://127.2.0.1:8888/health/ready) printf 'ready\\n' >>"$DEPLOY_LOG" ;;
    *) exit 2 ;;
  esac`,
    );
    stub(
      'systemctl',
      `case "$2" in
    daemon-reload | restart) printf '%s\\n' "$2" >>"$DEPLOY_LOG" ;;
    show) echo 123 ;;
    *) exit 2 ;;
  esac`,
    );
    stub(
      'readlink',
      `if [[ "$*" == '-f /proc/123/cwd' ]]; then
    /usr/bin/readlink -f "$PREFIX/current"
  else
    exec /usr/bin/readlink "$@"
  fi`,
    );
    const run = (status: string, conclusion: string | null, sha = target) => {
      writeFileSync(
        verdict,
        JSON.stringify({
          workflow_runs: [{ head_sha: sha, head_branch: 'master', event: 'push', status, conclusion }],
        }),
      );
      return spawnSync('bash', [join(checkout, 'scripts', 'deploy-master.sh')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          PATH: `${bin}:${process.env.PATH}`,
          XDG_RUNTIME_DIR: runtime,
          PREFIX: prefix,
          TARGET_SHA: target,
          DEPLOY_LOG: log,
          CI_RESPONSE: verdict,
        },
      });
    };
    const failed = run('completed', 'failure');
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout).toContain('waiting for passing CI');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(installed);
    expect(readlinkSync(current)).toBe(`releases/${installed}`);

    const wrongCommit = run('completed', 'success', installed);
    expect(wrongCommit.status).toBe(1);
    expect(wrongCommit.stderr).toContain('does not match the deployment target');
    expect(readlinkSync(current)).toBe(`releases/${installed}`);

    const deployed = run('completed', 'success');
    expect(deployed.status, deployed.stderr).toBe(0);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(target);
    expect(readlinkSync(current)).toBe(`releases/${target}`);
    expect(readFileSync(log, 'utf8')).toBe('install\ndaemon-reload\nrestart\nready\n');

    const unchanged = run('in_progress', null);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('install\ndaemon-reload\nrestart\nready\nready\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
