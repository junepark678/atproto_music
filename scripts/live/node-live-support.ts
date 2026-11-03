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
): string[] {
  const resultObject = object(results);
  const observations = [...(DEFAULT_NODE_GATE_OBSERVATIONS[gate] ?? []), ...(declared ?? [])];
  if (observations.length === 0) return [`${gate} has no accepted observation contract`];
  if (!resultObject) return ['results: must be an object'];
  const failures: string[] = [];
  for (const observation of observations) {
    if (!Object.hasOwn(resultObject, observation.key) || resultObject[observation.key] === undefined) {
      failures.push(`observation ${observation.key}: missing`);
      continue;
    }
    try {
      const problem = observation.accept(resultObject[observation.key]);
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
