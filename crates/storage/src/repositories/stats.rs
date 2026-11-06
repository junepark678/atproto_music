//! Statistics computed from the current confirmed SQLite projection.
//! No divergent counters are persisted. One indexed per-user query provides
//! the inclusive window snapshot, then full Unicode typed keys define groups.

use std::collections::BTreeMap;

use atmusic_core::music_key::{AlbumKey, ArtistKey, DisplayCandidate, TrackKey, newest_display};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};

use super::{Repository, ScrobbleRow};
use crate::StorageError;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum StatisticsWindow {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "7d")]
    SevenDays,
    #[serde(rename = "30d")]
    ThirtyDays,
    #[serde(rename = "365d")]
    Year,
}

impl StatisticsWindow {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "7d" => Some(Self::SevenDays),
            "30d" => Some(Self::ThirtyDays),
            "365d" => Some(Self::Year),
            _ => None,
        }
    }

    pub fn days(self) -> Option<i64> {
        match self {
            Self::All => None,
            Self::SevenDays => Some(7),
            Self::ThirtyDays => Some(30),
            Self::Year => Some(365),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtistRank {
    pub artist: String,
    pub scrobble_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackRank {
    pub artist: String,
    pub track: String,
    pub scrobble_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlbumRank {
    pub artist: String,
    pub album: String,
    pub scrobble_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Statistics {
    pub did: String,
    pub window: StatisticsWindow,
    pub as_of: String,
    pub total_scrobbles: u64,
    pub distinct_artists: u64,
    pub distinct_tracks: u64,
    pub top_artists: Vec<ArtistRank>,
    pub top_tracks: Vec<TrackRank>,
    pub top_albums: Vec<AlbumRank>,
}

struct Group<'a> {
    count: u64,
    display: DisplayCandidate<'a>,
}

fn add<'a, K: Ord>(groups: &mut BTreeMap<K, Group<'a>>, key: K, display: DisplayCandidate<'a>) {
    groups
        .entry(key)
        .and_modify(|group| {
            group.count += 1;
            group.display =
                newest_display([group.display, display]).expect("two display candidates");
        })
        .or_insert(Group { count: 1, display });
}

fn ranking<'a, K: Ord>(groups: BTreeMap<K, Group<'a>>, limit: u32) -> Vec<Group<'a>> {
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by(|(a_key, a), (b_key, b)| b.count.cmp(&a.count).then_with(|| a_key.cmp(b_key)));
    groups
        .into_iter()
        .take(limit as usize)
        .map(|(_, group)| group)
        .collect()
}

impl Repository {
    /// Only active, confirmed, unsuppressed records without a pending or final
    /// tombstone contribute. Future accepted records stay excluded until asOf.
    pub async fn statistics(
        &self,
        did: &str,
        window: StatisticsWindow,
        as_of: DateTime<Utc>,
        limit: u32,
    ) -> Result<Statistics, StorageError> {
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invariant("invalid statistics limit"));
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT s.* FROM scrobbles s JOIN users u ON u.did=s.did WHERE s.did=",
        );
        query
            .push_bind(did)
            .push(" AND s.confirmed=1 AND u.active=1 AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.uri=s.uri) AND NOT EXISTS(SELECT 1 FROM suppression x WHERE x.did=s.did) AND s.listened_at<=")
            .push_bind(as_of.to_rfc3339_opts(SecondsFormat::Nanos, true));
        if let Some(days) = window.days() {
            let lower = as_of
                .checked_sub_signed(Duration::days(days))
                .ok_or(StorageError::Invariant("statistics window underflow"))?;
            query
                .push(" AND s.listened_at>=")
                .push_bind(lower.to_rfc3339_opts(SecondsFormat::Nanos, true));
        }
        query.push(" ORDER BY s.listened_at DESC,s.uri DESC");
        let rows: Vec<ScrobbleRow> = query.build_query_as().fetch_all(&self.readers).await?;
        let mut artists = BTreeMap::new();
        let mut tracks = BTreeMap::new();
        let mut albums = BTreeMap::new();
        for row in &rows {
            let listened_at = DateTime::parse_from_rfc3339(&row.listened_at)
                .map_err(|_| StorageError::Invariant("invalid stored listen timestamp"))?
                .with_timezone(&Utc);
            let display = DisplayCandidate {
                listened_at,
                uri: &row.uri,
                artist: &row.artist,
                track: &row.track,
                album: row.album.as_deref(),
            };
            let artist = ArtistKey::new(&row.artist)
                .map_err(|_| StorageError::Invariant("invalid stored artist"))?;
            let track = TrackKey::new(&row.artist, &row.track)
                .map_err(|_| StorageError::Invariant("invalid stored track"))?;
            let album = AlbumKey::optional(&row.artist, row.album.as_deref())
                .map_err(|_| StorageError::Invariant("invalid stored album"))?;
            add(&mut artists, artist, display);
            add(&mut tracks, track, display);
            if let Some(album) = album {
                add(&mut albums, album, display);
            }
        }
        let distinct_artists = artists.len() as u64;
        let distinct_tracks = tracks.len() as u64;
        Ok(Statistics {
            did: did.into(),
            window,
            as_of: as_of.to_rfc3339_opts(SecondsFormat::Nanos, true),
            total_scrobbles: rows.len() as u64,
            distinct_artists,
            distinct_tracks,
            top_artists: ranking(artists, limit)
                .into_iter()
                .map(|group| ArtistRank {
                    artist: group.display.artist.into(),
                    scrobble_count: group.count,
                })
                .collect(),
            top_tracks: ranking(tracks, limit)
                .into_iter()
                .map(|group| TrackRank {
                    artist: group.display.artist.into(),
                    track: group.display.track.into(),
                    scrobble_count: group.count,
                })
                .collect(),
            top_albums: ranking(albums, limit)
                .into_iter()
                .map(|group| AlbumRank {
                    artist: group.display.artist.into(),
                    album: group
                        .display
                        .album
                        .expect("album group has an album")
                        .into(),
                    scrobble_count: group.count,
                })
                .collect(),
        })
    }
}
