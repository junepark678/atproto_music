// Live gate: browser OAuth sign-in on both PDSs (ADR 0004 §5.1, A3, Q5; W6-05).
//
// Usage: npx tsx scripts/live/workers_oauth_check.ts
//
// Drives the deployed SPA in Chromium (Playwright; `npx playwright install
// chromium` once) for each dedicated identity:
// 1. /oauth/client-metadata.json on the deployed origin is the browser public
//    client document: client_id = <origin>/oauth/client-metadata.json,
//    redirect <origin>/oauth/callback, token_endpoint_auth_method none,
//    DPoP-bound tokens, and the granular scope
//    `atproto repo:<p>.scrobble repo:<p>.follow repo:<p>.settings`.
// 2. /signin → the PDS authorization server → /oauth/callback → /feed. With
//    ATMUSIC_LIVE_PASSWORD_{A,B} the sign-in and consent screens are filled
//    automatically (headless); with ATMUSIC_LIVE_OAUTH_INTERACTIVE=1 a headed
//    browser opens and the operator signs in by hand.
// 3. The token endpoint's response is observed in the browser for its `scope`
//    and `sub` only (the tokens themselves are never read into the evidence):
//    `sub` must be the expected DID, every `repo:<p>.*` scope must be granted
//    and `transition:generic` must not be (Q5).
// 4. /signin then shows the signed-in DID, and /settings "Sign out" revokes
//    the session; the ephemeral browser context is discarded.
//
// Without the prerequisites it prints a `blocked` result listing each missing
// variable and exits 2 before launching a browser or making any request.

import { collectionsFor } from '@atmusic/core/namespace';
import type { Page } from '@playwright/test';
import {
  checkDeployment,
  checkIdentityPds,
  ENV,
  type EnvMap,
  expect,
  field,
  type GateContext,
  GateFailure,
  type GateSpec,
  httpJson,
  IDENTITY_REQS,
  isMain,
  main,
  normalizedOrigin,
  oneOf,
  type PdsInfo,
  pdsInfo,
  RELEASE_REQS,
  type Requirement,
  type Subject,
  sleep,
} from './live-gate.ts';

export const OAUTH_ENV = {
  handleA: 'ATMUSIC_LIVE_HANDLE_A',
  handleB: 'ATMUSIC_LIVE_HANDLE_B',
  passwordA: 'ATMUSIC_LIVE_PASSWORD_A',
  passwordB: 'ATMUSIC_LIVE_PASSWORD_B',
  interactive: 'ATMUSIC_LIVE_OAUTH_INTERACTIVE',
  timeoutSeconds: 'ATMUSIC_LIVE_OAUTH_TIMEOUT_S',
} as const;

const handleReq = (name: string, which: string): Requirement => ({
  name,
  what: `handle of the dedicated identity on PDS ${which}`,
  check: (v) => (/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(v) ? null : 'not a handle'),
});
const secretReq = (name: string, what: string): Requirement => ({ name, what });
const interactiveReq: Requirement = {
  name: OAUTH_ENV.interactive,
  what: 'set to 1 to sign in by hand in a headed browser instead',
  check: (v) => (v === '1' ? null : 'must be 1'),
};

/** Sign-in credentials for identity `which`: an account password, or interactive mode. */
export function signInChecks(env: EnvMap, passwordName: string, which: string): string[] {
  return oneOf(
    env,
    [[secretReq(passwordName, `account password on PDS ${which}`)], [interactiveReq]],
    `account password for the automated sign-in on PDS ${which}`,
  );
}

export const OAUTH_REQS: readonly Requirement[] = [
  handleReq(OAUTH_ENV.handleA, 'A'),
  handleReq(OAUTH_ENV.handleB, 'B'),
];

export function grantedScopes(
  prefix: string,
  scope: string,
): { repoScopesGranted: boolean; transitionGeneric: boolean } {
  const tokens = scope.split(/\s+/).filter(Boolean);
  const c = collectionsFor(prefix);
  const granted = (nsid: string) => tokens.some((t) => t === `repo:${nsid}` || t.startsWith(`repo:${nsid}?`));
  return {
    repoScopesGranted: tokens.includes('atproto') && [c.scrobble, c.follow, c.settings].every(granted),
    transitionGeneric: tokens.some((t) => t.startsWith('transition:')),
  };
}

