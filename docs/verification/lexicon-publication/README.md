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
