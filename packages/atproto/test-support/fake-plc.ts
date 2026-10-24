// A fake PLC directory (https://plc.directory/<did>) plus did:web documents
// (https://<host>/.well-known/did.json). TEST-ONLY.
//
// Each DID has a current document and a history of versions, so key rotation,
// PDS migration and handle changes are observable. Faults go through the same
// FaultQueue as the other fakes; every call is logged.

import type { TestKey } from './keys';
import {
  CallLog,
  type Fault,
  type FaultMatch,
  FaultQueue,
  faultName,
  faultResponse,
  paramsOf,
  xrpcJson,
} from './router-transport';

export const PLC_HOST = 'plc.directory';

export interface DidDocument {
  '@context': string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: Array<{ id: string; type: string; controller: string; publicKeyMultibase: string }>;
  service: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export interface DidEntry {
  /** `publicKeyMultibase` of the `#atproto` Multikey. */
  signingKey: string;
  /** PDS origin, e.g. `https://pds1.example.test`. */
  pds: string;
  handle: string | null;
  /** 410 Gone when tombstoned. */
  tombstoned: boolean;
}

export interface RegisterOptions {
  signingKey: TestKey | string;
  pds: string;
  handle?: string | null;
}

function multikeyOf(k: TestKey | string): string {
  if (typeof k !== 'string') return k.multikey;
  return k.startsWith('did:key:') ? k.slice('did:key:'.length) : k;
}

export function didDocument(did: string, e: DidEntry): DidDocument {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/secp256k1-2019/v1',
    ],
    id: did,
    alsoKnownAs: e.handle ? [`at://${e.handle}`] : [],
    verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: e.signingKey }],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: e.pds }],
  };
}

export class FakePlc {
  readonly host = PLC_HOST;
  readonly calls = new CallLog();
  readonly faults = new FaultQueue();
  private readonly entries = new Map<string, DidEntry>();
  private readonly versions = new Map<string, DidEntry[]>();
  /** Raw documents overriding the generated one (malformed-document tests). */
  private readonly raw = new Map<string, unknown>();

  register(did: string, o: RegisterOptions): DidEntry {
    if (!did.startsWith('did:plc:') && !did.startsWith('did:web:')) throw new Error(`unsupported DID ${did}`);
    const entry: DidEntry = {
      signingKey: multikeyOf(o.signingKey),
      pds: o.pds,
      handle: o.handle ?? null,
      tombstoned: false,
    };
    this.entries.set(did, entry);
    this.versions.set(did, [{ ...entry }]);
    return entry;
  }

  private update(did: string, patch: Partial<DidEntry>): DidEntry {
    const cur = this.entries.get(did);
    if (!cur) throw new Error(`${did} is not registered`);
    const next = { ...cur, ...patch };
    this.entries.set(did, next);
    this.versions.get(did)!.push({ ...next });
    return next;
  }

  /** Rotate the `#atproto` signing key. */
  rotateKey(did: string, key: TestKey | string): DidEntry {
    return this.update(did, { signingKey: multikeyOf(key) });
  }
  /** Point `#atproto_pds` elsewhere (PDS migration). */
  setPds(did: string, pds: string): DidEntry {
    return this.update(did, { pds });
  }
  setHandle(did: string, handle: string | null): DidEntry {
    return this.update(did, { handle });
  }
  tombstone(did: string): DidEntry {
    return this.update(did, { tombstoned: true });
  }
  /** Serve `doc` verbatim for `did` (e.g. a document whose id mismatches). */
  setRawDocument(did: string, doc: unknown): void {
    this.raw.set(did, doc);
  }

  entry(did: string): DidEntry | null {
    return this.entries.get(did) ?? null;
  }
  /** Every version of the DID's document state, oldest first. */
  history(did: string): readonly DidEntry[] {
    return this.versions.get(did) ?? [];
  }
  document(did: string): DidDocument {
    const e = this.entries.get(did);
    if (!e) throw new Error(`${did} is not registered`);
    return didDocument(did, e);
  }

  fail(match: FaultMatch, fault: Fault, times = 1): Fault {
    return this.faults.add(match, fault, times);
  }

  servesWebHost(host: string): boolean {
    return this.entries.has(`did:web:${host}`) || this.raw.has(`did:web:${host}`);
  }

  count(did?: string): number {
    return this.calls.count({ did });
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let did: string | null;
    if (url.hostname === PLC_HOST) {
      did = /^\/did:plc:[a-z2-7]{24}$/.test(url.pathname) ? decodeURIComponent(url.pathname.slice(1)) : null;
    } else {
      did = url.pathname === '/.well-known/did.json' ? `did:web:${url.hostname}` : null;
    }
    const log = (status: number, fault: Fault | null) =>
      this.calls.record({
        service: 'plc',
        host: url.hostname,
        method: req.method,
        path: url.pathname,
        nsid: null,
        params: paramsOf(url),
        did,
        status,
        fault: fault ? faultName(fault) : null,
      });
    const fault = this.faults.take({ nsid: null, did, path: url.pathname });
    if (fault) {
      if (fault.kind === 'hang') log(0, fault); // the call arrived; it just never answers
      const res = await faultResponse(fault, req);
      log(res.status, fault);
      return res;
    }
    let res: Response;
    if (req.method !== 'GET' || did === null) {
      res = xrpcJson({ message: 'Not Found' }, 404);
    } else if (this.raw.has(did)) {
      res = xrpcJson(this.raw.get(did));
    } else {
      const e = this.entries.get(did);
      if (!e) res = xrpcJson({ message: `DID not registered: ${did}` }, 404);
      else if (e.tombstoned) res = xrpcJson({ message: `DID not available: ${did}` }, 410);
      else
        res = new Response(JSON.stringify(didDocument(did, e)), {
          status: 200,
          headers: { 'content-type': 'application/did+ld+json' },
        });
    }
    log(res.status, null);
    return res;
  };
}

export function fakePlc(): FakePlc {
  return new FakePlc();
}
