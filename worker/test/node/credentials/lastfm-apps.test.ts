// Issued Last.fm applications (ADR 0005 §7.3, §7.4; N2-09).
//
// A migrated temporary node:sqlite database, the frozen clock, a seeded
// Random, the in-memory revocation journal (N1-08) and a box (N1-08) over a
// fixed test key. The signature below is computed by hand with the §7.4
// algorithm (sorted name+value pairs, then the secret, MD5 hex) using
// node:crypto, independently of the module under test.

import { createHash } from 'node:crypto';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { LastfmAppRow } from '../../../src/app/rows';
import { CredentialError, ensureAccount } from '../../../src/credentials/accounts';
import {
  createLastfmApp,
  deleteLastfmApp,
  isIssuedApiKey,
  issuedAppName,
  issuedAppSecret,
  listLastfmApps,
} from '../../../src/credentials/lastfm-apps';
import { BoxError, createBox, sealedKeyId } from '../../../src/crypto/box';
import { withMigratedDb } from '../support/node-db';

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob00000000000000000000';
const HEX32 = /^[0-9a-f]{32}$/;

function sign(params: Record<string, string>, secret: string): string {
  const names = Object.keys(params).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const text = names.map((n) => `${n}${params[n]}`).join('') + secret;
  return createHash('md5').update(text, 'utf8').digest('hex');
}

describe('issued Last.fm apps (ADR §7.3)', () => {
  it("an issued api_key's secret is stored sealed, is recoverable for signature checks, and is gone after delete", async () => {
    await withMigratedDb((db) => {
      const clock = fixedClock();
      const random = seededRandom(5);
      const memory = new MemoryRevocations(clock);
      const box = createBox([{ id: 'k1', key: new Uint8Array(32).fill(1) }], random);
      const deps = { db, clock, random, revocations: memory, box };
      ensureAccount(deps, { did: ALICE, verifiedHandle: 'alice.bsky.social' });
      ensureAccount(deps, { did: BOB, verifiedHandle: 'bob.example.com' });

      const app = createLastfmApp(deps, { did: ALICE, name: ' My scrobbler ' });
      expect(app.apiKey).toMatch(HEX32);
      expect(app.sharedSecret).toMatch(HEX32);
      expect(app).toMatchObject({ name: 'My scrobbler', createdAtMs: clock.nowMs() });

      // Stored sealed: the row holds neither the secret's text nor its bytes, and names the sealing key.
      const row = db.one<LastfmAppRow>('SELECT * FROM lastfm_apps WHERE api_key = ?', app.apiKey);
      expect(row).toMatchObject({ did: ALICE, name: 'My scrobbler', key_id: 'k1', created_at_ms: clock.nowMs() });
      const sealed = new Uint8Array(row!.secret_ciphertext);
      expect(sealedKeyId(sealed)).toBe('k1');
      expect(Buffer.from(sealed).includes(Buffer.from(app.sharedSecret, 'utf8'))).toBe(false);
      expect(Buffer.from(sealed).toString('hex')).not.toContain(app.sharedSecret);
      expect(Object.values(row!).some((v) => v === app.sharedSecret)).toBe(false);
      expect(JSON.stringify(listLastfmApps(db, ALICE))).not.toContain(app.sharedSecret);
      expect(listLastfmApps(db, ALICE)).toEqual([
        { apiKey: app.apiKey, name: 'My scrobbler', createdAtMs: clock.nowMs() },
      ]);

      // Recoverable for signature checks: the client's api_sig verifies with the recovered secret.
      expect(isIssuedApiKey(db, app.apiKey)).toBe(true);
      expect(issuedAppName(db, app.apiKey)).toBe('My scrobbler');
      const recovered = issuedAppSecret({ db, box }, app.apiKey);
      expect(recovered).toEqual({ apiKey: app.apiKey, did: ALICE, name: 'My scrobbler', secret: app.sharedSecret });
      const params = { method: 'auth.getToken', api_key: app.apiKey };
      expect(sign(params, recovered!.secret)).toBe(sign(params, app.sharedSecret));
      expect(sign(params, recovered!.secret)).not.toBe(sign(params, 'b'.repeat(32)));
      // Another box key cannot open it.
      const otherBox = createBox([{ id: 'k1', key: new Uint8Array(32).fill(2) }], random);
      expect(() => issuedAppSecret({ db, box: otherBox }, app.apiKey)).toThrow(BoxError);

      // A sealed value copied to another app row (another api_key and DID) does not open.
      const bobApp = createLastfmApp(deps, { did: BOB, name: 'bob app' });
      db.run('UPDATE lastfm_apps SET secret_ciphertext = ? WHERE api_key = ?', row!.secret_ciphertext, bobApp.apiKey);
      expect(() => issuedAppSecret({ db, box }, bobApp.apiKey)).toThrow(BoxError);

      // Names are required, and only signed-in DIDs may create apps.
      expect(() => createLastfmApp(deps, { did: ALICE, name: '   ' })).toThrow(CredentialError);
      expect(() => createLastfmApp(deps, { did: 'did:plc:stranger000000000000000', name: 'x' })).toThrow(
        CredentialError,
      );
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM lastfm_apps')?.n).toBe(2);

      // Gone after delete: no row, no secret, not issued, one journal entry with the api_key and no secret.
      expect(deleteLastfmApp(deps, BOB, app.apiKey)).toBe(false);
      expect(deleteLastfmApp(deps, ALICE, app.apiKey)).toBe(true);
      expect(db.one('SELECT 1 AS one FROM lastfm_apps WHERE api_key = ?', app.apiKey)).toBe(null);
      expect(issuedAppSecret({ db, box }, app.apiKey)).toBe(null);
      expect(isIssuedApiKey(db, app.apiKey)).toBe(false);
      expect(listLastfmApps(db, ALICE)).toEqual([]);
      expect(memory.entries()).toEqual([{ kind: 'lastfm_app', id: app.apiKey, did: ALICE, at: clock.nowMs() }]);
      expect(memory.text()).not.toContain(app.sharedSecret);
    });
  });
});
