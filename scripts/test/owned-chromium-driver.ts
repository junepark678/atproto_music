import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { startOwnedChromium } from '../live/owned-chromium.ts';

const scenario = process.argv[2];
const launchDeadlineAt = performance.now() + 1_500;
const resetFixture = (profile: string) => [
  '-e',
  `const net=require('node:net'); const fs=require('node:fs'); const server=net.createServer(s=>s.destroy()); server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(${JSON.stringify(join(profile, 'DevToolsActivePort'))},server.address().port+'\\n/devtools/browser/reset');}); setInterval(()=>{},1000)`,
];
const launched = startOwnedChromium({
  interactive: false,
  launchDeadlineAt,
  cleanupDeadlineAt: launchDeadlineAt + 1_000,
  ...(scenario === 'reset' ? { executablePath: process.execPath, args: resetFixture } : {}),
});

if (scenario === 'immediate') {
  void launched.terminate();
} else if (scenario === 'microtask') {
  queueMicrotask(() => void launched.terminate());
} else if (scenario === 'timed') {
  setTimeout(() => void launched.terminate(), 10);
} else if (scenario === 'stopped-handshake') {
  setTimeout(() => {
    if (launched.pid !== undefined) process.kill(-launched.pid, 'SIGSTOP');
    void launched.terminate();
  }, 20);
} else {
  if (scenario !== 'reset') throw new Error(`unknown owned Chromium driver scenario: ${scenario}`);
}

let readyError = '';
try {
  const browser = await launched.ready;
  await browser.close();
} catch (error) {
  // Cancellation and startup expiry are expected in these lifecycle scenarios.
  readyError = error instanceof Error ? error.message : String(error);
}

const status = await launched.terminate();
if (!status.processStopped || !status.profileRemoved || !status.connectionSettled) {
  process.stderr.write(`cleanup not confirmed: ${JSON.stringify(status)}\n`);
  process.exitCode = 1;
} else {
  try {
    await access(launched.root);
    process.stderr.write('owned profile still exists after confirmed termination\n');
    process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ root: launched.root, pid: launched.pid, status, readyError })}\n`);
  }
}
