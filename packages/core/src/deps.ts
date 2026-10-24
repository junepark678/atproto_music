// Injected time and randomness (ADR 0004 §4.4). Frozen in Wave 0.
//
// Every validator, retry policy, bucket, cache, timer and TID generator takes a
// Clock and/or Random instead of reading Date.now() or Math.random(), so tests
// can run against `fixedClock` and a seeded Random (packages/core/test-support).

/** Wall-clock source. `nowMs()` is integer epoch milliseconds. */
export interface Clock {
  nowMs(): number;
}

/** Randomness source. `float()` is uniform in [0, 1). */
export interface Random {
  bytes(n: number): Uint8Array;
  float(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

// crypto.getRandomValues refuses more than 65,536 bytes per call.
const MAX_RANDOM_CHUNK = 65_536;
const TWO_POW_26 = 67_108_864;
const TWO_POW_53 = 9_007_199_254_740_992;

export const cryptoRandom: Random = {
  bytes(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RangeError(`random byte count must be a non-negative safe integer, got ${n}`);
    }
    const out = new Uint8Array(n);
    for (let offset = 0; offset < n; offset += MAX_RANDOM_CHUNK) {
      crypto.getRandomValues(out.subarray(offset, Math.min(n, offset + MAX_RANDOM_CHUNK)));
    }
    return out;
  },
  float(): number {
    // 53 uniformly random bits: 27 from the first word, 26 from the second.
    const words = crypto.getRandomValues(new Uint32Array(2));
    const hi = (words[0] as number) >>> 5;
    const lo = (words[1] as number) >>> 6;
    return (hi * TWO_POW_26 + lo) / TWO_POW_53;
  },
};
