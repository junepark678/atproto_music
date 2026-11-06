// The application's feature services (ADR 0005 §3.1; N1-02).
//
// Empty on purpose. Each feature package adds its service by TypeScript
// declaration merging from its own module, so no feature ever edits this file:
//
//   declare module '../app/services' {
//     interface AppServices {
//       lastfm: LastfmService;
//     }
//   }
//
// The Node composition (node/compose.ts, N2-01) builds the object and hands it
// to handlers as `RequestCtx.app`.

// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging (ADR 0005 §3.1)
export interface AppServices {}