export async function checkClientMetadata(ctx: GateContext): Promise<Record<string, unknown>> {
  const url = new URL('/oauth/client-metadata.json', ctx.origin);
  const res = await httpJson(url);
  expect(res.status === 200, `GET /oauth/client-metadata.json returned ${res.status}`);
  const doc = res.json;
  const scope = String(field(doc, 'scope') ?? '');
  const redirects = field<unknown[]>(doc, 'redirect_uris');
  expect(field(doc, 'client_id') === url.href, `client_id is not ${url.href}`);
  expect(
    Array.isArray(redirects) && redirects.includes(`${ctx.origin}/oauth/callback`),
    'redirect_uris lacks /oauth/callback',
  );
  expect(field(doc, 'token_endpoint_auth_method') === 'none', 'client is not a public client');
  expect(field(doc, 'dpop_bound_access_tokens') === true, 'tokens are not DPoP-bound');
  const scopes = grantedScopes(ctx.prefix, scope);
  expect(
    scopes.repoScopesGranted && !scopes.transitionGeneric,
    `client scope is not the granular repo scope: ${scope}`,
  );
  return { clientId: field(doc, 'client_id'), scope, applicationType: field(doc, 'application_type') };
}

export interface SignInOptions {
  origin: string;
  handle: string;
  /** Account password; undefined = the operator completes the server's screens by hand. */
  password: string | undefined;
  timeoutMs: number;
}

export interface SignInResult {
  did: string;
  grantedScope: string;
  tokenSub: string | null;
}

/** Fill the authorization server's sign-in and consent screens (reference PDS UI and lookalikes). */
async function completeAuthorization(page: Page, origin: string, handle: string, password: string): Promise<void> {
  let passwordSent = false;
  for (let step = 0; step < 20; step++) {
    if (new URL(page.url()).origin === origin) return;
    const passwordField = page.locator('input[type="password"]').first();
    if (!passwordSent && (await passwordField.isVisible().catch(() => false))) {
      const identifier = page.locator('input[autocomplete="username"], input[name="username"]').first();
      if ((await identifier.isVisible().catch(() => false)) && (await identifier.inputValue()) === '') {
        await identifier.fill(handle);
      }
      await passwordField.fill(password);
      await passwordField.press('Enter');
      passwordSent = true;
    } else {
      const consent = page.getByRole('button', { name: /^(authorize|accept|allow|approve)$/i }).first();
      if (await consent.isVisible().catch(() => false)) await consent.click();
      else {
        const next = page.getByRole('button', { name: /^(next|continue|sign in|log in)$/i }).first();
        if (await next.isVisible().catch(() => false)) await next.click();
      }
    }
    await sleep(1500);
  }
}

/**
 * Sign in through the deployed SPA. Observes only `scope` and `sub` of the
 * authorization-code token response; tokens are never copied out of the page.
 */
export async function signInThroughApp(page: Page, o: SignInOptions): Promise<SignInResult> {
  const origin = normalizedOrigin(o.origin);
  let grant: { scope: string; sub: string | null } | null = null;
  page.on('response', async (response) => {
    const request = response.request();
    if (request.method() !== 'POST' || new URL(response.url()).origin === origin) return;
    if (!/grant_type=authorization_code/.test(request.postData() ?? '')) return;
    try {
      const body: unknown = await response.json();
      const scope = field(body, 'scope');
      if (typeof scope === 'string')
        grant = { scope, sub: typeof field(body, 'sub') === 'string' ? (field(body, 'sub') as string) : null };
    } catch {
      // Not JSON (a DPoP nonce retry or an error); the next response is checked.
    }
  });
  await page.goto(new URL('/signin', origin).href);
  await page.locator('#signin-handle').fill(o.handle);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin !== origin, { timeout: 30_000 });
  if (o.password !== undefined) await completeAuthorization(page, origin, o.handle, o.password);
  await page.waitForURL((url) => url.origin === origin && url.pathname === '/feed', { timeout: o.timeoutMs });
  for (let i = 0; i < 20 && grant === null; i++) await sleep(250);
  const observed = grant as { scope: string; sub: string | null } | null;
  if (observed === null) throw new GateFailure(`${o.handle}: no authorization-code token response was observed`);
  await page.goto(new URL('/signin', origin).href);
  const did = ((await page.locator('section code').first().textContent({ timeout: 15_000 })) ?? '').trim();
  return { did, grantedScope: observed.scope, tokenSub: observed.sub };
}

