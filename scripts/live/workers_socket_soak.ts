// Live gate: 24 h Jetstream socket soak, socket versus pulse (ADR 0004 §5.5,
// §11, §13 items 2 and 7; W6-05).
//
// Usage: npx tsx scripts/live/workers_socket_soak.ts
//
// Outbound-socket message billing and CPU accounting are undocumented, so
// the INGEST_MODE decision is measured on the deployed Worker:
// 1. For ATMUSIC_LIVE_SOAK_HOURS (default and minimum 24) it samples
//    /internal/admin/status every ATMUSIC_LIVE_SOAK_POLL_S seconds (default
//    60): socket state, host index, Jetstream cursor and pendingGap.
//    Reconnects are counted from the samples (a host rotation or a
//    disconnected→connected transition); because sampling can miss a fast
//    reconnect the count is a lower bound. Lag is now − lastEventTimeUs.
// 2. It then queries the Cloudflare GraphQL Analytics API for the soak window
//    (account ATMUSIC_LIVE_CF_ACCOUNT_ID, the IndexDO namespace
//    ATMUSIC_LIVE_CF_DO_NAMESPACE_ID, an Analytics:Read token): billed DO
//    requests (durableObjectsInvocationsAdaptiveGroups), and DO CPU time and
//    WebSocket message counts (durableObjectsPeriodicGroups). The datasets'
//    fields are discovered by introspection first, so a field Cloudflare does
//    not expose is reported missing instead of being guessed. A measurement
//    the data query does not return (no account row, no invocation rows, no
//    periodic rows, no alarm invocations) is missing too: it is never
//    defaulted to 0, and any missing measurement fails the gate. Alarm
//    invocations come from the invocations dataset's invocation-type
//    dimension; CPU per alarm is total DO CPU over alarm invocations, an
//    upper bound (it includes socket and RPC work).
// 3. Decision: `socket` when every threshold below holds, otherwise `pulse`.
//    The thresholds are DECISION_THRESHOLDS (overridable by env); the evidence
//    records each measured value and which thresholds failed.
//
// The soak passes when it ran the full window in socket mode and every
// measurement was obtained; the decision itself is the result, not a pass
// criterion. Nothing is written to any repository.
//
// Without the prerequisites (deployed origin and version, owned NSID,
// Jetstream coverage, ADMIN_TOKEN, Cloudflare analytics credentials) it
// prints `blocked`, lists each missing variable and exits 2 before any
// request.

import {
  ADMIN_REQ,
  adminStatus,
  checkDeployment,
  type EnvMap,
  expect,
  field,
  type GateContext,
  type GateSpec,
  httpJson,
  intEnv,
  intRequirement,
  isMain,
  JETSTREAM_REQ,
  main,
  percentile,
  RELEASE_REQS,
  type Requirement,
  sleep,
} from './live-gate.ts';

export const SOAK_ENV = {
  cfToken: 'ATMUSIC_LIVE_CF_API_TOKEN',
  cfAccount: 'ATMUSIC_LIVE_CF_ACCOUNT_ID',
  cfNamespace: 'ATMUSIC_LIVE_CF_DO_NAMESPACE_ID',
  hours: 'ATMUSIC_LIVE_SOAK_HOURS',
  pollSeconds: 'ATMUSIC_LIVE_SOAK_POLL_S',
  maxReconnects: 'ATMUSIC_LIVE_SOAK_MAX_RECONNECTS_PER_DAY',
  maxLagP95Ms: 'ATMUSIC_LIVE_SOAK_MAX_LAG_P95_MS',
  maxMonthlyRequests: 'ATMUSIC_LIVE_SOAK_MAX_MONTHLY_DO_REQUESTS',
  maxCpuMsPerAlarm: 'ATMUSIC_LIVE_SOAK_MAX_CPU_MS_PER_ALARM',
} as const;

export const MIN_SOAK_HOURS = 24;
export const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

/** Defaults: ≤4 reconnects/h, p95 lag ≤60 s, ≤10M DO requests/30 d (ADR §11), ≤50% of the 30 s cpu_ms limit. */
export const DECISION_THRESHOLDS = {
  maxReconnectsPerDay: 96,
  maxLagP95Ms: 60_000,
  maxMonthlyDoRequests: 10_000_000,
  maxCpuMsPerAlarm: 15_000,
} as const;

