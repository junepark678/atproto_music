import { expect, it } from 'vitest';
import type { Db } from '../../../src/do/db';
import { authorizePendingRemovals } from '../../../src/do/ingest/live-pending-removals';
import { withMigratedDb } from '../support/node-db';

it('independent: small event pages update each matching pending member in one group statement', async () => {
  await withMigratedDb((db) => {
    const uri = 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobbleBatch/a';
    for (let i = 0; i < 8; i++)
      db.run(
        `INSERT INTO live_pending_removals
   (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,created_at_ms,expires_at_ms)
   VALUES(?,?,'old','scrobble','1111111111111','3333333333333','','key','a','t','A','T',1,9999999999999)`,
        uri,
        `${uri}#${i}`,
      );
    let updates = 0,
      calls = 0;
    const traced: Db = {
      all: db.all.bind(db),
      one: db.one.bind(db),
      tx: db.tx.bind(db),
      run(sql, ...params) {
        const result = db.run(sql, ...params);
        if (sql.includes('UPDATE live_pending_removals SET authorized_rev=')) {
          updates += result.rowsWritten;
          calls++;
        }
        return result;
      },
    };
    authorizePendingRemovals(traced, { uri, rev: '3333333333333', action: 'delete' }, 2);
    expect({ calls, updates }).toEqual({ calls: 1, updates: 8 });
  });
});
