import { isNodeGateMain } from './node-live-gate.ts';

export const DEVENV_OAUTH_ENV = ['ATMUSIC_DEVENV_PDS_URL', 'ATMUSIC_DEVENV_HTTPS_ORIGIN'] as const;

export function runDevenvOauthCheck(env: Readonly<Record<string, string | undefined>>): number {
  const missing = DEVENV_OAUTH_ENV.filter((name) => !env[name]?.trim());
  const invalid: string[] = [];
  for (const name of ['ATMUSIC_DEVENV_PDS_URL', 'ATMUSIC_DEVENV_HTTPS_ORIGIN'] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      const valid =
        name === 'ATMUSIC_DEVENV_HTTPS_ORIGIN'
          ? url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            url.pathname === '/' &&
            !url.search &&
            !url.hash &&
            url.origin === value
          : (url.protocol === 'https:' || url.protocol === 'http:') &&
            !!url.hostname &&
            !url.username &&
            !url.password &&
            url.pathname === '/' &&
            !url.search &&
            !url.hash &&
            url.origin === value;
      if (!valid) invalid.push(name);
    } catch {
      invalid.push(name);
    }
  }
  const evidence = {
    schemaVersion: 3,
    runtime: 'node',
    fixtureOnly: true,
    gate: 'devenvOauth',
    result: 'blocked',
    missing,
    invalid,
    reason:
      missing.length || invalid.length
        ? `Invalid or missing prerequisites: ${[...missing, ...invalid].join(', ')}`
        : 'Confidential-client OAuth exchange and upstream revocation are not implemented; no endpoints were contacted.',
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  return 2;
}

if (isNodeGateMain(import.meta.url)) process.exitCode = runDevenvOauthCheck(process.env);
