use atmusic_core::{
    music_key::{
        AlbumKey, ArtistKey, DisplayCandidate, GROUPING_UNICODE_VERSION, TrackKey, newest_display,
        normalize,
    },
    scrobble::ScrobbleInput,
};
use chrono::{DateTime, Utc};
use serde_json::json;

fn at(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

#[test]
fn unicode_grouping() {
    let artist = ArtistKey::new("Björk").unwrap();
    let spaced = ArtistKey::new("\u{2003}\u{a0}BJÖRK\u{3000}").unwrap();
    let decomposed = ArtistKey::new(" BJO\u{308}RK ").unwrap();
    assert_eq!(artist, spaced);
    assert_eq!(artist, decomposed);
    assert_eq!(artist.as_str(), "björk");
    let track = TrackKey::new("Björk", "Jóga").unwrap();
    assert_eq!(
        track,
        TrackKey::new("\u{2003}BJÖRK", " jo\u{301}ga\u{a0}").unwrap()
    );
    assert_eq!(track.artist().as_str(), "björk");
    assert_eq!(track.track(), "jóga");
    assert_eq!(normalize("Kate\u{2003}\u{a0}\tBush"), "kate bush");
    assert_eq!(
        normalize("\u{ff33}\u{ff34}\u{ff32}\u{ff21}\u{ff33}\u{ff33}\u{ff25}"),
        "strasse"
    );
    assert_eq!(
        normalize("Straße"),
        normalize("STRASSE"),
        "full fold expands ß"
    );
    assert_eq!(
        normalize("Σςσ"),
        "σσσ",
        "final sigma folds into the same identity"
    );
    assert_eq!(
        normalize("\u{ab70}"),
        "\u{13a0}",
        "Cherokee full fold differs from lowercase"
    );
    assert_eq!(
        normalize("\u{a7cb}"),
        "\u{0264}",
        "Unicode16 mapping is present"
    );
    assert_eq!(
        GROUPING_UNICODE_VERSION,
        unicode_normalization::UNICODE_VERSION
    );
    assert_eq!(caseless::UNICODE_VERSION, (16, 0, 0));

    let old = DisplayCandidate {
        listened_at: at("2026-01-14T11:00:00Z"),
        uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/r02",
        artist: "  BJÖRK  ",
        track: "jóga",
        album: Some(" HOMOGENIC "),
    };
    let new = DisplayCandidate {
        listened_at: at("2026-01-15T11:00:00Z"),
        uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/r01",
        artist: "Björk",
        track: "Jóga",
        album: Some("Homogenic"),
    };
    assert_eq!(newest_display([new, old]), Some(new));
    assert_eq!(newest_display([old, new]), Some(new));
    let tied = DisplayCandidate {
        uri: "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/r07",
        artist: "BJÖRK",
        ..new
    };
    assert_eq!(newest_display([tied, new]), Some(tied));
    assert_eq!(newest_display([new, tied]), Some(tied));
    assert_eq!(newest_display([]), None);
}

#[test]
fn tuple_collision() {
    let first = TrackKey::new("a|b", "c").unwrap();
    let second = TrackKey::new("a", "b|c").unwrap();
    assert_ne!(first, second);
    assert_eq!(first.artist().as_str(), "a|b");
    assert_eq!(first.track(), "c");
    assert_eq!(second.artist().as_str(), "a");
    assert_eq!(second.track(), "b|c");
    assert_ne!(
        AlbumKey::optional("a|b", Some("c")).unwrap(),
        AlbumKey::optional("a", Some("b|c")).unwrap()
    );
    assert!(
        second < first,
        "tuple ordering follows normalized artist first"
    );
    assert_ne!(
        ArtistKey::new("Artist A feat. Artist B").unwrap(),
        ArtistKey::new("Artist A").unwrap(),
        "credited artist is one string, never split into individual artists"
    );
}

#[test]
fn album_absence() {
    assert_eq!(AlbumKey::optional("Björk", None).unwrap(), None);
    let album = AlbumKey::optional("BJÖRK", Some(" HOMOGENIC "))
        .unwrap()
        .unwrap();
    assert_eq!(album.artist().as_str(), "björk");
    assert_eq!(album.album(), "homogenic");
    for value in ["", " ", "\u{2003}\u{a0}\t"] {
        assert_eq!(
            AlbumKey::optional("Björk", Some(value)).unwrap_err().field,
            "album"
        );
        let input = json!({"artist":"Björk", "track":"Jóga", "album":value, "listenedAt":"2026-01-15T11:00:00Z"});
        assert_eq!(
            ScrobbleInput::from_json(&input, at("2026-01-15T12:00:00Z"))
                .unwrap_err()
                .field,
            "album",
            "supplied whitespace album is rejected at the actual schema boundary"
        );
    }
    let input = json!({"artist":"Björk", "track":"Jóga", "listenedAt":"2026-01-15T11:00:00Z"});
    let valid = ScrobbleInput::from_json(&input, at("2026-01-15T12:00:00Z")).unwrap();
    assert_eq!(
        AlbumKey::optional(&valid.artist, valid.album.as_deref()).unwrap(),
        None
    );
}
