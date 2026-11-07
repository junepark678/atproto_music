# Production Lexicon publication (2026-11-05)

The authority DID `did:plc:gsichz64a5qpjvmjktkltkw2` has published the four production schemas.
Its namespace ownership is proven by TXT `_lexicon.music.pythonplayer123.dev`.
Each schema is a `com.atproto.lexicon.schema` record whose rkey is the full NSID, on PDS
`https://enoki.us-east.host.bsky.network`:

| NSID | CID |
| --- | --- |
| dev.pythonplayer123.music.scrobble | bafyreig3yl63x36qijlow6nu2r4my5kr27fuiel4laie7kjbb4vchu5rtm |
| dev.pythonplayer123.music.follow | bafyreihu2kycrodp2ouschmsghaezpc5htc6eluze3lgvri5tyftcsw6jm |
| dev.pythonplayer123.music.love | bafyreias4rmyqgv42i77pkna3zc3ovs5rjldsr3klw7nvewlngf645l6um |
| dev.pythonplayer123.music.settings | bafyreic2gfogdiziepma7f6n7rzj7gdhwdbyftokrykrbay4drlszwnslm |

## Method

- Each record is `lexicons/<name>.json` with only `id` changed, from `com.example.atmusic.<name>` to
  `dev.pythonplayer123.music.<name>`. Each file has exactly one placeholder occurrence. No other
  content changed.
- Records were written with `com.atproto.repo.putRecord` through a single-use app password session.
- Each record was read back with an unauthenticated `com.atproto.repo.getRecord` (HTTP 200).
- After canonical key ordering, each `value` (minus `$type`) equals the local document.
- [`manifest.json`](manifest.json) records the URIs, CIDs, content digests and retrieval URLs.

## Runtime gate

The owner approved enabling writes. `NAMESPACE_PUBLICATION_REF` in the local
`atmusic.env` is set to the sha256 of `manifest.json`:

    sha256:35040dd02f80a16b90e0332e1408c42795aeb958df168dda8ca762dae0be9fbb

After `atmusic.service` restarted, `GET /api/v1/meta` advertised the `publication` and `writes`
capabilities with `lexiconPrefix: dev.pythonplayer123.music`. As ADR 0001 notes, the runtime
validates only the shape of this reference.

## Unpublished batch candidate

`lexicons/scrobbleBatch.json` is a candidate fixture schema only. The checked-in
`manifest.json` above remains a receipt for exactly four published schemas and
must not be edited to imply that a batch schema is live. No batch record has
been published or retrieved by this repository.

Before enabling batch writes, the owner must publish the production-ID form of
the candidate and independently retrieve all **five** production schema
records without authentication. Compare each returned record's canonical
content with the approved schema, record the URI, CID, retrieval URL, digest,
and UTC verification time in a new copy of
[`batch-manifest.template.json`](batch-manifest.template.json), and review the
complete receipt. Store the reviewed copy as a versioned JSON artifact in this
directory; do not make the gate depend on a temporary `/tmp` file. The
publication receipt check requires exactly the existing four schema IDs plus
`<prefix>.scrobbleBatch`, a successful content match for each, and complete
public retrieval evidence. Run it against the reviewed artifact to validate
the five-record set and print its digest:

```sh
npx tsx scripts/check-batch-publication.ts docs/verification/lexicon-publication/batch-manifest-YYYYMMDD.json
```

Only after that evidence exists may the operator set
`NAMESPACE_BATCH_PUBLICATION_REF` to the SHA-256 of that reviewed five-record
manifest. It must differ from `NAMESPACE_PUBLICATION_REF`; the old four-record
digest alone keeps the batch capability and OAuth scope closed. The runtime
checks reference format and distinctness only and does not verify remote
publication itself. Existing sessions must re-consent to the added
`repo:<prefix>.scrobbleBatch` scope.

Deploy the additive database migrations with the batch reference unset, and
verify the schema version reported by that release. Do not assume a fixed
version because the migration may be stacked with later changes. After opening
the reference, check `/api/v1/meta` for `batchPublication`, then have accounts
with older grants re-consent before resuming held imports. Unsent legacy import
singles may be converted only by the guarded transactional rebatcher; sent
singles reconcile or complete using their original record. Before closing an
already-open batch gate, stop new batch imports and drain queued/running batch
creates and deletes first. The runner suspends every batch operation while the
gate is closed, including deletes, so those intents cannot drain until it is
reopened. Keep batch-aware reads, ingest and removal support deployed.

The candidate is intentionally absent from the production `manifest.json` and
from `lexicons/published/`. This work performs no network access and makes no
claim of publication or owner approval.
