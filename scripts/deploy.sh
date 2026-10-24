#!/usr/bin/env bash
# Deploy the atmusic Worker from a local checkout (ADR 0004 §4.2, §9.2 A1/A19,
# §15 Q3/Q4; W6-04). .github/workflows/deploy.yml runs the same steps in CI.
#
# Usage:
#   bash scripts/deploy.sh [--env production|staging|free] [--dry-run]
#                          [--initial] [--skip-checks]
#   bash scripts/deploy.sh [--env <env>] --preflight     # refusal checks only
#   bash scripts/deploy.sh [--env <env>] --smoke-only    # smoke-test the live origin
#
# Steps (a real deploy):
#   0. preflight, before anything is written or uploaded. It refuses
#      - an empty, invalid or fixture (com.example.atmusic) LEXICON_PREFIX, an
#        origin that is not https, a route off the PUBLIC_ORIGIN host, and
#        PUBLIC_ORIGIN/LEXICON_PREFIX environment overrides that differ from
#        the env's vars in worker/wrangler.jsonc (scripts/gen-config.ts rules);
#      - a Worker whose CURSOR_KEY secret is missing, as listed by
#        `wrangler secret list` (secret names only; values are never read);
#   1. bash scripts/check-ts.sh (skipped by --dry-run and --skip-checks);
#   2. npx tsx scripts/gen-config.ts --env <env>;
#   3. npm run build:web (vite build into web/dist);
#   4. npx tsx scripts/check-bundle.ts --env <env> --release, which runs
#      `wrangler deploy --dry-run --outdir worker/dist`, enforces the bundle
#      guard and prints the bundle SHA-256;
#   5. `wrangler versions upload`, recording the version id (with --initial:
#      `wrangler deploy`, because a pending Durable Object migration, such as
#      the first deploy's v1 IndexDO class, cannot go through versions upload);
#   6. `wrangler versions deploy <id>@100%`;
#   7. smoke test: /health/live, /health/ready and /api/v1/meta on PUBLIC_ORIGIN.
# --dry-run runs 0, 2, 3 and 4, prints what 5–7 would run, and uploads nothing.
#
# Environment:
#   LEXICON_PREFIX, PUBLIC_ORIGIN  optional; when set they must equal the env's
#                                  wrangler vars (an empty LEXICON_PREFIX is refused)
#   WRANGLER                       the wrangler executable (default: the repository's
#                                  node_modules/.bin/wrangler); it authenticates with
#                                  CLOUDFLARE_API_TOKEN or a prior `wrangler login`
#
# Exit status: 0 success, 1 refused or failed, 2 usage error. Secret values
# never pass through this script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="worker/wrangler.jsonc"
TSX="$ROOT/node_modules/.bin/tsx"
SMOKE_ATTEMPTS="${DEPLOY_SMOKE_ATTEMPTS:-6}"
SMOKE_DELAY_S="${DEPLOY_SMOKE_DELAY_S:-10}"

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy.sh [--env production|staging|free] [--dry-run] [--initial] [--skip-checks]
       bash scripts/deploy.sh [--env <env>] --preflight | --smoke-only

  --env <env>     wrangler environment: production (top level, default), staging or free
  --dry-run       preflight, gen-config, web build and `wrangler deploy --dry-run`; uploads nothing
  --initial       first deploy (applies the IndexDO migration): `wrangler deploy` instead of
                  `wrangler versions upload` + `wrangler versions deploy`
  --skip-checks   skip bash scripts/check-ts.sh before a real deploy
  --preflight     only the refusal checks (prefix/origin and the CURSOR_KEY secret)
  --smoke-only    only the smoke test of the deployed origin

Refuses an empty or fixture LEXICON_PREFIX and a missing CURSOR_KEY secret
(`wrangler secret list`). Set secrets with `wrangler secret put CURSOR_KEY [--env <env>]`.
EOF
}

