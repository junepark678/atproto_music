import type { Session, SessionChangeKind, SessionClient } from './client';

/** Subscribe before the initial read so the client remains the single state publisher. */
export async function bootstrapSession(
  client: SessionClient,
  publish: (session: Session | null, reauthRequired: boolean, kind: SessionChangeKind) => void,
): Promise<Session | null> {
  client.subscribe(publish);
  return client.getSession();
}
