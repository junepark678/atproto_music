import { describe, expect, it } from 'vitest';
import {
  closeOpenLinkGap,
  GAP_ADMISSION_OWNER_SQL,
  NEWEST_LINK_GAP_SQL,
  openLinkGap,
  ownsAdmissionInGap,
} from '../../../src/forward/coverage';
import { withMigratedDb } from '../support/node-db';

const LINK = { id: 'gap-owner-test', generation: 1 };
const DID = 'did:plc:gapownergapownergapownergap';

async function withLink(run: Parameters<typeof withMigratedDb>[0]) {
  await withMigratedDb((db, context) => {
    db.run("INSERT INTO users(did,joined_at) VALUES(?,'2026-01-01T00:00:00Z')", DID);
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES(?,?,'lastfm','remote',X'00','fixture',1,1)`,
      LINK.id,
      DID,
    );
    run(db, context);
  });
}

describe('coverage gap nearest-predecessor ownership', () => {
  it('owns only through the nearest closed interval endpoint and never through an open interval', async () => {
    await withLink((db) => {
      for (let index = 0; index < 20; index++) {
        const from = index * 2;
        openLinkGap(db, LINK, 'disabled', index, from);
        expect(closeOpenLinkGap(db, LINK, from + 1, index + 1)).toBe(true);
      }
      const gaps = db.all<{ from_seq: number; to_seq: number | null }>(
        'SELECT from_seq,to_seq FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq',
        LINK.id,
      );
      expect(gaps).toHaveLength(20);
      expect(
        gaps.every((gap, index) => gap.to_seq !== null && (index === 0 || gaps[index - 1]!.to_seq! < gap.from_seq)),
      ).toBe(true);
      expect(ownsAdmissionInGap(db, LINK, 1)).toBe(true);
      expect(ownsAdmissionInGap(db, LINK, 2)).toBe(false);
      expect(ownsAdmissionInGap(db, LINK, 21)).toBe(true);
      expect(ownsAdmissionInGap(db, LINK, 39)).toBe(true);
      expect(ownsAdmissionInGap(db, LINK, 100)).toBe(false);

      openLinkGap(db, LINK, 'revoked', 30, 40);
      expect(db.one(NEWEST_LINK_GAP_SQL, LINK.id, LINK.generation)).toEqual({ from_seq: 40, to_seq: null });
      expect(ownsAdmissionInGap(db, LINK, 41)).toBe(false);
      expect(closeOpenLinkGap(db, LINK, 42, 31)).toBe(true);
      expect(db.one(NEWEST_LINK_GAP_SQL, LINK.id, LINK.generation)).toEqual({ from_seq: 40, to_seq: 42 });
      expect(ownsAdmissionInGap(db, LINK, 42)).toBe(true);
      expect(ownsAdmissionInGap(db, LINK, 43)).toBe(false);
    });
  });

  it('plans the exact production seek queries through the composite link-generation key', async () => {
    await withLink((db) => {
      const owner = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${GAP_ADMISSION_OWNER_SQL}`,
        LINK.id,
        LINK.generation,
        10,
      );
      const newest = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${NEWEST_LINK_GAP_SQL}`, LINK.id, LINK.generation);
      for (const details of [owner, newest].map((rows) => rows.map((row) => row.detail).join(' '))) {
        expect(details).toMatch(/SEARCH forward_link_gaps USING INDEX sqlite_autoindex_forward_link_gaps_1/i);
        expect(details).not.toMatch(/\bSCAN\b|TEMP B-TREE/i);
      }
    });
  });
});
