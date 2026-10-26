#!/usr/bin/env bash
# Install or upgrade atmusic as a systemd user service on this machine
# (ADR 0005 §14.1, §14.3, §3.2; N4-02). docs/deploy/local-node.md is the guide.
#
# Usage: scripts/install-local.sh [--enable] [--rev <git revision>]
#
#   --rev <rev>  the commit to install (default HEAD of this checkout)
#   --enable     also run the activation commands (linger, daemon-reload,
#                enable --now); without it they are only printed
#
# Steps:
#  1. Build the release outside the service, in
#     ~/.local/lib/atmusic/releases/<sha> (a detached git worktree of this
#     checkout): `npm ci --ignore-scripts` (no dependency install script ever
#     runs, ADR §13), `npm run build:web`, `npx tsx scripts/build-server.ts`,
#     then `node main.mjs --version` must print <sha>. A release directory is
#     complete only once its marker file is written, so an interrupted build is
#     removed and rebuilt on the next run; a complete one is reused.
#  2. Install config/systemd/atmusic.service and atmusic.socket of the release
#     into ~/.config/systemd/user (systemd itself is not touched).
#  3. When the database does not exist yet, run `main.mjs --init` once: the
#     server creates and migrates ATMUSIC_DB and reports ready, and is then
#     stopped with SIGTERM. It runs with exactly the unit's Environment= values,
#     ~/.config/atmusic/atmusic.env, STATE_DIRECTORY and INGEST_MODE=off, in an
#     otherwise empty environment (so no NODE_OPTIONS, proxy or SSL_CERT_*
#     variable can reach it), and with the secrets from ATMUSIC_SECRETS_FILE,
#     else ~/.config/atmusic/secrets.cred decrypted by systemd-creds into a
#     private runtime directory that is removed afterwards, else
#     ~/.config/atmusic/secrets.json. An existing database is never touched
#     here: the server takes its own pre-migration backup and migrates it when
#     it starts (ADR §3.10).
#  4. Switch ~/.local/lib/atmusic/current to the release atomically
#     (`ln -sfn releases/<sha> current.tmp && mv -T current.tmp current`).
#     Older releases stay for rollback (a link switch back, ADR §14.3).
#  5. Print the activation commands; run them only with --enable. Linger is
#     never touched without --enable.
#
# Environment: HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR as usual;
# ATMUSIC_SECRETS_FILE (optional, see 3); ATMUSIC_INIT_TIMEOUT_SECONDS
# (default 300) bounds step 3.
set -euo pipefail

usage() {
  echo 'usage: scripts/install-local.sh [--enable] [--rev <git revision>]' >&2
  exit 2
}

