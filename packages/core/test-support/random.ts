import type { Random } from '../src/deps';

export type SeededRandom = Random & {
  /** Next raw 32-bit output, for tests that need integers. */
  nextUint32(): number;
};

/** splitmix32 expands one seed into well-mixed, non-zero xorshift state words. */
function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * Deterministic Random for tests: Marsaglia xorshift128 seeded through
 * splitmix32. The same seed always yields the same sequence, in workerd,
 * Node and the browser. Never use outside tests.
 */
export function seededRandom(seed = 1): SeededRandom {
  if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer, got ${seed}`);
  const mix = splitmix32(seed);
  let x = mix();
  let y = mix();
  let z = mix();
  let w = mix();
  if ((x | y | z | w) === 0) x = 1;

  const nextUint32 = (): number => {
    const t = (x ^ (x << 11)) >>> 0;
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };

  return {
    nextUint32,
    bytes(n: number): Uint8Array {
      if (!Number.isSafeInteger(n) || n < 0) {
        throw new RangeError(`random byte count must be a non-negative safe integer, got ${n}`);
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 4) {
        const word = nextUint32();
        for (let j = 0; j < 4 && i + j < n; j++) out[i + j] = (word >>> (8 * j)) & 0xff;
      }
      return out;
    },
    float(): number {
      const hi = nextUint32() >>> 5;
      const lo = nextUint32() >>> 6;
      return (hi * 67_108_864 + lo) / 9_007_199_254_740_992;
    },
  };
}
