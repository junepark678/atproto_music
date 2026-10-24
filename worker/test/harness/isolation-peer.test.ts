// The other test file of M1.4.3/harness_isolation (see isolation.test.ts): it
// writes its own marker under the same shared DO name and must not see the
// marker isolation.test.ts writes there.
import { describe, it } from 'vitest';
import { probeIsolation } from './isolation-probe';

describe('worker/test/harness', () => {
  it('rows written by isolation.test.ts under the shared DO name are absent in this test file', async () => {
    await probeIsolation('isolation-peer');
  });
});
