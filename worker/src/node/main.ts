// The production entry of the Node host (ADR 0005 §3.9, §3.10; N3-07),
// bundled by scripts/build-server.ts into worker/dist/node/main.mjs and run by
// the systemd unit as `node --enable-source-maps .../main.mjs`.
//
// The only module with a top-level effect: it hands the process values to
// run() (node/run.ts) and exits with the code it resolves with. It passes no
// test option (no fixture transport, no fixtureOrigins); the Node bundle guard
// (scripts/check-node-bundle.ts) fails a main.mjs that would.

import { run } from './run';

const code = await run({
  argv: process.argv,
  env: process.env,
  exit: (status) => process.exit(status),
});
process.exit(code);
