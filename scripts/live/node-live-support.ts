import type { NodeGateName, NodeGateObservation } from './node-live-gate.ts';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cid(value: unknown): value is string {
  return nonempty(value) && (/^b[a-z2-7]{20,}$/.test(value) || /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value));
}

function published(value: unknown): string | null {
  const row = object(value);
  if (!row) return 'must be an object';
  if (!nonempty(row.uri) || !/^at:\/\/[^/]+\/[^/]+\/[^/]+$/.test(row.uri)) return 'record URI is missing or invalid';
  const writeCid = row.operationCid ?? row.pdsWriteCid ?? row.cid;
  if (!cid(writeCid)) return 'written CID is missing';
  for (const name of ['cid', 'operationCid', 'pdsWriteCid']) {
    if (row[name] !== undefined && row[name] !== writeCid) return `${name} does not match written CID`;
  }
  for (const name of ['statusCid', 'indexedCid', 'verifiedCid']) {
    if (!cid(row[name])) return `${name} is missing`;
    if (row[name] !== writeCid) return `${name} does not match written CID`;
  }
  if (!nonempty(row.verifiedRev)) return 'verifiedRev is missing';
  if (typeof row.lagMs !== 'number' || !Number.isFinite(row.lagMs) || row.lagMs < 0) {
    return 'lagMs must be a nonnegative finite number';
  }
  return null;
}

function ingestDelete(value: unknown, results: Record<string, unknown>): string | null {
  if (!Array.isArray(value) || value.length !== 2) return 'must cover exactly two published records';
  const local = object(results.localPublish);
  const external = object(results.externalPublish);
  if (!local || !external || !nonempty(local.uri) || !nonempty(external.uri) || local.uri === external.uri) {
    return 'published record URIs are missing or not distinct';
  }
  const rows = value.map(object);
  if (rows.some((row) => !row)) return 'entries must be objects';
  const uris = rows.map((row) => row!.uri);
  if (new Set(uris).size !== 2 || !uris.includes(local.uri) || !uris.includes(external.uri)) {
    return 'must cover both published record URIs exactly';
  }
  for (const row of rows as Record<string, unknown>[]) {
    if (row.absentVerified !== true) return `${String(row.uri)} absentVerified must be true`;
    if (row.method !== 'exclusionProof' && row.method !== 'snapshot') return `${String(row.uri)} method is unsupported`;
    if (!nonempty(row.presentRev) || !nonempty(row.verifiedRev)) return `${String(row.uri)} revisions are missing`;
    const publication = row.uri === local.uri ? local : external;
    if (row.presentRev !== publication.verifiedRev) {
      return `${String(row.uri)} presentRev does not match published verifiedRev`;
    }
    if (row.verifiedRev <= row.presentRev) {
      return `${String(row.uri)} verifiedRev must be later than presentRev`;
    }
    if (typeof row.lagMs !== 'number' || !Number.isFinite(row.lagMs) || row.lagMs < 0) {
      return `${String(row.uri)} lagMs must be a nonnegative finite number`;
    }
  }
  return null;
}

function pdsCompat(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) return 'must contain two PDS observations';
  const rows = value.map(object);
  if (rows.some((row) => !row)) return 'entries must be objects';
  const hosts: string[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (!nonempty(row.endpoint)) return 'endpoint is missing';
    try {
      hosts.push(new URL(row.endpoint).hostname.toLowerCase());
    } catch {
      return 'endpoint is invalid';
    }
    if (!nonempty(row.did)) return 'DID is missing';
    for (const field of ['getRecordInclusion', 'getRecordExclusion', 'getBlocks', 'getRepoStatus']) {
      if (typeof row[field] !== 'boolean') return `${field} must be boolean`;
    }
    if (row.getRecordInclusion !== true || row.getRepoStatus !== true)
      return 'inclusion proof and repo status must be true';
    if (row.getRecordExclusion !== true && row.snapshotAbsence !== true) {
      return 'exclusion proof or snapshot absence must be true';
    }
  }
  return hosts[0] !== hosts[1] ? null : 'PDS endpoint hosts must be distinct';
}

