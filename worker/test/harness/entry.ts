// Test-only Worker entry for wrangler.harness.jsonc.
import type { HarnessEnv } from './harness-do';

export { HarnessDO } from './harness-do';

export default {
  /** `/harness/<name>` forwards to the HarnessDO named <name> and reports its migration. */
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const match = /^\/harness\/([A-Za-z0-9_-]{1,64})$/.exec(new URL(request.url).pathname);
    if (!match?.[1]) return new Response('not found', { status: 404 });
    const stub = env.HARNESS.get(env.HARNESS.idFromName(match[1]));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<HarnessEnv>;
