import type { WebSession, WebSessions } from '../bff/sessions';
import type { Db } from '../do/db';

/** The admitted cookie session was revoked or replaced before its write. */
export class SessionEnded extends Error {
  override readonly name = 'SessionEnded';
  constructor() {
    super('the session ended before the credential was written');
  }
}

/** Run a synchronous credential write only while the request's original cookie still names its admitted session. */
export function writeInLiveSession<T>(
  db: Pick<Db, 'tx'>,
  sessions: Pick<WebSessions, 'lookupCookieHeader'>,
  req: Request,
  session: WebSession,
  write: () => T extends Promise<unknown> ? never : T,
): T {
  return db.tx(() => {
    const current = sessions.lookupCookieHeader(req.headers.get('cookie'));
    if (current === null || current.tokenHash !== session.tokenHash || current.did !== session.did) {
      throw new SessionEnded();
    }
    return write();
  });
}