function nodeOauthSignIns(value: unknown, prefix: string): string | null {
  if (!Array.isArray(value) || value.length !== 2) return 'must contain exactly one sign-in per PDS';
  const collections = ['scrobble', 'follow', 'settings', 'love'].map((name) => `${prefix}.${name}`);
  const appWriteKinds = [
    'scrobble.create',
    'scrobble.delete',
    'follow.put',
    'follow.delete',
    'love.put',
    'love.delete',
    'settings.put',
  ];
  const signIns = value.map(object);
  if (signIns.some((row) => !row)) return 'entries must be objects';
  const dids = new Set<string>();
  const hosts = new Set<string>();
  for (const row of signIns as Record<string, unknown>[]) {
    if (!nonempty(row.did) || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(row.did)) return 'DID is missing or invalid';
    if (dids.has(row.did)) return 'each PDS must have a distinct DID';
    dids.add(row.did);
    if (!nonempty(row.issuerHost) || row.issuerHost !== row.issuerHost.toLowerCase())
      return `${row.did} issuerHost is missing or non-canonical`;
    if (hosts.has(row.issuerHost)) return 'PDS issuer hosts must be distinct';
    hosts.add(row.issuerHost);
    if (row.tokenSub !== row.did) return `${row.did} token subject does not match`;
    if (!nonempty(row.grantedScope)) return `${row.did} grantedScope is missing`;
    const scopes = new Set(row.grantedScope.split(/\s+/));
    if (!scopes.has('atproto') || [...scopes].some((scope) => scope.startsWith('transition:')))
      return `${row.did} scope must contain atproto and no transition scope`;
    for (const collection of collections) {
      for (const action of ['create', 'update', 'delete']) {
        if (!scopes.has(`repo:${collection}#${action}`))
          return `${row.did} scope is missing ${action} on ${collection}`;
      }
    }
    const exchange = object(row.exchange);
    if (
      exchange?.sealedSessionObserved !== true ||
      exchange.clientAuthMethod !== 'private_key_jwt' ||
      exchange.dpopBound !== true ||
      exchange.refreshTokenPresent !== true
    )
      return `${row.did} confidential session observation is incomplete`;
    if (!Array.isArray(row.crud) || row.crud.length !== collections.length)
      return `${row.did} CRUD must cover four collections`;
    const observedCollections = new Set<string>();
    for (const value of row.crud) {
      const crud = object(value);
      if (
        !crud ||
        !nonempty(crud.collection) ||
        !collections.includes(crud.collection) ||
        observedCollections.has(crud.collection)
      )
        return `${row.did} CRUD collection is invalid or duplicated`;
      observedCollections.add(crud.collection);
      for (const action of ['create', 'update'] as const) {
        const result = object(crud[action]);
        if (result?.status !== 200 || !cid(result.cid))
          return `${row.did} ${action} was not verified for ${crud.collection}`;
      }
      const deleted = object(crud.delete);
      if (deleted?.status !== 200 || crud.verified !== true)
        return `${row.did} delete or record verification failed for ${crud.collection}`;
    }
    if (!Array.isArray(row.appWrites) || row.appWrites.length !== appWriteKinds.length)
      return `${row.did} app writes must cover all seven intents`;
    const observedWrites = new Set<string>();
    for (const value of row.appWrites) {
      const write = object(value);
      if (!write || !nonempty(write.kind) || !appWriteKinds.includes(write.kind) || observedWrites.has(write.kind))
        return `${row.did} app write kind is invalid or duplicated`;
      observedWrites.add(write.kind);
      const creates = ['scrobble.create', 'follow.put', 'love.put', 'settings.put'].includes(write.kind);
      if (
        write.operationState !== 'succeeded' ||
        write.recordVerified !== creates ||
        write.absenceVerified !== !creates
      )
        return `${row.did} app write ${write.kind} was not reconciled`;
    }
    const signOut = object(row.signOut);
    if (
      signOut?.appSignOutCompleted !== true ||
      signOut.sessionVersionStableUntilSignOut !== true ||
      signOut.localSessionAbsent !== true ||
      signOut.refreshRejected !== true ||
      signOut.refreshError !== 'invalid_grant'
    )
      return `${row.did} sign-out revocation was not verified`;
  }
  return null;
}

export function nodeOauthObservations(): readonly NodeGateObservation[] {
  return [
    { key: 'signIns', accept: (value, prefix = '') => nodeOauthSignIns(value, prefix) },
    { key: 'cleanup', accept: (value) => (nonempty(value) ? null : 'cleanup outcome is missing') },
  ];
}

const DEFAULT_NODE_GATE_OBSERVATIONS: Partial<Record<NodeGateName, readonly NodeGateObservation[]>> = {
  ingest: [
    { key: 'localPublish', accept: published },
    { key: 'externalPublish', accept: published },
    { key: 'deleteReconcile', accept: (value) => (Array.isArray(value) ? null : 'must be an array') },
  ],
  pdsCompat: [{ key: 'perPds', accept: pdsCompat }],
};

export function observeNodeGateResults(
  gate: NodeGateName,
  declared: readonly NodeGateObservation[] | undefined,
  results: unknown,
  lexiconPrefix = '',
  informationallyBlocked = false,
): string[] {
  const resultObject = object(results);
  const observations = [...(DEFAULT_NODE_GATE_OBSERVATIONS[gate] ?? []), ...(declared ?? [])];
  if (observations.length === 0) {
    // A driver may retain informational observations without an approved
    // contract only when it has already explicitly blocked acceptance.
    return informationallyBlocked ? [] : [`${gate} has no accepted observation contract`];
  }
  if (!resultObject) return ['results: must be an object'];
  const failures: string[] = [];
  for (const observation of observations) {
    if (!Object.hasOwn(resultObject, observation.key) || resultObject[observation.key] === undefined) {
      failures.push(`observation ${observation.key}: missing`);
      continue;
    }
    try {
      const problem = observation.accept(resultObject[observation.key], lexiconPrefix);
      if (problem !== null) {
        failures.push(`observation ${observation.key}: ${nonempty(problem) ? problem : 'validator did not accept'}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`observation ${observation.key}: validator threw${detail ? `: ${detail}` : ''}`);
    }
  }
  // Cross-result validation augments every declared callback, including a
  // driver's additional deleteReconcile checks; it never replaces one.
  if (gate === 'ingest' && Object.hasOwn(resultObject, 'deleteReconcile')) {
    const problem = ingestDelete(resultObject.deleteReconcile, resultObject);
    if (problem !== null) failures.push(`observation deleteReconcile: ${problem}`);
  }
  return failures;
}
