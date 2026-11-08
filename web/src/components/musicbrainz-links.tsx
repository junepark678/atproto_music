import type { ComponentChildren } from 'preact';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMbid(value: string | undefined): value is string {
  return value !== undefined && MBID.test(value);
}

export function unambiguousMbid(values: readonly string[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  const valid = [...new Set(values.filter(isMbid).map((value) => value.toLowerCase()))];
  return valid.length === 1 ? valid[0] : undefined;
}

export function MusicBrainzLink({
  kind,
  mbid,
  children,
}: {
  kind: 'recording' | 'artist' | 'release';
  mbid: string | undefined;
  children: ComponentChildren;
}) {
  if (!isMbid(mbid)) return <>{children}</>;
  return (
    <a class="musicbrainz-link" href={`https://musicbrainz.org/${kind}/${mbid}`} rel="noopener noreferrer">
      {children}
      <span class="external-link" aria-hidden="true">
        {' '}
        ↗
      </span>
    </a>
  );
}