const hex32 = (v: string) => (/^[0-9a-f]{32}$/.test(v) ? null : 'must be 32 lowercase hex digits');

export const SOAK_REQS: readonly Requirement[] = [
  ADMIN_REQ,
  { name: SOAK_ENV.cfToken, what: 'Cloudflare API token with Account Analytics:Read' },
  { name: SOAK_ENV.cfAccount, what: 'Cloudflare account id of the deployment', check: hex32 },
  { name: SOAK_ENV.cfNamespace, what: 'Durable Object namespace id of IndexDO', check: hex32 },
  intRequirement(SOAK_ENV.hours, `soak length in hours, at least ${MIN_SOAK_HOURS}`, MIN_SOAK_HOURS, 168),
  intRequirement(SOAK_ENV.pollSeconds, 'admin status sampling interval in seconds, default 60', 10, 3600),
  intRequirement(SOAK_ENV.maxReconnects, 'decision threshold: reconnects per day', 0, 100_000),
  intRequirement(SOAK_ENV.maxLagP95Ms, 'decision threshold: p95 lag in ms', 1, 86_400_000),
  intRequirement(SOAK_ENV.maxMonthlyRequests, 'decision threshold: projected DO requests per 30 days', 1, 10 ** 12),
  intRequirement(SOAK_ENV.maxCpuMsPerAlarm, 'decision threshold: DO CPU ms per alarm', 1, 300_000),
];

export interface Sample {
  atMs: number;
  mode: unknown;
  connected: boolean;
  hostIndex: number | null;
  lastEventTimeUs: number | null;
  pendingGap: boolean;
}

export function sampleOf(status: Record<string, unknown>, atMs: number): Sample {
  const ingest = field<Record<string, unknown>>(status, 'ingest') ?? {};
  const hostIndex = field<number>(ingest, 'hostIndex');
  const last = field<number>(ingest, 'lastEventTimeUs');
  return {
    atMs,
    mode: field(ingest, 'mode'),
    connected: field(ingest, 'connected') === true,
    hostIndex: typeof hostIndex === 'number' ? hostIndex : null,
    lastEventTimeUs: typeof last === 'number' ? last : null,
    pendingGap: field(ingest, 'pendingGap') === true,
  };
}

/** Lower-bound reconnects and connected-sample lags from a sample series. */
export function summarize(samples: readonly Sample[]) {
  let reconnects = 0;
  let disconnectedSamples = 0;
  const lags: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const prev = samples[i - 1];
    if (!s.connected) disconnectedSamples++;
    if (prev && ((prev.hostIndex !== s.hostIndex && s.hostIndex !== null) || (!prev.connected && s.connected))) {
      reconnects++;
    }
    if (s.connected && s.lastEventTimeUs !== null)
      lags.push(Math.max(0, s.atMs - Math.floor(s.lastEventTimeUs / 1000)));
  }
  return {
    samples: samples.length,
    disconnectedSamples,
    reconnectsLowerBound: reconnects,
    pendingGapSamples: samples.filter((s) => s.pendingGap).length,
    lagMs: { p50: percentile(lags, 50), p95: percentile(lags, 95), max: lags.length ? Math.max(...lags) : null },
  };
}

export interface Analytics {
  doRequests: number | null;
  alarmInvocations: number | null;
  cpuTimeUs: number | null;
  activeTimeUs: number | null;
  inboundWebsocketMsgCount: number | null;
  outboundWebsocketMsgCount: number | null;
  missingFields: string[];
}

export function decide(
  hours: number,
  summary: ReturnType<typeof summarize>,
  analytics: Analytics,
  t: { maxReconnectsPerDay: number; maxLagP95Ms: number; maxMonthlyDoRequests: number; maxCpuMsPerAlarm: number },
) {
  const perDay = (n: number) => (n * 24) / hours;
  const reconnectsPerDay = perDay(summary.reconnectsLowerBound);
  const projectedMonthlyDoRequests =
    analytics.doRequests === null ? null : Math.round(perDay(analytics.doRequests) * 30);
  const cpuMsPerAlarm =
    analytics.cpuTimeUs !== null && analytics.alarmInvocations
      ? analytics.cpuTimeUs / 1000 / analytics.alarmInvocations
      : null;
  const failed: string[] = [];
  if (reconnectsPerDay > t.maxReconnectsPerDay) failed.push('reconnectsPerDay');
  if (summary.lagMs.p95 === null || summary.lagMs.p95 > t.maxLagP95Ms) failed.push('lagP95Ms');
  if (projectedMonthlyDoRequests === null || projectedMonthlyDoRequests > t.maxMonthlyDoRequests)
    failed.push('projectedMonthlyDoRequests');
  if (cpuMsPerAlarm === null || cpuMsPerAlarm > t.maxCpuMsPerAlarm) failed.push('cpuMsPerAlarm');
  return {
    decision: failed.length === 0 ? ('socket' as const) : ('pulse' as const),
    reconnectsPerDay,
    projectedMonthlyDoRequests,
    cpuMsPerAlarmUpperBound: cpuMsPerAlarm,
    thresholds: t,
    failedThresholds: failed,
  };
}