env_name="production"
mode="deploy"
initial=0
skip_checks=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || { echo "deploy: --env needs a value" >&2; usage >&2; exit 2; }
      env_name="$2"
      shift 2
      ;;
    --env=*) env_name="${1#--env=}"; shift ;;
    --dry-run) mode="dry-run"; shift ;;
    --preflight) mode="preflight"; shift ;;
    --smoke-only) mode="smoke"; shift ;;
    --initial) initial=1; shift ;;
    --skip-checks) skip_checks=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "deploy: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$env_name" in
  production | staging | free) ;;
  *) echo "deploy: --env must be production, staging or free (got $env_name)" >&2; exit 2 ;;
esac

# The top-level wrangler config is production; the others are named envs.
env_args=()
if [[ "$env_name" != "production" ]]; then env_args=(--env "$env_name"); fi

if [[ -n "${WRANGLER:-}" ]]; then
  read -r -a wrangler_cmd <<<"$WRANGLER"
else
  wrangler_cmd=("$ROOT/node_modules/.bin/wrangler")
fi
export WRANGLER_SEND_METRICS=false

if [[ ! -x "$TSX" ]]; then
  echo "deploy: $TSX is missing; run npm ci first" >&2
  exit 1
fi

step() { printf '\n==> deploy: %s\n' "$*"; }
refuse() {
  local issue
  for issue in "$@"; do echo "deploy: refused: $issue" >&2; done
  exit 1
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/atmusic-deploy-XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

# Origin and prefix exactly as scripts/gen-config.ts would accept them, without
# writing anything: prints `origin=`/`prefix=` lines, or `issue=` lines.
resolve_values() {
  ATMUSIC_DEPLOY_ENV="$env_name" ATMUSIC_DEPLOY_CONFIG="$CONFIG" "$TSX" -e "$(
    cat <<'EOF'
import { GenConfigError, planGenConfig, readJsonc } from './scripts/gen-config.ts';
try {
  const plan = planGenConfig({
    env: process.env.ATMUSIC_DEPLOY_ENV ?? '',
    publicOrigin: process.env.PUBLIC_ORIGIN,
    lexiconPrefix: process.env.LEXICON_PREFIX,
    wranglerConfig: readJsonc(process.env.ATMUSIC_DEPLOY_CONFIG ?? ''),
  });
  console.log(`origin=${plan.origin}`);
  console.log(`prefix=${plan.prefix ?? ''}`);
} catch (err) {
  const issues = err instanceof GenConfigError ? err.issues : [err instanceof Error ? err.message : String(err)];
  for (const issue of issues) console.log(`issue=${issue}`);
}
EOF
  )"
}

origin=""
prefix=""
load_values() {
  local line values
  values="$(resolve_values)" || refuse "cannot read $CONFIG"
  local issues=()
  while IFS= read -r line; do
    case "$line" in
      origin=*) origin="${line#origin=}" ;;
      prefix=*) prefix="${line#prefix=}" ;;
      issue=*) issues+=("${line#issue=}") ;;
    esac
  done <<<"$values"
  value_issues=("${issues[@]+"${issues[@]}"}")
}

# Names of the deployed Worker's secrets (one per line), from `wrangler secret list`.
secret_names() {
  local raw
  raw="$("${wrangler_cmd[@]}" secret list --config "$CONFIG" "${env_args[@]+"${env_args[@]}"}" --format json 2>"$tmp_dir/secret-list.err")" ||
    return 1
  printf '%s' "$raw" | node -e '
    let text = "";
    process.stdin.on("data", (c) => { text += c; });
    process.stdin.on("end", () => {
      const start = text.indexOf("["), end = text.lastIndexOf("]");
      if (start === -1 || end < start) process.exit(3);
      let list;
      try { list = JSON.parse(text.slice(start, end + 1)); } catch { process.exit(3); }
      if (!Array.isArray(list)) process.exit(3);
      for (const entry of list) if (entry && typeof entry.name === "string") console.log(entry.name);
    });'
}