/** /settings → Sign out (revokes the session at the authorization server). */
export async function signOutOfApp(page: Page, origin: string): Promise<boolean> {
  try {
    await page.goto(new URL('/settings', origin).href);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click({ timeout: 15_000 });
    await page.waitForFunction("!document.body.innerText.includes('Signing out…')", undefined, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export async function launchBrowser(env: EnvMap) {
  const { chromium } = await import('@playwright/test');
  try {
    return await chromium.launch({ headless: env[OAUTH_ENV.interactive] !== '1' });
  } catch (error) {
    throw new GateFailure(`cannot launch Chromium (run \`npx playwright install chromium\`): ${String(error)}`);
  }
}

export function signInTimeoutMs(env: EnvMap): number {
  const seconds = Number(env[OAUTH_ENV.timeoutSeconds] || (env[OAUTH_ENV.interactive] === '1' ? 600 : 120));
  return seconds * 1000;
}

export const spec: GateSpec = {
  gate: 'oauth',
  script: 'scripts/live/workers_oauth_check.ts',
  requirements: [...RELEASE_REQS, ...IDENTITY_REQS, ...OAUTH_REQS],
  extraChecks: (env) => [
    ...signInChecks(env, OAUTH_ENV.passwordA, 'A'),
    ...signInChecks(env, OAUTH_ENV.passwordB, 'B'),
  ],
  async run(ctx) {
    const deployment = await checkDeployment(ctx);
    const clientMetadata = await checkClientMetadata(ctx);
    const pds: PdsInfo[] = [];
    const subjects: Subject[] = [];
    const signIns: Record<string, unknown>[] = [];
    const browser = await launchBrowser(ctx.env);
    try {
      for (const [didName, pdsName, handleName, passwordName, implName] of [
        [ENV.didA, ENV.pdsA, OAUTH_ENV.handleA, OAUTH_ENV.passwordA, 'ATMUSIC_LIVE_PDS_A_IMPLEMENTATION'],
        [ENV.didB, ENV.pdsB, OAUTH_ENV.handleB, OAUTH_ENV.passwordB, 'ATMUSIC_LIVE_PDS_B_IMPLEMENTATION'],
      ] as const) {
        const expectedDid = ctx.get(didName);
        const info = await pdsInfo(ctx.get(pdsName), ctx.env[implName]);
        pds.push(info);
        subjects.push({ did: expectedDid, uri: null });
        await checkIdentityPds(expectedDid, info.endpoint);
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const password = ctx.env[OAUTH_ENV.interactive] === '1' ? undefined : ctx.get(passwordName);
          const result = await signInThroughApp(page, {
            origin: ctx.origin,
            handle: ctx.get(handleName),
            password,
            timeoutMs: signInTimeoutMs(ctx.env),
          });
          const scopes = grantedScopes(ctx.prefix, result.grantedScope);
          const signedOut = await signOutOfApp(page, ctx.origin);
          signIns.push({
            did: result.did,
            pds: info.endpoint,
            grantedScope: result.grantedScope,
            ...scopes,
            signedOut,
          });
          if (result.did !== expectedDid)
            ctx.fail(`${info.endpoint}: the app signed in as ${result.did}, not ${expectedDid}`);
          if (result.tokenSub !== null && result.tokenSub !== expectedDid) {
            ctx.fail(`${info.endpoint}: token sub ${result.tokenSub} is not ${expectedDid}`);
          }
          if (!scopes.repoScopesGranted)
            ctx.fail(`${info.endpoint}: granular repo scopes not granted (${result.grantedScope})`);
          if (scopes.transitionGeneric) ctx.fail(`${info.endpoint}: a transition:* scope was granted`);
          ctx.cleanup(
            signedOut
              ? `${expectedDid}: signed out through /settings, browser context discarded`
              : `${expectedDid}: sign-out did not complete; browser context discarded, revoke the session on ${info.endpoint}`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
    return { pds, subjects, results: { deployment, clientMetadata, signIns } };
  },
};

if (isMain(import.meta.url)) main(spec);