async function graphql(ctx: GateContext, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await httpJson(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.get(SOAK_ENV.cfToken)}` },
    body: { query, variables },
    timeoutMs: 60_000,
  });
  const errors = field<unknown[]>(res.json, 'errors');
  expect(res.status === 200, `GraphQL analytics: HTTP ${res.status}`);
  expect(!errors || errors.length === 0, `GraphQL analytics: ${String(JSON.stringify(errors ?? null)).slice(0, 500)}`);
  return field(res.json, 'data');
}

async function typeFields(ctx: GateContext, typeName: string): Promise<string[]> {
  const data = await graphql(ctx, 'query($n: String!) { __type(name: $n) { fields { name } } }', { n: typeName });
  const fields = field<unknown[]>(field(data, '__type'), 'fields') ?? [];
  return fields.map((f) => field<string>(f, 'name')).filter((n): n is string => typeof n === 'string');
}

const sum = (rows: unknown, key: string): number | null => {
  if (!Array.isArray(rows)) return null;
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const v = field<number>(field(row, 'sum'), key);
    if (typeof v === 'number') {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
};

export async function fetchAnalytics(ctx: GateContext, startIso: string, endIso: string): Promise<Analytics> {
  const missingFields: string[] = [];
  const periodicSum = await typeFields(ctx, 'AccountDurableObjectsPeriodicGroupsSum');
  const wanted = ['cpuTime', 'activeTime', 'inboundWebsocketMsgCount', 'outboundWebsocketMsgCount'];
  const periodicFields = wanted.filter((f) => periodicSum.includes(f));
  for (const f of wanted.filter((f) => !periodicSum.includes(f)))
    missingFields.push(`durableObjectsPeriodicGroups.sum.${f}`);
  const invocationDims = await typeFields(ctx, 'AccountDurableObjectsInvocationsAdaptiveGroupsDimensions');
  const typeDim = ['eventType', 'invocationType', 'type'].find((d) => invocationDims.includes(d)) ?? null;
  if (typeDim === null) missingFields.push('durableObjectsInvocationsAdaptiveGroups.dimensions.<invocation type>');

  const query = `query($account: String!, $ns: String!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      invocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000,
        filter: { namespaceId: $ns, datetime_geq: $start, datetime_leq: $end }) {
        sum { requests } ${typeDim ? `dimensions { ${typeDim} }` : ''}
      }
      ${
        periodicFields.length > 0
          ? `periodic: durableObjectsPeriodicGroups(limit: 10000,
        filter: { namespaceId: $ns, datetimeMinute_geq: $start, datetimeMinute_leq: $end }) {
        sum { ${periodicFields.join(' ')} }
      }`
          : ''
      }
    } }
  }`;
  const data = await graphql(ctx, query, {
    account: ctx.get(SOAK_ENV.cfAccount),
    ns: ctx.get(SOAK_ENV.cfNamespace),
    start: startIso,
    end: endIso,
  });
  const accounts = field<unknown[]>(field(data, 'viewer'), 'accounts');
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (account === undefined || account === null)
    missingFields.push('viewer.accounts (no analytics row for the account in the soak window)');
  const invocations = field<unknown[]>(account, 'invocations');
  const periodic = field<unknown[]>(account, 'periodic');
  const doRequests = sum(invocations, 'requests');
  if (doRequests === null || doRequests < 1)
    missingFields.push('durableObjectsInvocationsAdaptiveGroups.sum.requests (no invocation rows in the soak window)');
  let alarmInvocations: number | null = null;
  if (typeDim) {
    const alarmRows = (invocations ?? []).filter((row) =>
      /alarm/i.test(String(field(field(row, 'dimensions'), typeDim) ?? '')),
    );
    alarmInvocations = sum(alarmRows, 'requests');
    if (alarmInvocations === null || alarmInvocations < 1) {
      alarmInvocations = null;
      missingFields.push(
        `durableObjectsInvocationsAdaptiveGroups.${typeDim} (no alarm invocations in the soak window)`,
      );
    }
  }
  const periodicSums: Record<string, number | null> = {};
  for (const f of wanted) {
    periodicSums[f] = periodicFields.includes(f) ? sum(periodic, f) : null;
    if (periodicFields.includes(f) && periodicSums[f] === null)
      missingFields.push(`durableObjectsPeriodicGroups.sum.${f} (no rows in the soak window)`);
  }
  return {
    doRequests: doRequests !== null && doRequests >= 1 ? doRequests : null,
    alarmInvocations,
    cpuTimeUs: periodicSums.cpuTime ?? null,
    activeTimeUs: periodicSums.activeTime ?? null,
    inboundWebsocketMsgCount: periodicSums.inboundWebsocketMsgCount ?? null,
    outboundWebsocketMsgCount: periodicSums.outboundWebsocketMsgCount ?? null,
    missingFields,
  };
}

function thresholds(env: EnvMap) {
  return {
    maxReconnectsPerDay: intEnv(env, SOAK_ENV.maxReconnects, DECISION_THRESHOLDS.maxReconnectsPerDay),
    maxLagP95Ms: intEnv(env, SOAK_ENV.maxLagP95Ms, DECISION_THRESHOLDS.maxLagP95Ms),
    maxMonthlyDoRequests: intEnv(env, SOAK_ENV.maxMonthlyRequests, DECISION_THRESHOLDS.maxMonthlyDoRequests),
    maxCpuMsPerAlarm: intEnv(env, SOAK_ENV.maxCpuMsPerAlarm, DECISION_THRESHOLDS.maxCpuMsPerAlarm),
  };
}

export const spec: GateSpec = {
  gate: 'socketSoak',
  script: 'scripts/live/workers_socket_soak.ts',
  requirements: [...RELEASE_REQS, JETSTREAM_REQ, ...SOAK_REQS],
  async run(ctx) {
    const hours = intEnv(ctx.env, SOAK_ENV.hours, MIN_SOAK_HOURS);
    const pollMs = intEnv(ctx.env, SOAK_ENV.pollSeconds, 60) * 1000;
    const deployment = await checkDeployment(ctx);
    const startMs = Date.now();
    const endMs = startMs + hours * 3_600_000;
    const samples: Sample[] = [];
    let statusErrors = 0;
    ctx.log(`soak: sampling admin status every ${pollMs / 1000} s until ${new Date(endMs).toISOString()}`);
    while (Date.now() < endMs) {
      try {
        samples.push(sampleOf(await adminStatus(ctx), Date.now()));
      } catch (error) {
        statusErrors++;
        ctx.log(`soak: admin status sample failed: ${String(error)}`);
      }
      await sleep(Math.min(pollMs, Math.max(0, endMs - Date.now())));
    }
    const summary = summarize(samples);
    const modes = [...new Set(samples.map((s) => String(s.mode)))];
    expect(samples.length > 0, 'no admin status sample succeeded');
    if (modes.length !== 1 || modes[0] !== 'socket')
      ctx.fail(`ingest mode during the soak was ${modes.join(', ')}, not socket`);
    const expected = Math.floor((hours * 3_600_000) / pollMs);
    if (samples.length < expected * 0.9) ctx.fail(`only ${samples.length} of ~${expected} samples succeeded`);
    const analytics = await fetchAnalytics(ctx, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    for (const missing of analytics.missingFields) ctx.fail(`analytics field unavailable: ${missing}`);
    const decision = decide(hours, summary, analytics, thresholds(ctx.env));
    ctx.cleanup('read-only gate: nothing created');
    return {
      pds: [],
      subjects: [],
      results: {
        deployment,
        window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
        durationHours: hours,
        pollSeconds: pollMs / 1000,
        statusErrors,
        ...summary,
        analytics,
        ...decision,
      },
    };
  },
};

if (isMain(import.meta.url)) main(spec);
