//! Authenticate one exact current repository head; never infer historical key ranges.
//!
//! AT Repository specifies that the latest commit is verifiable with the current
//! DID document. A freshly discovered PDS witnesses both its revision and CID.
//! Signature, CAR hashes and MST membership remain mandatory in `verify_commit`.
use super::{
    frames::validate_revision,
    verify::{
        SigningKeyProof, SigningKeyResolver, TrustedHeadSigningKey, TrustedSigningKey,
        VerificationError,
    },
};
use crate::{
    http::safe_client::{FetchError, SafeClient},
    identity::{DidDocument, IdentityError, IdentityResolver, VerificationMethod},
};
use async_trait::async_trait;
use atrium_crypto::{
    Algorithm,
    did::{format_did_key, parse_multikey},
    multibase::{self, Base},
};
use ipld_core::cid::{Cid, Version};
use serde::Deserialize;
use url::Url;

pub struct CurrentHeadResolver {
    identity: IdentityResolver,
    client: SafeClient,
}
impl CurrentHeadResolver {
    pub fn new(client: SafeClient) -> Self {
        Self {
            identity: IdentityResolver::new(client.clone()),
            client,
        }
    }
    async fn identity(&self, did: &str) -> Result<HeadIdentity, VerificationError> {
        let document = self.identity.document(did).await.map_err(identity_error)?;
        Ok(HeadIdentity {
            pds: document.pds().map_err(identity_error)?,
            did_key: signing_key(&document)?,
        })
    }
}
#[derive(PartialEq, Eq)]
struct HeadIdentity {
    pds: Url,
    did_key: String,
}
#[derive(Deserialize)]
struct LatestCommit {
    cid: String,
    rev: String,
}

#[async_trait]
impl SigningKeyResolver for CurrentHeadResolver {
    async fn resolve_for_revision(
        &self,
        _did: &str,
        _revision: &str,
    ) -> Result<TrustedSigningKey, VerificationError> {
        // A revision without its root cannot be tied to the exact HTTPS witness.
        Err(VerificationError::UntrustedIdentity)
    }
    async fn resolve_for_commit(
        &self,
        did: &str,
        revision: &str,
        commit: Cid,
    ) -> Result<SigningKeyProof, VerificationError> {
        validate_revision(revision).map_err(|_| VerificationError::CommitMismatch)?;
        let before = self.identity(did).await?;
        let mut url = before
            .pds
            .join("xrpc/com.atproto.sync.getLatestCommit")
            .map_err(|_| VerificationError::UntrustedIdentity)?;
        url.query_pairs_mut().append_pair("did", did);
        // Exact 200 JSON, no redirects, public destination policy, bounded body
        // and ten-second deadline are provided by the same production SafeClient.
        let bytes = self.client.metadata(&url).await.map_err(fetch_error)?;
        let witness: LatestCommit =
            serde_json::from_slice(&bytes).map_err(|_| VerificationError::InvalidHeadWitness)?;
        validate_revision(&witness.rev).map_err(|_| VerificationError::InvalidHeadWitness)?;
        // The blessed AT CIDv1/DAG-CBOR/SHA-256 string is 59 base32 characters.
        // Bound encoded input before any multibase decoder can consume it.
        if witness.cid.len() != 59 || !witness.cid.starts_with('b') {
            return Err(VerificationError::InvalidHeadWitness);
        }
        let cid: Cid = witness
            .cid
            .parse()
            .map_err(|_| VerificationError::InvalidHeadWitness)?;
        if cid.version() != Version::V1
            || cid.codec() != 0x71
            || cid.hash().code() != 0x12
            || cid.hash().size() != 32
            || cid.to_string() != witness.cid
        {
            return Err(VerificationError::InvalidHeadWitness);
        }
        // Resolve afresh, rather than using the handle/identity cache. Rotation or
        // migration during the lookup must retry before a head mismatch is judged.
        let after = self.identity(did).await?;
        if before != after {
            return Err(VerificationError::IdentityChanged);
        }
        if witness.rev != revision {
            return Err(VerificationError::HeadChanged);
        }
        if cid != commit {
            return Err(VerificationError::HeadCidMismatch);
        }
        Ok(SigningKeyProof::CurrentHead(TrustedHeadSigningKey {
            did: did.into(),
            did_key: after.did_key,
            revision: revision.into(),
            commit,
        }))
    }
}
fn signing_key(document: &DidDocument) -> Result<String, VerificationError> {
    // AT DID specifies first-valid ordering; later keys are not signature fallbacks.
    document
        .verification_method
        .iter()
        .filter(|method| {
            method.controller == document.id
                && (method.id == "#atproto" || method.id == format!("{}#atproto", document.id))
        })
        .find_map(|method| parse_key(method).ok())
        .ok_or(VerificationError::UntrustedIdentity)
}
fn parse_key(method: &VerificationMethod) -> Result<String, VerificationError> {
    let encoded = method
        .public_key_multibase
        .as_deref()
        .ok_or(VerificationError::UntrustedIdentity)?;
    // Base58 decoding is not a constant-time operation in input length. Both
    // permitted compressed and legacy SEC1 encodings fit comfortably in this cap.
    if encoded.len() > 128 {
        return Err(VerificationError::UntrustedIdentity);
    }
    let (base, bytes) =
        multibase::decode(encoded).map_err(|_| VerificationError::UntrustedIdentity)?;
    if base != Base::Base58Btc {
        return Err(VerificationError::UntrustedIdentity);
    }
    let (algorithm, key) = match method.kind.as_str() {
        "Multikey" => {
            // The pinned library slices decoded[..2]. Guard its input before
            // invoking it, and require the canonical compressed multikey format.
            if bytes.len() != 35 || !matches!(bytes[2], 2 | 3) {
                return Err(VerificationError::UntrustedIdentity);
            }
            parse_multikey(encoded).map_err(|_| VerificationError::UntrustedIdentity)?
        }
        "EcdsaSecp256r1VerificationKey2019"
            if method.id == "#atproto" && bytes.len() == 65 && bytes[0] == 4 =>
        {
            (Algorithm::P256, bytes)
        }
        "EcdsaSecp256k1VerificationKey2019"
            if method.id == "#atproto" && bytes.len() == 65 && bytes[0] == 4 =>
        {
            (Algorithm::Secp256k1, bytes)
        }
        _ => return Err(VerificationError::UntrustedIdentity),
    };
    let did_key =
        format_did_key(algorithm, &key).map_err(|_| VerificationError::UntrustedIdentity)?;
    if method.kind == "Multikey" && did_key.strip_prefix("did:key:") != Some(encoded) {
        return Err(VerificationError::UntrustedIdentity);
    }
    Ok(did_key)
}
fn identity_error(error: IdentityError) -> VerificationError {
    match error {
        IdentityError::Fetch(error) => fetch_error(error),
        _ => VerificationError::UntrustedIdentity,
    }
}
fn fetch_error(error: FetchError) -> VerificationError {
    match error {
        FetchError::Dns
        | FetchError::Transport
        | FetchError::Timeout
        | FetchError::HttpStatus(429 | 500..=599) => VerificationError::HeadUnavailable,
        _ => VerificationError::UntrustedIdentity,
    }
}