preflight() {
  step "preflight ($env_name, $CONFIG)"
  local problems=()
  load_values
  problems+=("${value_issues[@]+"${value_issues[@]}"}")

  local names
  if names="$(secret_names)"; then
    if ! grep -qx 'CURSOR_KEY' <<<"$names"; then
      local put="wrangler secret put CURSOR_KEY${env_args[*]+ ${env_args[*]}}"
      problems+=("the CURSOR_KEY secret is missing for env $env_name (wrangler secret list); set it with \`$put\` (value: openssl rand -hex 32)")
    fi
    if grep -qx 'ADMIN_TOKEN' <<<"$names"; then
      echo "deploy: ADMIN_TOKEN is set: /internal/admin/* is enabled"
    else
      echo "deploy: ADMIN_TOKEN is not set: /internal/admin/* stays disabled (PITR needs it)"
    fi
  else
    local detail
    detail="$(head -n 3 "$tmp_dir/secret-list.err" 2>/dev/null | tr '\n' ' ')"
    problems+=("cannot confirm the CURSOR_KEY secret: \`wrangler secret list\` failed (authenticate with CLOUDFLARE_API_TOKEN or wrangler login)${detail:+: $detail}")
  fi

  if [[ ${#problems[@]} -gt 0 ]]; then refuse "${problems[@]}"; fi
  echo "deploy: preflight ok: env $env_name origin $origin prefix $prefix, CURSOR_KEY present"
}

# One GET with retries; prints the body, fails unless the status is 200.
fetch_ok() {
  local url="$1" attempt=1 status=""
  while :; do
    status="$(curl -sS --max-time 15 -o "$tmp_dir/body" -w '%{http_code}' "$url" 2>"$tmp_dir/curl.err" || true)"
    if [[ "$status" == "200" ]]; then
      cat "$tmp_dir/body"
      return 0
    fi
    if [[ $attempt -ge $SMOKE_ATTEMPTS ]]; then
      echo "deploy: smoke: GET $url gave ${status:-no response} after $attempt attempts" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "$SMOKE_DELAY_S"
  done
}

smoke() {
  step "smoke test $origin"
  local live ready meta
  live="$(fetch_ok "$origin/health/live")" || return 1
  ready="$(fetch_ok "$origin/health/ready")" || return 1
  meta="$(fetch_ok "$origin/api/v1/meta")" || return 1
  LIVE="$live" READY="$ready" META="$meta" EXPECTED_PREFIX="$prefix" node -e '
    const parse = (name) => { try { return JSON.parse(process.env[name] ?? ""); } catch { return null; } };
    const live = parse("LIVE"), ready = parse("READY"), meta = parse("META");
    const problems = [];
    if (live?.status !== "live") problems.push("/health/live is not {status:\"live\"}");
    if (ready?.status !== "ready") problems.push("/health/ready is not {status:\"ready\"}");
    if (meta === null || typeof meta !== "object") problems.push("/api/v1/meta is not JSON");
    else {
      if (meta.lexiconPrefix !== process.env.EXPECTED_PREFIX)
        problems.push(`meta.lexiconPrefix is ${JSON.stringify(meta.lexiconPrefix)}, expected ${process.env.EXPECTED_PREFIX}`);
      if (meta.stage === "scaffold") problems.push("meta.stage is scaffold: the IndexDO storage is not ready");
      console.log(`deploy: smoke: meta stage ${meta.stage} capabilities ${JSON.stringify(meta.capabilities)} indexing ${meta.indexing?.state}`);
    }
    for (const p of problems) console.error(`deploy: smoke: ${p}`);
    process.exit(problems.length === 0 ? 0 : 1);'
  echo "deploy: smoke ok: /health/live, /health/ready, /api/v1/meta"
}

# The version id from a wrangler output file (ND-JSON) entry of the given type.
version_id_from() {
  node -e '
    const [file, type] = process.argv.slice(1);
    const lines = require("node:fs").readFileSync(file, "utf8").split("\n").filter(Boolean);
    let id = null;
    for (const line of lines) {
      try { const e = JSON.parse(line); if (e.type === type && typeof e.version_id === "string") id = e.version_id; } catch {}
    }
    if (id === null) process.exit(1);
    console.log(id);' "$1" "$2"
}

case "$mode" in
  preflight)
    preflight
    exit 0
    ;;
  smoke)
    load_values
    if [[ ${#value_issues[@]} -gt 0 ]]; then refuse "${value_issues[@]}"; fi
    smoke || exit 1
    exit 0
    ;;
esac

preflight

if [[ "$mode" == "deploy" && $skip_checks -eq 0 ]]; then
  step "repository gate (scripts/check-ts.sh)"
  bash scripts/check-ts.sh
fi

step "gen-config --env $env_name"
"$TSX" scripts/gen-config.ts --env "$env_name"

step "web build (vite build)"
npm run --silent build:web

step "bundle guard and wrangler deploy --dry-run (check-bundle --release)"
"$TSX" scripts/check-bundle.ts --config "$CONFIG" --env "$env_name" --release | tee "$tmp_dir/check-bundle.out"
bundle_sha="$(sed -n 's/^check-bundle: bundle sha256 \([0-9a-f]\{64\}\)$/\1/p' "$tmp_dir/check-bundle.out" | tail -n 1)"
[[ -n "$bundle_sha" ]] || refuse "check-bundle printed no bundle sha256"
echo "deploy: bundle sha256 $bundle_sha"

commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
message="atmusic $commit bundle sha256 $bundle_sha"
wrangler_display="wrangler"
env_display="${env_args[*]+ ${env_args[*]}}"

if [[ "$mode" == "dry-run" ]]; then
  echo
  if [[ $initial -eq 1 ]]; then
    echo "deploy: dry run: would run $wrangler_display deploy --config $CONFIG$env_display --message \"$message\""
  else
    echo "deploy: dry run: would run $wrangler_display versions upload --config $CONFIG$env_display --message \"$message\""
    echo "deploy: dry run: would run $wrangler_display versions deploy <version-id>@100% --yes --config $CONFIG$env_display"
  fi
  echo "deploy: dry run: would smoke-test $origin/health/live, /health/ready and /api/v1/meta"
  echo "DRY RUN OK: env $env_name origin $origin prefix $prefix bundle sha256 $bundle_sha"
  exit 0
fi

output_file="$tmp_dir/wrangler-output.ndjson"
if [[ $initial -eq 1 ]]; then
  step "wrangler deploy (initial: applies Durable Object migrations)"
  WRANGLER_OUTPUT_FILE_PATH="$output_file" "${wrangler_cmd[@]}" deploy --config "$CONFIG" \
    "${env_args[@]+"${env_args[@]}"}" --message "$message"
  version_id="$(version_id_from "$output_file" deploy)" || refuse "wrangler deploy reported no version id"
else
  step "wrangler versions upload"
  WRANGLER_OUTPUT_FILE_PATH="$output_file" "${wrangler_cmd[@]}" versions upload --config "$CONFIG" \
    "${env_args[@]+"${env_args[@]}"}" --message "$message"
  version_id="$(version_id_from "$output_file" version-upload)" || refuse "wrangler versions upload reported no version id"
  echo "deploy: uploaded version $version_id"
  step "wrangler versions deploy $version_id@100%"
  "${wrangler_cmd[@]}" versions deploy "$version_id@100%" --yes --config "$CONFIG" \
    "${env_args[@]+"${env_args[@]}"}" --message "$message"
fi

evidence_dir="$ROOT/work/deploy"
mkdir -p "$evidence_dir"
evidence="$evidence_dir/$env_name-$version_id.json"
ENV_NAME="$env_name" ORIGIN="$origin" PREFIX="$prefix" VERSION_ID="$version_id" BUNDLE_SHA="$bundle_sha" \
  COMMIT="$commit" node -e '
    const e = process.env;
    const record = { env: e.ENV_NAME, origin: e.ORIGIN, lexiconPrefix: e.PREFIX, workerVersionId: e.VERSION_ID,
      bundleSha256: e.BUNDLE_SHA, commit: e.COMMIT, deployedAt: new Date().toISOString() };
    process.stdout.write(JSON.stringify(record, null, 2) + "\n");' >"$evidence"
echo "deploy: version $version_id bundle sha256 $bundle_sha (evidence: $evidence)"

smoke || refuse "smoke test failed for version $version_id; roll back with: wrangler rollback --config $CONFIG$env_display"
echo "DEPLOY OK: env $env_name version $version_id bundle sha256 $bundle_sha"
