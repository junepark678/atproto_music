// The OAuth client's display name (ADR 0005 §5.3; N2-03).
//
// It is the `client_name` of the confidential client's metadata document
// (worker/src/bff/client-metadata.ts), which every authorization server shows
// on its consent screen. It moved here from scripts/gen-config.ts:42 so the
// server and the build tooling share one value; N5-01 switches gen-config to
// import it.

export const CLIENT_NAME = 'AT Protocol Music';
