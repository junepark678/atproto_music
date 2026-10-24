// The production Worker entry (ADR 0004 §1.1, §4.2: `main` of
// worker/wrangler.jsonc). Exactly two exports, because every named export of
// the main module is a Workers entrypoint:
// - `default`: the `fetch` and `scheduled` handlers (router.ts, scheduled.ts)
//   over the system clock and crypto randomness;
// - `IndexDO`: the class of the `INDEX` Durable Object binding.
//
// This module and everything it imports never import test-support;
// scripts/check-bundle.ts asserts that against the emitted bundle.

import { createWorker } from './router';

export { IndexDO } from './do/index-do';

export default createWorker();
