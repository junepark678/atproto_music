//! Stable music grouping keys: Unicode 16 NFKC, full default case folding,
//! then trim and collapse Unicode White_Space. Display text is kept separately.
//!
//! Pinning both Unicode data versions prevents different writers from changing
//! existing groups merely because their platform uses another Unicode version.

use caseless::Caseless;
use chrono::{DateTime, Utc};
use unicode_normalization::UnicodeNormalization;

use crate::scrobble::{ValidationError, validate_display_string};

pub const GROUPING_UNICODE_VERSION: (u8, u8, u8) = (16, 0, 0);

/// The credited artist display string is one identity in schema v1.
/// This deliberately does not split multi-artist credits or consult MBIDs.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArtistKey(String);

impl ArtistKey {
    pub fn new(artist: &str) -> Result<Self, ValidationError> {
        validate_display_string("artist", artist)?;
        Ok(Self(normalize(artist)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Ordered as the typed (normalized artist, normalized track) tuple.
/// Separators inside display strings never merge distinct track groups.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrackKey {
    artist: ArtistKey,
    track: String,
}

impl TrackKey {
    pub fn new(artist: &str, track: &str) -> Result<Self, ValidationError> {
        validate_display_string("track", track)?;
        Ok(Self {
            artist: ArtistKey::new(artist)?,
            track: normalize(track),
        })
    }

    pub fn artist(&self) -> &ArtistKey {
        &self.artist
    }

    pub fn track(&self) -> &str {
        &self.track
    }
}

/// Ordered as the typed (normalized artist, normalized album) tuple.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AlbumKey {
    artist: ArtistKey,
    album: String,
}

impl AlbumKey {
    /// An omitted album has no ranking key; an empty supplied album is invalid.
    pub fn optional(artist: &str, album: Option<&str>) -> Result<Option<Self>, ValidationError> {
        let artist = ArtistKey::new(artist)?;
        album
            .map(|album| {
                validate_display_string("album", album)?;
                Ok(Self {
                    artist,
                    album: normalize(album),
                })
            })
            .transpose()
    }

    pub fn artist(&self) -> &ArtistKey {
        &self.artist
    }

    pub fn album(&self) -> &str {
        &self.album
    }
}

/// NFKC followed by full (non-Turkic) default Unicode case folding.
/// Case folding can expand characters, so lowercase conversion is insufficient.
/// Schema validation belongs at the input boundary; this normalization helper
/// itself has no length threshold after compatibility/folding expansion.
pub fn normalize(value: &str) -> String {
    let folded: String = value.nfkc().default_case_fold().collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A confirmed record's original display text with its ordering evidence.
/// Callers pass candidates belonging to the same normalized group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayCandidate<'a> {
    pub listened_at: DateTime<Utc>,
    pub uri: &'a str,
    pub artist: &'a str,
    pub track: &'a str,
    pub album: Option<&'a str>,
}

/// Choose the newest listen, then the lexicographically greatest full AT URI
/// on an equal timestamp, matching the public descending listen ordering.
/// No normalization is applied to the returned display spelling.
pub fn newest_display<'a>(
    candidates: impl IntoIterator<Item = DisplayCandidate<'a>>,
) -> Option<DisplayCandidate<'a>> {
    candidates
        .into_iter()
        .max_by(|a, b| (a.listened_at, a.uri).cmp(&(b.listened_at, b.uri)))
}
