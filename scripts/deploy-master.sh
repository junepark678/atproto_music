#!/usr/bin/env bash
# Run from the dedicated deployment checkout. The timer installs passing master
# commits with the usual local installer, leaving the developer checkout alone.
set -euo pipefail

die() { printf 'deploy-master: %s\n' "$*" >&2; exit 1; }

ready() {
  local pid
  pid="$(systemctl --user show atmusic.service --property=MainPID --value)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$(readlink -f "/proc/$pid/cwd")" == "$1" ]] || return 1
  curl --fail --silent --show-error --noproxy '*' --max-time 5 "${@:2}" \
    http://127.2.0.1:8888/health/ready >/dev/null
}

main() {
  local checkout prefix dirty origin repo current installed target release checks conclusion
  checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$checkout"
  prefix="$HOME/.local/lib/atmusic"

  umask 077
  exec 9>"${XDG_RUNTIME_DIR:?}/atmusic-deploy.lock"
  flock -n 9 || die 'another deployment is running'
  [[ "$(git symbolic-ref --quiet --short HEAD)" == master ]] || die 'deployment checkout must be on master'
  dirty="$(git status --porcelain)"
  [[ -z "$dirty" ]] || die 'deployment checkout has local changes'
  origin="$(git config --get remote.origin.url)"
  repo="${origin#https://github.com/}"
  repo="${repo%.git}"
  [[ "$origin" == https://github.com/* && "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    die 'deployment origin must be a public GitHub HTTPS repository'

  git fetch --quiet --no-tags origin refs/heads/master:refs/remotes/origin/master
  target="$(git rev-parse --verify refs/remotes/origin/master^{commit})"
  current="$(readlink "$prefix/current")" || die 'an existing local installation is required'
  [[ "$current" =~ ^releases/([a-f0-9]{40})$ && -d "$prefix/$current" ]] ||
    die 'current does not point to an installed release'
  installed="${BASH_REMATCH[1]}"
  release="$prefix/releases/$target"
  if [[ "$installed" == "$target" ]] && ready "$release"; then
    return
  fi
  git merge-base --is-ancestor "$installed" "$target" ||
    die "master $target does not contain installed release $installed"

  checks="$(curl --fail --silent --show-error --max-time 20 \
    "https://api.github.com/repos/$repo/actions/workflows/ci.yml/runs?branch=master&event=push&head_sha=$target&per_page=1")"
  conclusion="$(printf '%s' "$checks" | node -e '
    const response = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(response.workflow_runs)) throw new Error("Missing workflow runs");
    const run = response.workflow_runs[0];
    if (!run) { console.log("pending"); process.exit(0); }
    if (run.head_sha !== process.argv[1] || run.head_branch !== "master" || run.event !== "push") {
      throw new Error("Workflow run does not match the deployment target");
    }
    console.log(run.status === "completed" ? run.conclusion : run.status);
  ' "$target")"
  if [[ "$conclusion" != success ]]; then
    printf 'deploy-master: waiting for passing CI on %s (%s)\n' "$target" "$conclusion"
    return
  fi

  git merge --ff-only "$target"
  if [[ "$installed" != "$target" ]]; then
    bash scripts/install-local.sh --no-init --rev "$target"
  fi
  systemctl --user daemon-reload
  systemctl --user restart atmusic.service
  ready "$release" --retry 10 --retry-delay 2 --retry-all-errors --retry-max-time 30 ||
    die "release $target failed local readiness"
  printf 'deploy-master: %s is running and ready\n' "$target"
}

main
