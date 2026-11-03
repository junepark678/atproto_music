// Node live gate: compatibility of two independent PDS implementations.
//
// This is a schema-v3 Node driver. It reuses the record, identity, snapshot,
// and getBlocks checks from the established compatibility gate while keeping
// Worker deployment identity and admin authentication out of the Node contract.

import {
  checkDeployment,
  ENV,
  type GateContext,
  IDENTITY_REQS,
  JETSTREAM_REQ,
  PDS_IMPLEMENTATION_REQS,
  type PdsInfo,
  pdsInfo,
  type Subject,
} from './live-gate.ts';
import { isNodeGateMain, mainNodeGate, type NodeGateContext, type NodeGateSpec } from './node-live-gate.ts';
import { checkPds, type PdsCompat } from './pds_compat_check.ts';

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function legacyContext(context: NodeGateContext): GateContext {
  return {
    env: context.env,
    get: context.get,
    origin: context.origin,
    prefix: context.lexiconPrefix,
    log: context.log,
    fail: context.fail,
    cleanup: context.cleanup,
  };
}

function failedObservation(did: string, endpoint: string, note: string): PdsCompat {
  return {
    endpoint,
    did,
    getRecordInclusion: false,
    getRecordExclusion: false,
    getBlocks: false,
    getRepoStatus: false,
    snapshotAbsence: null,
    notes: [note],
  };
}

export const spec: NodeGateSpec = {
  gate: 'pdsCompat',
  script: 'scripts/live/node_pds_compat_check.ts',
  // IDENTITY_REQS includes two distinct DIDs/PDSs and the independence
  // reference. The Node harness supplies origin, prefix and bundle-bound
  // source identity; Worker UUID and ADMIN_TOKEN are deliberately omitted.
  requirements: [...IDENTITY_REQS, ...PDS_IMPLEMENTATION_REQS, JETSTREAM_REQ],
  async run(context) {
    const legacy = legacyContext(context);
    const deployment = await checkDeployment(legacy);
    const pds: PdsInfo[] = [];
    const subjects: Subject[] = [];
    const perPds: PdsCompat[] = [];

    for (const [didName, pdsName, implementationName] of [
      [ENV.didA, ENV.pdsA, ENV.pdsAImplementation],
      [ENV.didB, ENV.pdsB, ENV.pdsBImplementation],
    ] as const) {
      const did = context.get(didName);
      const endpoint = context.get(pdsName);
      let info: PdsInfo;
      try {
        info = await pdsInfo(endpoint, context.get(implementationName));
        pds.push(info);
      } catch (error) {
        const detail = describe(error);
        perPds.push(failedObservation(did, endpoint, `PDS implementation/version: ${detail}`));
        subjects.push({ did, uri: null });
        context.fail(`${endpoint}: ${detail}`);
        continue;
      }

      try {
        const { compat, subject } = await checkPds(legacy, did, info.endpoint);
        perPds.push(compat);
        subjects.push(subject);
        if (!compat.getRecordInclusion) context.fail(`${info.endpoint}: no verified getRecord inclusion proof`);
        if (!compat.getRepoStatus) context.fail(`${info.endpoint}: getRepoStatus unsupported`);
        if (!compat.getRecordExclusion && compat.snapshotAbsence !== true) {
          context.fail(
            `${info.endpoint}: no exclusion proof and no verified snapshot absence: deletes cannot reconcile`,
          );
        }
      } catch (error) {
        const detail = describe(error);
        perPds.push(failedObservation(did, info.endpoint, detail));
        subjects.push({ did, uri: null });
        context.fail(`${info.endpoint}: ${detail}`);
      }
    }

    context.cleanup('read-only gate: no record was written');
    return { pds, subjects, results: { deployment, perPds } };
  },
};

if (isNodeGateMain(import.meta.url)) mainNodeGate(spec);
