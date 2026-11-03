// Node confidential OAuth live gate.
//
// This gate is intentionally fail-closed until the independent upstream
// exchange and revocation observations are implemented and accepted by the
// evidence verifier. It must not infer revocation from local session deletion
// or from disposal of a browser context.

import { IDENTITY_REQS, PDS_IMPLEMENTATION_REQS } from './live-gate.ts';
import { isNodeGateMain, mainNodeGate, type NodeGateRequirement, type NodeGateSpec } from './node-live-gate.ts';

export const NODE_OAUTH_ENV = {
  handleA: 'ATMUSIC_LIVE_HANDLE_A',
  handleB: 'ATMUSIC_LIVE_HANDLE_B',
  passwordA: 'ATMUSIC_LIVE_PASSWORD_A',
  passwordB: 'ATMUSIC_LIVE_PASSWORD_B',
  interactive: 'ATMUSIC_LIVE_OAUTH_INTERACTIVE',
  timeoutSeconds: 'ATMUSIC_LIVE_OAUTH_TIMEOUT_S',
} as const;

const handle = (name: string, which: string): NodeGateRequirement => ({
  name,
  what: `handle of the dedicated identity on PDS ${which}`,
  check: (value) => (/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(value) ? null : 'not a handle'),
});

const password = (name: string, which: string): NodeGateRequirement => ({
  name,
  what: `password for the dedicated identity on PDS ${which}; may be omitted when headed interactive sign-in is enabled`,
  optional: true,
});

const interactive: NodeGateRequirement = {
  name: NODE_OAUTH_ENV.interactive,
  what: 'set to 1 to complete both PDS sign-ins by hand in a headed browser',
  optional: true,
  check: (value) => (value === '1' ? null : 'must be 1'),
};

const timeout: NodeGateRequirement = {
  name: NODE_OAUTH_ENV.timeoutSeconds,
  what: 'optional timeout in seconds from 30 through 3600 (default 300)',
  optional: true,
  check: (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 30 && parsed <= 3600 ? null : 'must be an integer from 30 to 3600';
  },
};

function signInChecks(env: Readonly<Record<string, string | undefined>>): string[] {
  const interactiveMode = env[NODE_OAUTH_ENV.interactive] === '1';
  const missing: string[] = [];
  for (const [passwordName, which] of [
    [NODE_OAUTH_ENV.passwordA, 'A'],
    [NODE_OAUTH_ENV.passwordB, 'B'],
  ] as const) {
    if (!env[passwordName]?.trim() && !interactiveMode) {
      missing.push(
        `${passwordName} or ${NODE_OAUTH_ENV.interactive}: provide the PDS ${which} account password or enable headed sign-in`,
      );
    }
  }
  return missing;
}

const CONTRACT_BLOCK =
  'confidential OAuth exchange and upstream revocation observations are not implemented; no live request was made';

/**
 * The evidence contract is deliberately blocked even with complete operator
 * inputs. The current verifier does not accept Node OAuth PASS semantics, and
 * no browser disposal or local row deletion is treated as upstream revocation.
 */
export const spec: NodeGateSpec = {
  gate: 'oauth',
  script: 'scripts/live/node_oauth_check.ts',
  requirements: [
    ...IDENTITY_REQS,
    ...PDS_IMPLEMENTATION_REQS,
    handle(NODE_OAUTH_ENV.handleA, 'A'),
    handle(NODE_OAUTH_ENV.handleB, 'B'),
    password(NODE_OAUTH_ENV.passwordA, 'A'),
    password(NODE_OAUTH_ENV.passwordB, 'B'),
    interactive,
    timeout,
  ],
  extraChecks: (env) => [...signInChecks(env), CONTRACT_BLOCK],
  async run() {
    // CONTRACT_BLOCK prevents the harness from invoking this body. Keep the
    // empty result inert if that contract changes before this driver is ported.
    return { pds: [], subjects: [], results: {} };
  },
};

if (isNodeGateMain(import.meta.url)) mainNodeGate(spec);
