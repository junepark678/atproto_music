// The single outbound I/O boundary (ADR 0004 §4.4). Frozen in Wave 0.
//
// Production passes the global `fetch`; tests inject a fixture router
// (packages/atproto/test-support/router-transport.ts). Policy (URL checks, DoH
// pre-check, redirects, timeouts, body caps) lives in net/safe-fetch.ts, on
// top of a Transport, so it is exercised identically in both.

export type Transport = (req: Request) => Promise<Response>;

/** The production transport: Workers/browser `fetch`, nothing else. */
export const fetchTransport: Transport = (req) => fetch(req);
