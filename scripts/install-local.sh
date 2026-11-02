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
#     into ~/.config/systemd/user (systemd itself is not touched). Old unit files
#     are backed up until the current-link switch; command failures before that
#     commit attempt restoration, retaining/reporting backups if restoration
#     fails. This trap-based rollback is not crash/power-loss atomic.
#  3. When the database does not exist yet, run `main.mjs --init` once: the
#     server creates and migrates ATMUSIC_DB and reports ready. A Python/Linux
#     pidfd supervisor stops the child with SIGTERM and, after the configured
#     grace, SIGKILLs and reaps it without risking PID reuse. It runs with exactly the unit's Environment= values,
#     ~/.config/atmusic/atmusic.env, STATE_DIRECTORY and INGEST_MODE=off, in an
#     otherwise empty environment (so no NODE_OPTIONS, proxy or SSL_CERT_*
#     variable can reach it), and with the secrets from ATMUSIC_SECRETS_FILE,
#     else ~/.config/atmusic/secrets.cred decrypted by systemd-creds into a
#     private runtime directory that is removed afterwards, else
#     ~/.config/atmusic/secrets.json. An existing database is never touched
#     here: the server takes its own pre-migration backup and migrates it when
#     it starts (ADR §3.10).
#  4. Switch ~/.local/lib/atmusic/current atomically through a uniquely created
#     private temporary directory under the release prefix. Older releases stay
#     for rollback (a link switch back, ADR §14.3).
#  5. Print the activation commands; run them only with --enable. Linger is
#     never touched without --enable.
#
# Environment: HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR as usual;
# ATMUSIC_SECRETS_FILE (optional, see 3); ATMUSIC_INIT_TIMEOUT_SECONDS
# (default 300, range 1..900) bounds readiness; ATMUSIC_INIT_STOP_GRACE_SECONDS
# (default 5, range 1..60) bounds graceful shutdown before SIGKILL if the init child ignores SIGTERM.
# A database-creation run requires Python/Linux pidfd support.
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
INIT_STOP_GRACE="${ATMUSIC_INIT_STOP_GRACE_SECONDS:-5}"
[[ "$INIT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'ATMUSIC_INIT_TIMEOUT_SECONDS must be a positive integer'
(( ${#INIT_TIMEOUT} <= 3 && 10#$INIT_TIMEOUT <= 900 )) || die 'ATMUSIC_INIT_TIMEOUT_SECONDS must be between 1 and 900'
[[ "$INIT_STOP_GRACE" =~ ^[1-9][0-9]*$ ]] || die 'ATMUSIC_INIT_STOP_GRACE_SECONDS must be a positive integer'
(( ${#INIT_STOP_GRACE} <= 2 && INIT_STOP_GRACE <= 60 )) || die 'ATMUSIC_INIT_STOP_GRACE_SECONDS must be between 1 and 60'

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
unit_backup_dir=""
unit_install_tmp=""
current_tmp_dir=""
unit_transaction_active=0
declare -A unit_had_file=()
restore_unit_files() {
  local status=$?
  if (($# > 0)); then status="$1"; fi
  local failed=0 unit unit_failed
  if ((unit_transaction_active)); then
    for unit in atmusic.service atmusic.socket; do
      unit_failed=0
      if [[ "${unit_had_file[$unit]:-0}" == 1 ]]; then
        local restore_dir
        restore_dir="$(mktemp -d "$UNIT_DIR/.atmusic-unit-restore.XXXXXXXX")" || unit_failed=1
        if ((unit_failed == 0)); then
          cp -a -- "$unit_backup_dir/$unit" "$restore_dir/$unit" || unit_failed=1
          if ((unit_failed == 0)); then mv -Tf -- "$restore_dir/$unit" "$UNIT_DIR/$unit" || unit_failed=1; fi
          rm -rf -- "$restore_dir" || unit_failed=1
        fi
      else
        rm -f -- "$UNIT_DIR/$unit" || unit_failed=1
      fi
      ((unit_failed == 0)) || failed=1
    done
    unit_transaction_active=0
  fi
  if [[ -n "$unit_install_tmp" ]]; then
    if rm -f -- "$unit_install_tmp"; then unit_install_tmp=""; else failed=1; fi
  fi
  if [[ -n "$current_tmp_dir" ]]; then
    if rm -rf -- "$current_tmp_dir"; then current_tmp_dir=""; else failed=1; fi
  fi
  if ((failed == 0)) && [[ -n "$unit_backup_dir" ]]; then
    if rm -rf -- "$unit_backup_dir"; then
      unit_backup_dir=""
    else
      failed=1
    fi
  fi
  if ((failed)); then
    printf 'install-local: warning: could not fully restore prior unit files\n' >&2
    if [[ -n "$unit_backup_dir" ]]; then
      printf 'install-local: recovery copies retained at %s\n' "$unit_backup_dir" >&2
    fi
    ((status != 0)) || status=1
  fi
  return "$status"
}
unit_backup_dir="$(mktemp -d "$UNIT_DIR/.atmusic-units.XXXXXXXX")"
trap restore_unit_files EXIT
for unit in atmusic.service atmusic.socket; do
  if [[ -e "$UNIT_DIR/$unit" || -L "$UNIT_DIR/$unit" ]]; then
    [[ -f "$UNIT_DIR/$unit" || -L "$UNIT_DIR/$unit" ]] || die "unexpected non-file systemd unit path: $UNIT_DIR/$unit"
    cp -a -- "$UNIT_DIR/$unit" "$unit_backup_dir/$unit"
    unit_had_file["$unit"]=1
  else
    unit_had_file["$unit"]=0
  fi
done
unit_transaction_active=1
for unit in atmusic.service atmusic.socket; do
  [[ -f "$release/config/systemd/$unit" ]] || die "the release has no config/systemd/$unit"
  unit_install_tmp="$(mktemp "$UNIT_DIR/.${unit}.XXXXXXXX")"
  install -m 0644 "$release/config/systemd/$unit" "$unit_install_tmp"
  mv -Tf -- "$unit_install_tmp" "$UNIT_DIR/$unit"
  unit_install_tmp=""
done
say "installed atmusic.service and atmusic.socket into $UNIT_DIR"

# --- 3. Create the database once ---------------------------------------------
# Accept the EnvironmentFile subset used here: KEY=value, or a simply quoted
# value with no quote/backslash escapes. Preserve quoted whitespace exactly and
# reject unsupported syntax rather than silently trimming or changing a value.
env_file_lines() {
  local line key value first last
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "unsupported environment line in $1"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    first="${value:0:1}"
    last="${value: -1}"
    if [[ "$first" == '"' || "$first" == "'" ]]; then
      [[ ${#value} -ge 2 && "$last" == "$first" ]] || die "unmatched quote in environment value $key"
      value="${value:1:${#value}-2}"
      [[ "$value" != *'"'* && "$value" != *"'"* && "$value" != *\\* ]] || die "unsupported quoting/escape in environment value $key"
    else
      [[ "$value" != *[[:space:]]* && "$value" != *'"'* && "$value" != *"'"* && "$value" != *\\* ]] || die "unsupported unquoted whitespace/quote/escape in environment value $key"
    fi
    printf '%s=%s\n' "$key" "$value"
  done <"$1"
}

# The checked-in unit currently uses simple, unquoted KEY=VALUE words only.
# Reject systemd quoting/escaping, glob characters, or other unsupported syntax;
# read -a splits separators without shell glob expansion.
unit_environment() {
  local line assignments_text word
  local -a assignments
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ "$line" == Environment=* ]] || continue
    assignments_text="${line#Environment=}"
    [[ "$assignments_text" =~ ^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@+=,-]+([[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@+=,-]+)*$ ]] || die 'unsupported Environment= syntax for safe --init environment'
    IFS=$' \t' read -r -a assignments <<<"$assignments_text"
    for word in "${assignments[@]}"; do printf '%s\n' "$word"; done
  done <"$UNIT_DIR/atmusic.service"
}

env_file_values="$(env_file_lines "$ENV_FILE")" || die "could not parse $ENV_FILE"
db="$STATE_DIR/atmusic.db"
if [[ -n "$env_file_values" ]]; then
  while IFS= read -r kv; do
    [[ "$kv" == ATMUSIC_DB=?* ]] && db="${kv#ATMUSIC_DB=}"
  done <<<"$env_file_values"
fi

if [[ -e "$db" ]]; then
  say "database $db exists; the server migrates it itself on start"
else
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing: copy config/atmusic.env.example there and fill in the required values first"
  env -i "PATH=$PATH" "HOME=$HOME" python3 -I "$REPO/scripts/run_init.py" --check || die 'safe --init shutdown requires Python/Linux pidfd support'
  workdir="$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/atmusic-init.XXXXXXXX")"
  init_keep_workdir=0
  cleanup() {
    local status=$?
    if ((init_keep_workdir)); then
      printf 'install-local: warning: retaining initialization workdir %s because --init may still be running\n' "$workdir" >&2
      ((status != 0)) || status=1
    elif ! rm -rf "$workdir"; then
      printf 'install-local: warning: could not remove initialization workdir %s\n' "$workdir" >&2
      ((status != 0)) || status=1
    fi
    restore_unit_files "$status" || status=$?
    return "$status"
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
  unit_env_values="$(unit_environment)" || die 'could not parse unit Environment= values'
  if [[ -n "$unit_env_values" ]]; then
    while IFS= read -r kv; do init_env+=("$kv"); done <<<"$unit_env_values"
  fi
  if [[ -n "$env_file_values" ]]; then
    while IFS= read -r kv; do init_env+=("$kv"); done <<<"$env_file_values"
  fi
  init_env+=("STATE_DIRECTORY=$STATE_DIR" "INGEST_MODE=off" "ATMUSIC_SECRETS_FILE=$secrets_file")
  say "creating the database $db (main.mjs --init)"
  log="$workdir/init.log"
  init_keep_workdir=1
  if printf '%s\0' "${init_env[@]}" | env -i "PATH=$PATH" "HOME=$HOME" python3 -I "$REPO/scripts/run_init.py" \
    --timeout "$INIT_TIMEOUT" --grace "$INIT_STOP_GRACE" --log "$log" --cwd "$release" --env-stdin \
    -- node --enable-source-maps "$main_mjs" --init; then
    init_status=0
  else
    init_status=$?
  fi
  if ((init_status == 0 || init_status == 70)); then init_keep_workdir=0; else init_keep_workdir=1; fi
  if ((init_status != 0)); then
    cat "$log" >&2 || true
    die "main.mjs --init failed with status $init_status"
  fi
  [[ -e "$db" ]] || die "main.mjs --init reported ready but $db does not exist"
  say "created $db"
fi

# --- 4. Switch current atomically --------------------------------------------
current_tmp_dir="$(mktemp -d "$PREFIX/.atmusic-current.XXXXXXXX")"
ln -s "releases/$sha" "$current_tmp_dir/current"
mv -Tf -- "$current_tmp_dir/current" "$PREFIX/current"
unit_transaction_active=0
rm -rf -- "$current_tmp_dir"
current_tmp_dir=""
rm -rf -- "$unit_backup_dir"
unit_backup_dir=""
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
