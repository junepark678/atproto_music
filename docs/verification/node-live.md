# Node live evidence (schema v3)

Node acceptance uses a distinct inventory and gate schema: `runtime: "node"`,
`schemaVersion: 3`, and `fixtureOnly: false`. Historical Workers schema v1/v2
and their fixtures are not Node evidence.

The release identity is the full 40-hex source commit plus the SHA-256 of the
production `worker/dist/node/main.mjs` bytes. It is not a Worker UUID, e2e
bundle, or archive checksum. `scripts/build-server.ts` writes these values to
`build-info.json` as `main.gitSha` and `main.sha256`; those facts alone do not
prove provenance or authenticity. Supply trusted expected values independently:

```sh
python3 scripts/verify_live_evidence.py --commit "$COMMIT" --bundle-sha256 "$SHA256"
python3 scripts/verify_live_evidence.py inventory.json --commit "$COMMIT" --artifact worker/dist/node/main.mjs
python3 scripts/verify_live_evidence.py --gate gate.json --commit "$COMMIT" --bundle-sha256 "$SHA256"
```

The verifier never derives expected identity from evidence. A mismatch in
either value, missing/malformed/zero identity, fixture evidence, historical
runtime, or missing independent binding is BLOCKED (exit 2). Complete valid
bound evidence is PASS (0); a valid bound genuine failed gate is FAIL (1).
Unknown gates cannot enable PASS. Node SSRF probe and soak semantics are not
ported; those gates remain BLOCKED and Workers Cloudflare/DO analytics cannot
stand in for Node acceptance.

Future operator drivers must check all required `ATMUSIC_LIVE_*` prerequisites
before any network activity. Missing inputs must fail closed before network.
This bounded verifier is wholly offline; it does not establish deployment,
authenticity, or current live acceptance. No Node live acceptance currently
exists. Node gate porting, OAuth driver, SSRF probe, and soak implementations
remain deferred, so full N6-02 remains open.
