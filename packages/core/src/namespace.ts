// Lexicon namespace configuration and the publication prerequisite. Ports
// crates/core/src/namespace.rs (Namespace::new, with_ownership,
// require_publication) with the A10 settings collection (ADR 0004 §9.2).
//
// - Syntax validation never establishes ownership. Publication needs a
//   non-fixture prefix plus owner-supplied ownership evidence whose domain is
//   the prefix's reverse-domain authority (or a parent of it).
// - `com.example.atmusic` is fixture-only: it never enables publication, with
//   or without evidence.
// - Production uses dev.pythonplayer123.music with authority domain
//   music.pythonplayer123.dev (ADR 0004 §15 Q3); that is deploy-time config,
//   never a default here.

export const FIXTURE_PREFIX = 'com.example.atmusic';
export const SCHEMA_VERSION = 1;
/** The configuration field the errors name (worker/src/env.ts). */
export const PREFIX_FIELD = 'LEXICON_PREFIX';

export type NamespaceErrorCode = 'invalid_namespace' | 'invalid_namespace_ownership' | 'namespace_not_production';

export interface NamespaceError {
  code: NamespaceErrorCode;
  field: typeof PREFIX_FIELD;
  message: string;
}

/** Public, auditable ownership evidence supplied by the domain's owner. */
export interface OwnershipEvidence {
  /** The controlling domain, e.g. music.pythonplayer123.dev. */
  domain: string;
  /** A reviewable reference, e.g. the `_lexicon` TXT record and the review note. */
  reference: string;
}

export interface Collections {
  scrobble: string;
  follow: string;
  settings: string;
}

export type PublicationResult =
  | { ok: true; prefix: string; collections: Collections; evidence: OwnershipEvidence }
  | { ok: false; error: NamespaceError };

const INVALID_NAMESPACE: NamespaceError = {
  code: 'invalid_namespace',
  field: PREFIX_FIELD,
  message: 'expected a lowercase reverse-domain namespace prefix',
};
const INVALID_OWNERSHIP: NamespaceError = {
  code: 'invalid_namespace_ownership',
  field: PREFIX_FIELD,
  message: 'ownership evidence must identify the controlling domain and a reviewable reference',
};
const NOT_PRODUCTION: NamespaceError = {
  code: 'namespace_not_production',
  field: PREFIX_FIELD,
  message: 'publication requires a non-fixture namespace with recorded owner evidence',
};

function validLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/** Namespace::new: ≥ 2 lowercase labels, ≤ 253 chars, first label starts with a letter. */
export function isValidPrefix(prefix: string): boolean {
  if (typeof prefix !== 'string' || prefix.length > 253) return false;
  const labels = prefix.split('.');
  return labels.length >= 2 && /^[a-z]/.test(labels[0] ?? '') && labels.every(validLabel);
}

export function isFixturePrefix(prefix: string): boolean {
  return prefix === FIXTURE_PREFIX;
}

/** Exactly the three schema-v1 collections a valid prefix derives (A10). */
export function collectionsFor(prefix: string): Collections {
  if (!isValidPrefix(prefix)) throw new RangeError(`${INVALID_NAMESPACE.message}: ${JSON.stringify(prefix)}`);
  return { scrobble: `${prefix}.scrobble`, follow: `${prefix}.follow`, settings: `${prefix}.settings` };
}

/** The NSID authority domain of a prefix: its labels reversed. */
export function authorityDomain(prefix: string): string {
  return prefix.split('.').reverse().join('.');
}

// Unicode White_Space (Rust `str::trim`), for the "reviewable reference" check.
const WHITE_SPACE_EDGES =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/**
 * Namespace::require_publication, called before any remote publication is
 * queued or sent. `ownership` is the owner's evidence, or the bare
 * NAMESPACE_OWNERSHIP_REF string, whose domain is then the prefix's own
 * authority domain. Null, empty or mismatched evidence never publishes.
 */
export function requirePublication(
  prefix: string | null,
  ownership: OwnershipEvidence | string | null | undefined,
): PublicationResult {
  if (prefix === null || !isValidPrefix(prefix)) return { ok: false, error: INVALID_NAMESPACE };
  if (ownership === null || ownership === undefined || isFixturePrefix(prefix)) {
    return { ok: false, error: NOT_PRODUCTION };
  }
  const evidence: OwnershipEvidence =
    typeof ownership === 'string' ? { domain: authorityDomain(prefix), reference: ownership } : ownership;
  if (typeof evidence.domain !== 'string' || typeof evidence.reference !== 'string') {
    return { ok: false, error: INVALID_OWNERSHIP };
  }
  const reversed = authorityDomain(evidence.domain);
  if (
    !isValidPrefix(reversed) ||
    evidence.reference.replace(WHITE_SPACE_EDGES, '') === '' ||
    !(prefix === reversed || prefix.startsWith(`${reversed}.`))
  ) {
    // An empty reference string is no evidence at all.
    if (typeof ownership === 'string' && ownership.replace(WHITE_SPACE_EDGES, '') === '') {
      return { ok: false, error: NOT_PRODUCTION };
    }
    return { ok: false, error: INVALID_OWNERSHIP };
  }
  return { ok: true, prefix, collections: collectionsFor(prefix), evidence };
}
