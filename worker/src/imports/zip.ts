// Bounded streaming ZIP extraction (ADR 0005 §11.1, §13 "Abuse"; N3-09).
//
// Nothing is inflated whole: the archive is pushed through fflate's
// streaming `Unzip` in small slices, every accepted entry is inflated by
// `UnzipInflate` (or passed through when stored), and its bytes are handed to
// the caller as they appear. The bomb bounds count what actually happens,
// never the sizes the ZIP headers declare (they are attacker-controlled):
//
// - at most MAX_ZIP_ENTRIES (10,000) entries, skipped ones included;
// - at most MAX_ENTRY_INFLATED (64 MiB) inflated bytes per entry;
// - at most MAX_TOTAL_INFLATED (256 MiB) inflated bytes in total;
// - an inflated/compressed ratio of at most MAX_RATIO (100) per entry, where
//   the compressed bytes are the ones actually fed to that entry's decoder:
//   checked when the entry ends, and early once the entry has inflated more
//   than RATIO_EARLY_SLACK past 100 × what it consumed (a bomb never gets to
//   allocate its full output first).
//
// Each push is at most PUSH_SLICE bytes, so one push can inflate at most
// ~1,032 × PUSH_SLICE bytes (DEFLATE's maximum ratio) before a bound is
// checked. Crossing a bound throws ZipBoundError and aborts the parse.
//
// Entries the caller does not `accept` are skipped unread: their decoder
// discards the compressed bytes without inflating them. An accepted entry
// with a compression method other than stored (0) or DEFLATE (8) is refused.

import { Unzip, type UnzipDecoder, type UnzipFile, UnzipInflate } from 'fflate';

export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ENTRY_INFLATED = 64 * 1024 * 1024;
export const MAX_TOTAL_INFLATED = 256 * 1024 * 1024;
export const MAX_RATIO = 100;
export const RATIO_EARLY_SLACK = 1024 * 1024;
export const PUSH_SLICE = 8 * 1024;

export type ZipBound =
  | 'too_many_entries'
  | 'entry_too_large'
  | 'total_too_large'
  | 'ratio_too_high'
  | 'unsupported_compression'
  | 'malformed';

/** A bound was crossed or the archive is broken; the job fails with `zip_<bound>`. */
export class ZipBoundError extends Error {
  override readonly name = 'ZipBoundError';
  constructor(readonly bound: ZipBound) {
    super(`zip refused: ${bound}`);
  }
}

export interface ZipHandlers {
  /** True to read the entry; false to skip it unread. */
  accept(name: string): boolean;
  /** Inflated bytes of an accepted entry, in order. Synchronous: it runs inside fflate's push. */
  data(name: string, chunk: Uint8Array, final: boolean): void;
}

export interface ZipStats {
  entries: number;
  inflated: number;
}

interface EntryMeter {
  compressed: number;
  inflated: number;
}

/**
 * Reads the archive `source` (its bytes in order) through the bounds above.
 * `drain` is awaited after every push: the caller processes, asynchronously,
 * whatever `data` buffered during it.
 */
export async function readZip(
  source: AsyncIterable<Uint8Array>,
  handlers: ZipHandlers,
  drain: () => Promise<void> = async () => {},
): Promise<ZipStats> {
  const stats: ZipStats = { entries: 0, inflated: 0 };
  let failure: ZipBoundError | null = null;
  const fail = (bound: ZipBound): void => {
    if (failure === null) failure = new ZipBoundError(bound);
  };

  // The entry being started: fflate builds its decoder synchronously inside
  // `file.start()`, so the decoder picks up the entry's meter from here.
  let starting: { read: boolean; meter: EntryMeter } = { read: false, meter: { compressed: 0, inflated: 0 } };

  // The decoder wraps UnzipInflate (or a pass-through) and counts the
  // compressed bytes it is actually fed; for a skipped entry it discards them.
  const makeDecoder = (inflate: boolean) =>
    class CountingDecoder implements UnzipDecoder {
      static compression = inflate ? 8 : 0;
      ondata: UnzipDecoder['ondata'] = () => {};
      private readonly meter: EntryMeter;
      private readonly inner: UnzipDecoder | null;
      constructor(_filename: string) {
        this.meter = starting.meter;
        if (!starting.read) {
          this.inner = null;
        } else if (inflate) {
          const inner = new UnzipInflate();
          inner.ondata = (err, dat, final) => this.ondata(err, dat, final);
          this.inner = inner;
        } else {
          this.inner = {
            ondata: () => {},
            push: (chunk, final) => this.ondata(null, chunk as Uint8Array<ArrayBuffer>, final),
          };
        }
      }
      push(chunk: Uint8Array, final: boolean): void {
        this.meter.compressed += chunk.length;
        if (this.inner === null) return;
        this.inner.push(chunk, final);
      }
    };

  const unzip = new Unzip((file: UnzipFile) => {
    if (failure !== null) return;
    stats.entries += 1;
    if (stats.entries > MAX_ZIP_ENTRIES) {
      fail('too_many_entries');
      return;
    }
    const name = file.name;
    const read = handlers.accept(name);
    if (read && file.compression !== 0 && file.compression !== 8) {
      fail('unsupported_compression');
      return;
    }
    const meter: EntryMeter = { compressed: 0, inflated: 0 };
    if (!read) {
      // Skipped unread; a method we cannot even discard is left unstarted.
      if (file.compression === 0 || file.compression === 8) {
        file.ondata = () => {};
        starting = { read: false, meter };
        file.start();
      }
      return;
    }
    file.ondata = (err, chunk, final) => {
      if (failure !== null) return;
      if (err !== null) {
        fail('malformed');
        return;
      }
      meter.inflated += chunk.length;
      stats.inflated += chunk.length;
      if (meter.inflated > MAX_ENTRY_INFLATED) return fail('entry_too_large');
      if (stats.inflated > MAX_TOTAL_INFLATED) return fail('total_too_large');
      if (meter.inflated > MAX_RATIO * meter.compressed + RATIO_EARLY_SLACK) return fail('ratio_too_high');
      if (final && meter.inflated > MAX_RATIO * Math.max(1, meter.compressed)) return fail('ratio_too_high');
      handlers.data(name, chunk, final);
    };
    starting = { read: true, meter };
    file.start();
  });
  unzip.register(makeDecoder(true));
  unzip.register(makeDecoder(false));

  const push = (chunk: Uint8Array, final: boolean): void => {
    try {
      unzip.push(chunk, final);
    } catch {
      fail('malformed');
    }
  };
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length; offset += PUSH_SLICE) {
      push(chunk.subarray(offset, Math.min(chunk.length, offset + PUSH_SLICE)), false);
      if (failure !== null) throw failure;
      await drain();
    }
  }
  push(new Uint8Array(0), true);
  if (failure !== null) throw failure;
  await drain();
  if (stats.entries === 0) throw new ZipBoundError('malformed');
  return stats;
}
