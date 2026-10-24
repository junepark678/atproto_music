// Sign-in failures (W3-06; M7.2.1 signin_failures). The real SessionController
// runs over an injected library client that fails the way
// @atproto/oauth-client-browser does (its own OAuthCallbackError and
// OAuthResolverError classes). The page's controller, which the
// /oauth/callback screen uses, is pointed at the test's controller at the
// module boundary; nothing reaches a network.

import { OAuthCallbackError, OAuthResolverError } from '@atproto/oauth-client-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryClient } from '../../src/oauth/client';
import { createSession, type SessionController, SIGN_IN_MESSAGES } from '../../src/oauth/session';
import { createAppState } from '../../src/state/store';
import {
  buttonByText,
  click,
  fakeApi,
  linkByText,
  type Mounted,
  mount,
  ORIGIN,
  testServices,
  text,
  type as typeInto,
  until,
  words,
} from './support';

const page = vi.hoisted(() => ({ controller: null as unknown }));

vi.mock('../../src/oauth/session', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/oauth/session')>();
  return { ...mod, session: () => page.controller };
});

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const SECRETS = ['code-secret-1', 'state-secret-9', 'state-gone', 'at-secret-token', 'rt-secret-token'];

interface FakeLibrary extends LibraryClient {
  signIns: string[];
}

function library(behaviour: { init?: () => Promise<never>; signIn?: (input: string) => Promise<void> }): FakeLibrary {
  const signIns: string[] = [];
  return {
    signIns,
    init: behaviour.init ?? (async () => undefined),
    signIn: async (input: string) => {
      signIns.push(input);
      await behaviour.signIn?.(input);
    },
  };
}

function controllerFor(lib: LibraryClient, api: ReturnType<typeof fakeApi>): SessionController {
  const controller = createSession({
    api: api.api,
    origin: ORIGIN,
    storage: null,
    indexedDB: null,
    loadClient: async () => lib,
  });
  page.controller = controller;
  return controller;
}

function expectNoSecrets(root: HTMLElement): void {
  const html = document.documentElement.outerHTML;
  for (const secret of SECRETS) expect(html).not.toContain(secret);
  expect(root.textContent).not.toMatch(/access_denied|Unknown authorization session|Failed to resolve identity/);
}

describe('web/test/routes/signin.test.tsx', () => {
  it('cancelled authorization, expired callback and unknown handle show specific recovery text with retry and no code or token in the DOM', async () => {
    const api = fakeApi();

    // 1. The user cancelled at the authorization server.
    const cancelledParams = new URLSearchParams({
      error: 'access_denied',
      error_description: 'The user denied access',
      state: 'state-secret-9',
      iss: 'https://auth.pds.test',
    });
    const cancelled = controllerFor(
      library({ init: () => Promise.reject(new OAuthCallbackError(cancelledParams)) }),
      api,
    );
    mounted = mount(
      `/oauth/callback?${cancelledParams}`,
      createAppState({ api: api.api }),
      testServices({ session: cancelled }),
    );
    let main = mounted.main();
    await until(() => expect(main.querySelector('[role="alert"]')).not.toBeNull());
    expect(words(main.querySelector('[role="alert"]'))).toBe(
      `${SIGN_IN_MESSAGES.cancelled.title} ${SIGN_IN_MESSAGES.cancelled.message} Try signing in again`,
    );
    expect(text(main.querySelector('[role="alert"] h2'))).toBe('Sign-in was cancelled');
    expect(main.textContent).not.toContain('The user denied access');
    expectNoSecrets(mounted.root);
    // Retry: the link leads to the sign-in form.
    click(linkByText(main, 'Try signing in again'));
    await until(() => expect(main.querySelector('input[name="handle"]')).not.toBeNull());
    expect(location.pathname).toBe('/signin');
    expect(location.search).toBe('');
    expect(text(main.querySelector('h1'))).toBe('Sign in');
    expectNoSecrets(mounted.root);
    mounted.unmount();

    // 2. A callback whose authorization state is unknown (expired or reused).
    const expiredParams = new URLSearchParams({
      code: 'code-secret-1',
      state: 'state-gone',
      iss: 'https://auth.pds.test',
    });
    const expired = controllerFor(
      library({
        init: () => Promise.reject(new OAuthCallbackError(expiredParams, 'Unknown authorization session "state-gone"')),
      }),
      api,
    );
    mounted = mount(
      `/oauth/callback?${expiredParams}`,
      createAppState({ api: api.api }),
      testServices({ session: expired }),
    );
    main = mounted.main();
    await until(() => expect(main.querySelector('[role="alert"]')).not.toBeNull());
    expect(words(main.querySelector('[role="alert"]'))).toBe(
      `${SIGN_IN_MESSAGES.expired_callback.title} ${SIGN_IN_MESSAGES.expired_callback.message} Try signing in again`,
    );
    expect(text(main.querySelector('[role="alert"] h2'))).toBe('This sign-in link has expired');
    expectNoSecrets(mounted.root);
    expect(expired.current()).toBeNull();
    click(linkByText(main, 'Try signing in again'));
    await until(() => expect(main.querySelector('input[name="handle"]')).not.toBeNull());
    expectNoSecrets(mounted.root);
    mounted.unmount();

    // 3. A handle no resolver can find, on the sign-in form itself.
    const lib = library({
      signIn: async (input) => {
        if (input === 'nobody.test') throw new OAuthResolverError(`Failed to resolve identity: ${input}`);
      },
    });
    const controller = controllerFor(lib, api);
    mounted = mount('/signin', createAppState({ api: api.api }), testServices({ session: controller }));
    main = mounted.main();
    await until(() => expect(main.querySelector('input[name="handle"]')).not.toBeNull());
    const input = main.querySelector('input[name="handle"]') as HTMLInputElement;
    expect(main.querySelector('label[for="signin-handle"]')?.textContent).toBe('Your handle');
    typeInto(input, 'nobody.test');
    click(buttonByText(main, 'Sign in'));
    await until(() => expect(main.querySelector('[role="alert"]')).not.toBeNull());
    const alert = main.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-signin-error')).toBe('unknown_handle');
    expect(words(alert)).toBe(
      'Handle not found No account could be found for that handle. Check the spelling and try again. Try again',
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('signin-hint signin-error');
    expect(document.activeElement).toBe(input);
    expect(lib.signIns).toEqual(['nobody.test']);
    expectNoSecrets(mounted.root);

    // Retry with the corrected handle: the redirect starts with it.
    typeInto(input, 'alice.test');
    click(buttonByText(alert, 'Try again'));
    await until(() => expect(lib.signIns).toEqual(['nobody.test', 'alice.test']));
    await until(() =>
      expect(text(main.querySelector('[data-state="loading"]'))).toBe('Contacting your account provider…'),
    );
    expect(main.querySelector('[role="alert"]')).toBeNull();
    // The scope came from meta, fetched once for both attempts.
    expect(api.count('GET /api/v1/meta')).toBeGreaterThanOrEqual(1);
    expect(api.requests.filter((r) => r.path === '/api/v1/meta' && r.query.handle !== undefined)).toEqual([]);
    expectNoSecrets(mounted.root);
  });
});