enable=0
rev=HEAD
while (($# > 0)); do
  case "$1" in
    --enable) enable=1; shift ;;
    --rev) (($# >= 2)) || usage; rev="$2"; shift 2 ;;
    --rev=*) rev="${1#--rev=}"; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "install-local.sh: unknown argument: $1" >&2; usage ;;
  esac
done

say() { printf 'install-local: %s\n' "$*"; }
die() { printf 'install-local: %s\n' "$*" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -n "${HOME:-}" ]] || die 'HOME is not set'
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
PREFIX="$HOME/.local/lib/atmusic"
RELEASES="$PREFIX/releases"
UNIT_DIR="$CONFIG_HOME/systemd/user"
CONF_DIR="$CONFIG_HOME/atmusic"
STATE_DIR="$STATE_HOME/atmusic"
ENV_FILE="$CONF_DIR/atmusic.env"
INIT_TIMEOUT="${ATMUSIC_INIT_TIMEOUT_SECONDS:-300}"
[[ "$INIT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'ATMUSIC_INIT_TIMEOUT_SECONDS must be a positive integer'

umask 077

sha="$(git -C "$REPO" rev-parse --verify --quiet "${rev}^{commit}")" || die "not a commit: $rev"
release="$RELEASES/$sha"
marker="$release/.atmusic-release"
main_mjs="$release/worker/dist/node/main.mjs"

# --- 1. Build the release ----------------------------------------------------
mkdir -p "$RELEASES"
if [[ -f "$marker" && "$(cat "$marker")" == "$sha" ]]; then
  say "release $sha is already built"
else
  if [[ -e "$release" ]]; then
    say "removing the incomplete release $release"
    git -C "$REPO" worktree remove --force "$release" 2>/dev/null || rm -rf "$release"
    git -C "$REPO" worktree prune
  fi
  say "building release $sha in $release"
  git -C "$REPO" worktree add --detach "$release" "$sha" >/dev/null
  (
    cd "$release"
    npm ci --ignore-scripts
    npm run build:web
    npx tsx scripts/build-server.ts
  )
  [[ -f "$main_mjs" ]] || die "the build did not produce $main_mjs"
  [[ -f "$release/web/dist/index.html" ]] || die "the build did not produce $release/web/dist/index.html"
  built="$(node "$main_mjs" --version)"
  [[ "$built" == "$sha" ]] || die "main.mjs --version printed '$built', expected $sha"
  printf '%s\n' "$sha" >"$marker"
fi

# --- 2. Units ----------------------------------------------------------------
mkdir -p "$UNIT_DIR" "$CONF_DIR"
chmod 0700 "$CONF_DIR"
for unit in atmusic.service atmusic.socket; do
  [[ -f "$release/config/systemd/$unit" ]] || die "the release has no config/systemd/$unit"
  install -m 0644 "$release/config/systemd/$unit" "$UNIT_DIR/$unit.tmp"
  mv -f "$UNIT_DIR/$unit.tmp" "$UNIT_DIR/$unit"
done
say "installed atmusic.service and atmusic.socket into $UNIT_DIR"

# --- 3. Create the database once ---------------------------------------------
# KEY=VALUE lines of an EnvironmentFile (comments and blank lines skipped, one
# level of matching quotes removed), printed as KEY=VALUE.
env_file_lines() {
  local line key value first
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value%"${value##*[![:space:]]}"}"
    first="${value:0:1}"
    if [[ ${#value} -ge 2 && ( "$first" == '"' || "$first" == "'" ) && "${value: -1}" == "$first" ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s=%s\n' "$key" "$value"
  done <"$1"
}

# The unit's Environment= assignments (space-separated KEY=VALUE words).
unit_environment() {
  local line word
  while IFS= read -r line; do
    [[ "$line" == Environment=* ]] || continue
    for word in ${line#Environment=}; do printf '%s\n' "$word"; done
  done <"$UNIT_DIR/atmusic.service"
}

db="$STATE_DIR/atmusic.db"
while IFS= read -r kv; do
  [[ "$kv" == ATMUSIC_DB=?* ]] && db="${kv#ATMUSIC_DB=}"
done < <(env_file_lines "$ENV_FILE")

if [[ -e "$db" ]]; then
  say "database $db exists; the server migrates it itself on start"
else
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing: copy config/atmusic.env.example there and fill in the required values first"
  workdir="$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/atmusic-init.XXXXXXXX")"
  init_pid=''
  cleanup() {
    if [[ -n "$init_pid" ]] && kill -0 "$init_pid" 2>/dev/null; then kill -TERM "$init_pid" 2>/dev/null || true; wait "$init_pid" 2>/dev/null || true; fi
    rm -rf "$workdir"
  }
  trap cleanup EXIT
  if [[ -n "${ATMUSIC_SECRETS_FILE:-}" ]]; then
    secrets_file="$ATMUSIC_SECRETS_FILE"
  elif [[ -f "$CONF_DIR/secrets.cred" ]]; then
    secrets_file="$workdir/secrets.json"
    systemd-creds --user decrypt --name=secrets "$CONF_DIR/secrets.cred" "$secrets_file" >/dev/null
    chmod 0600 "$secrets_file"
  elif [[ -f "$CONF_DIR/secrets.json" ]]; then
    secrets_file="$CONF_DIR/secrets.json"
  else
    die "no secrets: create $CONF_DIR/secrets.cred (docs/operations.md, Secrets) or set ATMUSIC_SECRETS_FILE"
  fi
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  init_env=("PATH=$PATH" "HOME=$HOME")
  [[ -n "${XDG_RUNTIME_DIR:-}" ]] && init_env+=("XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR")
  while IFS= read -r kv; do init_env+=("$kv"); done < <(unit_environment)
  while IFS= read -r kv; do init_env+=("$kv"); done < <(env_file_lines "$ENV_FILE")
  init_env+=("STATE_DIRECTORY=$STATE_DIR" "INGEST_MODE=off" "ATMUSIC_SECRETS_FILE=$secrets_file")
  say "creating the database $db (main.mjs --init)"
  log="$workdir/init.log"
  (cd "$release" && exec env -i "${init_env[@]}" node --enable-source-maps "$main_mjs" --init) >"$log" 2>&1 &
  init_pid=$!
  deadline=$((SECONDS + INIT_TIMEOUT))
  ready=0
  while ((SECONDS < deadline)); do
    if grep -q '"event":"run.ready"' "$log"; then ready=1; break; fi
    kill -0 "$init_pid" 2>/dev/null || break
    sleep 0.2
  done
  if ((ready == 0)); then
    cat "$log" >&2 || true
    die "main.mjs --init did not report ready (see the output above)"
  fi
  kill -TERM "$init_pid"
  status=0
  wait "$init_pid" || status=$?
  init_pid=''
  ((status == 0)) || { cat "$log" >&2 || true; die "main.mjs --init exited with $status after SIGTERM"; }
  [[ -e "$db" ]] || die "main.mjs --init reported ready but $db does not exist"
  say "created $db"
fi

# --- 4. Switch current atomically --------------------------------------------
ln -sfn "releases/$sha" "$PREFIX/current.tmp"
mv -T "$PREFIX/current.tmp" "$PREFIX/current"
say "current -> releases/$sha"

# --- 5. Activation -------------------------------------------------------------
commands=(
  'loginctl enable-linger'
  'systemctl --user daemon-reload'
  'systemctl --user enable --now atmusic'
)
if ((enable == 1)); then
  for c in "${commands[@]}"; do
    say "running: $c"
    $c
  done
  say 'an already running service keeps the old release until: systemctl --user restart atmusic'
else
  say 'activate with (not run; pass --enable to run them):'
  for c in "${commands[@]}"; do printf '  %s\n' "$c"; done
  printf '  %s\n' 'systemctl --user restart atmusic    # when upgrading a running service'
  printf '  %s\n' 'systemctl --user enable --now atmusic.socket    # optional socket activation'
fi
