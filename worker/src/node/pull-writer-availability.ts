import { ReauthRequiredError } from '../outbox/pds-writer';
import type { PullWriterAvailability } from '../sync/pull-writer';

const REAUTH_ERROR_NAMES = new Set([
  'TokenRefreshError',
  'TokenRevokedError',
  'TokenInvalidError',
  'ReauthRequiredError',
]);

/** Resolve pull-write readiness from the stored OAuth session itself. */
export async function pullWriterAvailability(args: {
  did: string;
  publicationEnabled: boolean;
  batchPublicationEnabled?: boolean;
  signInAllowed: boolean;
  prefix: string | null;
  sessionStore: { has(did: string): boolean };
  restore(did: string): Promise<{ getTokenInfo(): Promise<{ scope: string }> }>;
}): Promise<PullWriterAvailability> {
  if (!args.publicationEnabled || !args.signInAllowed) return { available: false, reason: 'publication_disabled' };
  if (!args.sessionStore.has(args.did)) return { available: false, reason: 'session_missing' };
  try {
    const { scope } = await (await args.restore(args.did)).getTokenInfo();
    const scopes = new Set(scope.split(/\s+/).filter(Boolean));
    if (
      !scopes.has('transition:generic') &&
      (args.prefix === null ||
        !scopes.has(`repo:${args.prefix}.scrobble`) ||
        !scopes.has(`repo:${args.prefix}.love`) ||
        (args.batchPublicationEnabled === true && !scopes.has(`repo:${args.prefix}.scrobbleBatch`)))
    )
      return { available: false, reason: 'scope_insufficient' };
    return { available: true };
  } catch (error) {
    if (error instanceof ReauthRequiredError || (error instanceof Error && REAUTH_ERROR_NAMES.has(error.name)))
      return { available: false, reason: 'reauth_required' };
    return { available: false, reason: 'session_restore_transient' };
  }
}
