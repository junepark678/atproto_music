//! Lexicon namespace configuration and the publication prerequisite.

use std::{error::Error, fmt};

pub const FIXTURE_PREFIX: &str = "com.example.atmusic";
pub const SCHEMA_VERSION: u32 = 1;
pub const PREFIX_FIELD: &str = "ATMUSIC_LEXICON_PREFIX";

/// Public, auditable ownership evidence supplied by the domain's owner.
/// A handle or a syntactically valid namespace is not ownership evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnershipEvidence {
    pub domain: String,
    pub reference: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Namespace {
    prefix: String,
    ownership: Option<OwnershipEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamespaceError {
    pub code: &'static str,
    pub field: &'static str,
    pub message: &'static str,
}

impl fmt::Display for NamespaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} ({})", self.field, self.message, self.code)
    }
}

impl Error for NamespaceError {}

impl Namespace {
    /// Validate configuration without inferring domain ownership.
    pub fn new(prefix: impl Into<String>) -> Result<Self, NamespaceError> {
        let prefix = prefix.into();
        let labels: Vec<_> = prefix.split('.').collect();
        if labels.len() < 2
            || prefix.len() > 253
            || !labels
                .first()
                .is_some_and(|label| label.as_bytes().first().is_some_and(u8::is_ascii_lowercase))
            || labels.iter().any(|label| !valid_label(label))
        {
            return Err(NamespaceError {
                code: "invalid_namespace",
                field: PREFIX_FIELD,
                message: "expected a lowercase reverse-domain namespace prefix",
            });
        }
        Ok(Self {
            prefix,
            ownership: None,
        })
    }

    /// Enable publication only after an owner explicitly supplies evidence.
    /// The operator must record and review the reference in the namespace ADR.
    pub fn with_ownership(
        prefix: impl Into<String>,
        evidence: OwnershipEvidence,
    ) -> Result<Self, NamespaceError> {
        let mut namespace = Self::new(prefix)?;
        let domain_labels: Vec<_> = evidence.domain.split('.').collect();
        let reversed = domain_labels
            .iter()
            .rev()
            .copied()
            .collect::<Vec<_>>()
            .join(".");
        if Self::new(reversed.clone()).is_err()
            || evidence.reference.trim().is_empty()
            || !(namespace.prefix == reversed || namespace.prefix.starts_with(&(reversed + ".")))
        {
            return Err(NamespaceError {
                code: "invalid_namespace_ownership",
                field: PREFIX_FIELD,
                message: "ownership evidence must identify the controlling domain and a reviewable reference",
            });
        }
        namespace.ownership = Some(evidence);
        namespace.require_publication()?;
        Ok(namespace)
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    pub const fn schema_version(&self) -> u32 {
        SCHEMA_VERSION
    }

    pub fn scrobble_collection(&self) -> String {
        format!("{}.scrobble", self.prefix)
    }

    pub fn follow_collection(&self) -> String {
        format!("{}.follow", self.prefix)
    }

    /// Call before enqueuing or issuing any remote publication request.
    pub fn require_publication(&self) -> Result<(), NamespaceError> {
        if self.prefix == FIXTURE_PREFIX || self.ownership.is_none() {
            return Err(NamespaceError {
                code: "namespace_not_production",
                field: PREFIX_FIELD,
                message: "publication requires a non-fixture namespace with recorded owner evidence",
            });
        }
        Ok(())
    }
}

fn valid_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes[0].is_ascii_alphanumeric()
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}
