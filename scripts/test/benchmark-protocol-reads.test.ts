import { describe, expect, it } from 'vitest';
import { type ProtocolReadsReport, REPORT_SCHEMA_ID, renderReport, validateReport } from '../benchmark-protocol-reads';

const plan = {
  sql: 'SELECT * FROM scrobbles s',
  details: ['SEARCH s USING INDEX scrobbles_stats (did=?)'],
};
const timing = { runs: 10, p50Ms: 10, p95Ms: 20 };

function report(): ProtocolReadsReport {
  return {
    schema: REPORT_SCHEMA_ID,
    generatedBy: 'worker/test/bench/protocol-reads.bench.test.ts',
    generatedAt: '2026-01-15T12:00:00.000Z',
    dataset: {
      listens: 100_000,
      seed: 24301,
      clock: '2026-01-15T12:00:00Z',
      applyPathRecords: 100,
      operations: {
        total: 256,
        scrobbleCreateSucceeded: 250,
        scrobbleDelete: {
          queued: 1,
          running: 1,
          blocked: 1,
          failed: 1,
          succeededMatchingCid: 1,
          succeededStaleCid: 1,
        },
        visibleScrobbles: 99_995,
        hiddenScrobbles: 5,
      },
    },
    plans: {
      source: 'test',
      topTracks: [plan],
      recentTracks: [plan],
      listenbrainzAllTime: [plan],
      listeningActivityYear: [plan],
    },
    reads: {
      topTracks: { cached: timing, uncached: timing },
      recentTracksPage500: timing,
      listenbrainzAllTime: timing,
      listeningActivityYear: timing,
    },
  };
}

describe('protocol-read benchmark report', () => {
  it('validates and renders the measured operation population', () => {
    const value = report();
    expect(() => validateReport(value)).not.toThrow();
    expect(renderReport(value)).toContain('256 operations (250 succeeded scrobble creates, 6 scrobble deletes)');
    expect(renderReport(value)).toContain('99,995 visible / 5 hidden listens');
    expect(renderReport(value)).toContain('nearest-rank p95 is the slowest sample');
  });

  it('renders both saved percentiles and rejects mismatched comparison fixtures', () => {
    const current = report();
    const baseline = report();
    baseline.generatedAt = '2026-01-14T12:00:00.000Z';
    baseline.reads.topTracks = { cached: timing, uncached: { runs: 10, p50Ms: 9138.39, p95Ms: 10007.29 } };
    const rendered = renderReport(current, baseline);
    expect(rendered).toContain('| top-tracks uncached | 9138.39 | 10007.29 | 10.00 | 20.00 |');
    expect(rendered).toContain('not made under controlled load');
    expect(rendered).toContain('2026-01-14T12:00:00.000Z');
    expect(rendered).toContain('does not establish lifetime scaling');
    baseline.dataset.seed++;
    expect(() => renderReport(current, baseline)).toThrow(/baseline dataset must match/);
  });

  it('rejects inconsistent operation totals and visibility counts', () => {
    const badTotal = report();
    badTotal.dataset.operations.total++;
    expect(() => validateReport(badTotal)).toThrow(/invalid protocol-read report envelope/);

    const badVisibility = report();
    badVisibility.dataset.operations.hiddenScrobbles--;
    expect(() => validateReport(badVisibility)).toThrow(/invalid protocol-read report envelope/);

    const negativeVisible = report();
    negativeVisible.dataset.operations.visibleScrobbles = -1;
    negativeVisible.dataset.operations.hiddenScrobbles = 100_001;
    expect(() => validateReport(negativeVisible)).toThrow(/invalid protocol-read report envelope/);

    const negativeHidden = report();
    negativeHidden.dataset.operations.visibleScrobbles = 100_001;
    negativeHidden.dataset.operations.hiddenScrobbles = -1;
    expect(() => validateReport(negativeHidden)).toThrow(/invalid protocol-read report envelope/);
  });

  it('rejects unrecognized delete-state fields instead of omitting them from rendered totals', () => {
    const value = report();
    const withExtra = value.dataset.operations.scrobbleDelete as typeof value.dataset.operations.scrobbleDelete & {
      extra?: number;
    };
    withExtra.extra = 1;
    value.dataset.operations.total++;
    expect(() => validateReport(value)).toThrow(/invalid protocol-read report envelope/);
  });

  it('rejects legacy receipts that do not describe the operations dataset', () => {
    const legacy: unknown = { ...report(), schema: 'atmusic/protocol-reads-benchmark@1' };
    expect(() => validateReport(legacy)).toThrow(/invalid protocol-read report envelope/);
  });
});
