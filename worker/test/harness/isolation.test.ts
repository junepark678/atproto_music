// M1.4.3/harness_isolation. The peer file is isolation-peer.test.ts.
import { describe, it } from 'vitest';
import { probeIsolation } from './isolation-probe';

describe('worker/test/harness', () => {
  it('rows written under one DO name are absent under another DO name and in another test file', async () => {
    await probeIsolation('isolation');
  });
});
