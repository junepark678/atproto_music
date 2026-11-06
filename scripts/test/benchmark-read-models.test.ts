import { describe, expect, it, vi } from 'vitest';
import { effectiveCgroupLimits, main, type VisibleProfileInput, visibleProfileErrors } from '../benchmark-read-models';

const valid: VisibleProfileInput = {
  passed: true,
  environment: { cgroupCpuMax: '200000 100000', cgroupMemoryMax: '2147483648' },
  http: {
    paced: true,
    intervalMs: 100,
    warmupRequests: 300,
    measuredRequests: 600,
    warmupErrors: 0,
    errors: 0,
    elapsedMs: 60_000,
  },
};

describe('M6.2.3 visible process-profile subgate', () => {
  it('accepts the exact 2-vCPU/2-GiB host and paced 30 s + 60 s request schedule', () => {
    expect(visibleProfileErrors(valid)).toEqual([]);
    // Quota and period may vary as long as their ratio is exactly two CPUs.
    expect(
      visibleProfileErrors({
        ...valid,
        environment: { ...valid.environment, cgroupCpuMax: '400000 200000' },
      }),
    ).toEqual([]);
  });

  it('rejects unbounded resources, unpaced requests, the wrong counts, duration, errors, and report verdict', () => {
    const rejected = visibleProfileErrors({
      ...valid,
      passed: false,
      environment: { cgroupCpuMax: 'max 100000', cgroupMemoryMax: 'max' },
      http: {
        ...valid.http,
        paced: false,
        intervalMs: 0,
        warmupRequests: 0,
        measuredRequests: 599,
        warmupErrors: 1,
        errors: 1,
        elapsedMs: 58_000,
      },
    });
    expect(rejected).toEqual([
      'the full benchmark report verdict must pass',
      'visible cgroup-v2 CPU quota must be exactly 2 vCPU (observed unavailable)',
      'visible cgroup-v2 memory.max must be exactly 2147483648 bytes (2 GiB)',
      'HTTP requests must be paced every 100 ms (10 requests/second)',
      'HTTP warmup must be exactly 300 requests (30 seconds at 10 requests/second)',
      'HTTP measurement must be exactly 600 requests',
      'HTTP measurement duration must be within 59-62 seconds',
      'HTTP warmup and measurement must have zero errors',
    ]);
  });

  it('uses the tightest current or ancestor cgroup limit and fails closed when hierarchy data is missing', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/atmusic.service'],
      ['/sys/fs/cgroup/user.slice/atmusic.service/cpu.max', '400000 200000'],
      ['/sys/fs/cgroup/user.slice/atmusic.service/memory.max', '3221225472'],
      ['/sys/fs/cgroup/user.slice/cpu.max', '300000 100000'],
      ['/sys/fs/cgroup/user.slice/memory.max', '2147483648'],
      ['/sys/fs/cgroup/cpu.max', 'max 100000'],
      ['/sys/fs/cgroup/memory.max', 'max'],
    ]);
    const readFile = (path: string) => files.get(path) ?? null;
    expect(effectiveCgroupLimits(readFile)).toEqual({
      cgroupCpuMax: '400000 200000',
      cgroupMemoryMax: '2147483648',
    });

    files.set('/sys/fs/cgroup/user.slice/atmusic.service/cpu.max', '400000 100000');
    files.set('/sys/fs/cgroup/user.slice/atmusic.service/memory.max', '2147483648');
    files.set('/sys/fs/cgroup/user.slice/cpu.max', '200000 100000');
    files.set('/sys/fs/cgroup/user.slice/memory.max', '1073741824');
    expect(effectiveCgroupLimits(readFile)).toEqual({
      cgroupCpuMax: '200000 100000',
      cgroupMemoryMax: '1073741824',
    });

    files.delete('/sys/fs/cgroup/user.slice/memory.max');
    expect(effectiveCgroupLimits(readFile)).toEqual({ cgroupCpuMax: null, cgroupMemoryMax: null });
  });

  it('rejects fractional CPU quotas and malformed cgroup values', () => {
    const errors = visibleProfileErrors({
      ...valid,
      environment: { cgroupCpuMax: '150000 100000', cgroupMemoryMax: '2G' },
    });
    expect(errors).toEqual([
      'visible cgroup-v2 CPU quota must be exactly 2 vCPU (observed 1.5)',
      'visible cgroup-v2 memory.max must be exactly 2147483648 bytes (2 GiB)',
    ]);
  });

  it('requires paced requests before checking the visible process profile', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(main(['--require-visible-profile'])).toBe(2);
      expect(error).toHaveBeenCalledWith('benchmark: --require-visible-profile requires --paced');
    } finally {
      error.mockRestore();
    }
  });
});
