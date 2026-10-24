# Request routing: Static Assets and the Worker

This note covers how a request reaches Static Assets or the Worker ([ADR 0004](../adr/0004-cloudflare-workers.md) §4.2 and §15 Q9).

## Configuration

`worker/wrangler.jsonc` and the e2e mirror `worker/test/e2e/wrangler.e2e.jsonc` both set these values:

```jsonc
"assets": {
  "directory": "../web/dist",
  "binding": "ASSETS",
  "not_found_handling": "none",
  "run_worker_first": ["/api/*", "/health/*", "/internal/*"]
}
```

`env.free` and `env.staging` inherit `assets`. If an env ever re-declares `assets`, it must keep `not_found_handling: "none"`.

## Which code answers which request

| Request | Answered by |
|---|---|
| `/api/*`, `/health/*`, `/internal/*` (any method) | Worker routes. An unknown path gets the JSON `not_found` 404. A known path with the wrong method gets 405 (the plain 404 under `/internal/`). |
| An existing file (`/`, `/assets/index-<hash>.js`, `/oauth/client-metadata.json`, ...) | Static Assets. This is free and never invokes the Worker. |
| Any other path with a method other than GET or HEAD | Worker: JSON `not_found` 404. ASSETS is not consulted and no 405 is sent. |
| A path that fails the oracle's `safe_path` check (an encoded `/`, `\` or `%`, a control character, a `.` or `..` segment, or invalid UTF-8) | Worker: JSON `not_found` 404. ASSETS is not consulted. |
| A GET or HEAD miss on an SPA route | Worker: `index.html`, fetched from ASSETS at `/`, sent as 200 with no redirect. |
| Any other GET or HEAD miss (`/assets/*`, unknown paths, `/oauth/<other>`, ...) | Worker: JSON `not_found` 404 with `x-request-id`. |

The SPA routes come from one table, `packages/core/src/spa-routes.ts`. `web/src/router.tsx` renders it and `worker/src/router.ts` imports it, so the Worker bundle does not pull in preact. The routes are `/`, `/feed`, `/signin`, `/oauth/callback`, `/u/<did>`, `/scrobble` and `/settings`. A path matches when its non-empty segments match the route. The `/u/<did>` route therefore accepts a raw DID (`/u/did:plc:…`, `/u/did:web:host`) as well as a percent-encoded one (`/u/did%3Aplc%3A…`). A new screen needs a new entry in that table; without one, a deep link to the screen gets the JSON 404.

## Operational consequences

- **Billing.** Loading an SPA deep link (any route except `/`) is a billed Worker invocation. Asset hits stay free.
- **Free-plan quota exhaustion.** Once the Workers quota is spent, `/` and the hashed assets still load, but deep links stop working the same way `/api/*` does. Inside a loaded SPA, client-side navigation keeps working.
- **Why not `single-page-application`.** The platform fallback served `index.html` for missing `/assets/*` files. It also redirected raw `/u/did:…` paths with a 307 and answered POST to SPA paths with 405. These behaviours contradict the Rust oracle (`crates/server/tests/assets.rs`) and §15 Q9.

## Tests

- `worker/test/composition/routing.test.ts` › `asset miss: SPA route GET/HEAD serves index.html 200, every other miss is JSON not_found with x-request-id` checks these rules in workerd against a Static Assets stand-in.
- `web/tests/mvp.spec.ts` checks the same rules under `wrangler dev` with the real Static Assets layer (`npm run test:e2e`).
