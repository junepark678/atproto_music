// scripts/admin/pitr-restore.ts exit status once the POST has left (W6R-04;
// ADR 0004 §3.2, §9.2 A15). Status 2 promises "nothing sent", so any failure
// after the request went out (a 202 whose body is not JSON, a failure while
// reporting the accepted restore) must be status 1 with a message that the
// restore may have been accepted. Runs `main` in process with a counting fake
// fetch and the frozen clock 2026-01-15T12:00:00Z; nothing touches the network.

import { describe, expect, it } from 'vitest';
import { main, type PitrDeps } from '../admin/pitr-restore.ts';

const FROZEN_NOW = Date.parse('2026-01-15T12:00:00Z');
const AT = '2026-01-15T11:00:00Z';
const AT_MS = Date.parse(AT);
const TOKEN = `${'a'.repeat(16)}${'B'.repeat(16)}${'c'.repeat(8)}`;
const URL = 'https://music.214510.xyz/internal/admin/pitr';

interface Harness {
  calls: { url: string; init: RequestInit }[];
  out: string[];
  err: string[];
  deps: PitrDeps;
}

function harness(
  respond: () => Response | Promise<Response>,
  opts: { failOut?: (line: string) => boolean } = {},
): Harness {
  const h: Harness = {
    calls: [],
    out: [],
    err: [],
    deps: {
      fetch: async (url, init) => {
        h.calls.push({ url, init });
        return respond();
      },
      nowMs: () => FROZEN_NOW,
      out: (line) => {
        if (opts.failOut?.(line)) throw new Error('stdout closed (EPIPE)');
        h.out.push(line);
      },
      err: (line) => h.err.push(line),
    },
  };
  return h;
}

const run = (h: Harness, argv: readonly string[] = ['--at', AT, '--yes']) => main(argv, { ADMIN_TOKEN: TOKEN }, h.deps);

describe('scripts/admin/pitr-restore.ts after the POST', () => {
  it('error after an accepted POST exits 1, not 2', async () => {
    // A 202 whose body is not JSON: the Worker accepted the request, so the
    // tool must not claim nothing was sent (2), nor that it was scheduled (0).
    for (const [label, body, type] of [
      ['non-JSON text', 'Accepted', 'text/plain'],
      ['truncated JSON', '{"bookmark":"bm-0', 'application/json'],
      ['empty body', '', 'application/json'],
      ['JSON null', 'null', 'application/json'],
      ['JSON array', '[]', 'application/json'],
    ] as const) {
      const h = harness(() => new Response(body, { status: 202, headers: { 'content-type': type } }));
      expect(await run(h), label).toBe(1);
      // Exactly one POST went out, with the restore point.
      expect(h.calls, label).toHaveLength(1);
      expect(h.calls[0]?.url).toBe(URL);
      expect(h.calls[0]?.init.method).toBe('POST');
      expect(JSON.parse(h.calls[0]?.init.body as string)).toEqual({ atMs: AT_MS });
      const err = h.err.join('\n');
      expect(err, label).toContain('answered 202');
      expect(err, label).toContain('the restore may have been accepted');
      expect(err, label).toContain('GET /internal/admin/status');
      expect(err, label).not.toContain(TOKEN);
      expect(h.out.join('\n'), label).not.toContain('scheduled');
      expect(h.out.join('\n'), label).not.toContain('nothing sent');
    }

    // A failure while reporting a well-formed 202 (stdout gone) is also 1:
    // the generic error path knows the request was sent.
    const reporting = harness(
      () => new Response(JSON.stringify({ bookmark: 'bm-1', atMs: AT_MS, restart: true }), { status: 202 }),
      { failOut: (line) => line.startsWith('pitr-restore: scheduled') },
    );
    expect(await run(reporting)).toBe(1);
    expect(reporting.calls).toHaveLength(1);
    expect(reporting.err.join('\n')).toContain('stdout closed (EPIPE)');
    expect(reporting.err.join('\n')).toContain('the request was sent and the restore may have been accepted');

    // A transport failure after the request started stays 1.
    const network = harness(() => Promise.reject(new TypeError('fetch failed')));
    expect(await run(network)).toBe(1);
    expect(network.calls).toHaveLength(1);
    expect(network.err.join('\n')).toContain('request failed: fetch failed');

    // Controls: a well-formed 202 is 0, and an error before the POST is still
    // 2 with no request (here stdout failing while printing the target).
    const ok = harness(
      () => new Response(JSON.stringify({ bookmark: 'bm-2', atMs: AT_MS, restart: true }), { status: 202 }),
    );
    expect(await run(ok)).toBe(0);
    expect(ok.calls).toHaveLength(1);
    expect(ok.out.join('\n')).toContain('pitr-restore: scheduled: bookmark bm-2');
    const before = harness(() => new Response(null, { status: 500 }), {
      failOut: (line) => line.startsWith('pitr-restore: target'),
    });
    expect(await run(before)).toBe(2);
    expect(before.calls).toHaveLength(0);
    expect(before.err.join('\n')).not.toContain('may have been accepted');
  });
});
