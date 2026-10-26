use std::cell::Cell;

use atmusic_core::{
    follow::{FollowRecord, follow_rkey as make_follow_rkey},
    namespace::{FIXTURE_PREFIX, Namespace, OwnershipEvidence, PREFIX_FIELD},
    scrobble::{ScrobbleInput, ScrobbleRecord, validate_timestamp},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}

fn input() -> Value {
    json!({"artist":"Björk", "track":"Jóga", "listenedAt":"2026-01-15T11:00:00Z"})
}

fn record() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/scrobbles/valid.json")).unwrap()
}

fn follow(subject: &str, created_at: &str) -> Value {
    json!({"$type":"com.example.atmusic.follow", "subject":subject, "createdAt":created_at})
}

#[test]
fn fixture_namespace() {
    let requests = Cell::new(0);
    let publish = || -> Result<(), atmusic_core::namespace::NamespaceError> {
        namespace().require_publication()?;
        requests.set(requests.get() + 1);
        Ok(())
    };
    let error = publish().unwrap_err();
    assert_eq!(error.code, "namespace_not_production");
    assert_eq!(error.field, PREFIX_FIELD);
    assert_eq!(
        requests.get(),
        0,
        "publication gate must run before any remote request"
    );
}

#[test]
fn invalid_namespace() {
    for prefix in [
        "",
        "music",
        "com.Example.music",
        "com.example/music",
        "com..music",
        "com.-music",
        "com.music-",
    ] {
        let error = Namespace::new(prefix).unwrap_err();
        assert_eq!(error.code, "invalid_namespace", "prefix={prefix:?}");
        assert_eq!(error.field, PREFIX_FIELD, "prefix={prefix:?}");
    }
}

#[test]
fn version_policy() {
    // This is an explicitly injected ownership fixture, not evidence for a production domain.
    let ns = Namespace::with_ownership(
        "net.owner.music",
        OwnershipEvidence {
            domain: "owner.net".into(),
            reference: "test-only owner-confirmation fixture".into(),
        },
    )
    .unwrap();
    assert_eq!(ns.schema_version(), 1);
    assert_eq!(ns.scrobble_collection(), "net.owner.music.scrobble");
    assert_eq!(ns.follow_collection(), "net.owner.music.follow");
    ns.require_publication().unwrap();
    let local = ScrobbleInput::from_json(&input(), now())
        .unwrap()
        .into_record(&ns, now())
        .unwrap();
    let encoded = serde_json::to_value(local).unwrap();
    assert_eq!(encoded.as_object().unwrap().len(), 5);
    assert_eq!(encoded["$type"], "net.owner.music.scrobble");
    assert!(encoded.get("schemaVersion").is_none());
}

#[test]
fn unconfirmed_namespace_is_not_owner_evidence() {
    let error = Namespace::new("net.owner.music")
        .unwrap()
        .require_publication()
        .unwrap_err();
    assert_eq!(error.code, "namespace_not_production");
    for (domain, reference) in [("other.net", "reviewed"), ("owner.net", " ")] {
        let error = Namespace::with_ownership(
            "net.owner.music",
            OwnershipEvidence {
                domain: domain.into(),
                reference: reference.into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_namespace_ownership");
    }
    assert!(
        Namespace::with_ownership(
            FIXTURE_PREFIX,
            OwnershipEvidence {
                domain: "example.com".into(),
                reference: "test-only evidence".into(),
            }
        )
        .is_err()
    );
}

#[test]
fn unicode_limits() {
    let mut value = input();
    value["artist"] = Value::String("🦀".repeat(256));
    let accepted = ScrobbleInput::from_json(&value, now()).unwrap();
    assert_eq!(accepted.artist.chars().count(), 256);
    assert_eq!(accepted.artist.len(), 1_024);
    value["artist"] = Value::String("🦀".repeat(257));
    assert_eq!(
        ScrobbleInput::from_json(&value, now()).unwrap_err().field,
        "artist"
    );
    for track in ["", " \t\n\u{2003}"] {
        let mut value = input();
        value["track"] = json!(track);
        assert_eq!(
            ScrobbleInput::from_json(&value, now()).unwrap_err().field,
            "track"
        );
    }
    let mut value = input();
    value["artist"] = json!(format!("a{}", "\u{301}".repeat(256)));
    assert_eq!(
        ScrobbleInput::from_json(&value, now()).unwrap_err().field,
        "artist",
        "scalar count, not grapheme count"
    );
}

#[test]
fn strings_trim_and_album_has_same_limits() {
    let mut value = input();
    value["artist"] = json!("  Björk  ");
    value["track"] = json!("\tJóga\n");
    value["album"] = json!(" Homogenic ");
    let accepted = ScrobbleInput::from_json(&value, now()).unwrap();
    assert_eq!(accepted.artist, "Björk");
    assert_eq!(accepted.track, "Jóga");
    assert_eq!(accepted.album.as_deref(), Some("Homogenic"));
    for album in ["".to_string(), " ".to_string(), "a".repeat(257)] {
        value["album"] = json!(album);
        assert_eq!(
            ScrobbleInput::from_json(&value, now()).unwrap_err().field,
            "album"
        );
    }
}

#[test]
fn time_bounds() {
    for timestamp in ["1970-01-01T00:00:00Z", "2026-01-15T12:05:00Z"] {
        let mut value = input();
        value["listenedAt"] = json!(timestamp);
        assert_eq!(
            ScrobbleInput::from_json(&value, now()).unwrap().listened_at,
            timestamp
        );
    }
    for timestamp in [
        "2026-01-15T12:05:01Z",
        "1969-12-31T23:59:59Z",
        "1969-12-31T23:59:59.999999999Z",
    ] {
        let mut value = input();
        value["listenedAt"] = json!(timestamp);
        assert_eq!(
            ScrobbleInput::from_json(&value, now()).unwrap_err().field,
            "listenedAt"
        );
    }
    let mut value = record();
    value["createdAt"] = json!("2026-01-15T12:05:00Z");
    assert!(ScrobbleRecord::from_json(&value, &namespace(), now()).is_ok());
    value["createdAt"] = json!("2026-01-15T12:05:01Z");
    assert_eq!(
        ScrobbleRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "createdAt"
    );
}

#[test]
fn timestamps_require_explicit_utc() {
    assert!(validate_timestamp("listenedAt", "2026-01-15T12:00:00+00:00", now()).is_ok());
    for timestamp in [
        "2026-01-15T12:00:00-00:00",
        "2026-01-15T13:00:00+01:00",
        "2026-01-15T12:00:00",
        "2026-01-15",
        "2026-01-15t12:00:00z",
        "2016-12-31T23:59:60Z",
        "2026-01-15T12:05:00.0000000001Z",
    ] {
        assert_eq!(
            validate_timestamp("listenedAt", timestamp, now())
                .unwrap_err()
                .field,
            "listenedAt"
        );
    }
}

#[test]
fn optional_values() {
    for duration in [1, 86_400] {
        let mut value = input();
        value["durationSeconds"] = json!(duration);
        assert_eq!(
            ScrobbleInput::from_json(&value, now())
                .unwrap()
                .duration_seconds,
            Some(duration)
        );
    }
    for duration in [json!(0), json!(86_401), json!(1.5), json!(-1), Value::Null] {
        let mut value = input();
        value["durationSeconds"] = duration;
        assert_eq!(
            ScrobbleInput::from_json(&value, now()).unwrap_err().field,
            "durationSeconds"
        );
    }
    let mut value = input();
    value["recordingMbid"] = json!("c7a1fa70-1af8-4f92-a2b1-d8c85a1695e9");
    assert_eq!(
        ScrobbleInput::from_json(&value, now())
            .unwrap()
            .recording_mbid
            .as_deref(),
        Some("c7a1fa70-1af8-4f92-a2b1-d8c85a1695e9")
    );
    value["recordingMbid"] = json!("not-a-uuid");
    assert_eq!(
        ScrobbleInput::from_json(&value, now()).unwrap_err().field,
        "recordingMbid"
    );
    value["recordingMbid"] = json!("c7a1fa701af84f92a2b1d8c85a1695e9");
    assert_eq!(
        ScrobbleInput::from_json(&value, now()).unwrap_err().field,
        "recordingMbid"
    );
    let encoded = serde_json::to_value(ScrobbleInput::from_json(&input(), now()).unwrap()).unwrap();
    assert!(encoded.get("album").is_none());
    assert!(encoded.get("durationSeconds").is_none());
    assert!(encoded.get("recordingMbid").is_none());
}

#[test]
fn local_and_remote_input_are_separate() {
    for forbidden in [
        "$type",
        "did",
        "owner",
        "createdAt",
        "uri",
        "cid",
        "anythingElse",
    ] {
        let mut value = input();
        value[forbidden] = json!("untrusted");
        assert_eq!(
            ScrobbleInput::from_json(&value, now()).unwrap_err().field,
            forbidden
        );
    }
    let created = ScrobbleInput::from_json(&input(), now())
        .unwrap()
        .into_record(&namespace(), now())
        .unwrap();
    assert_eq!(created.record_type, "com.example.atmusic.scrobble");
    assert_eq!(created.created_at, "2026-01-15T12:00:00Z");
    assert!(ScrobbleRecord::from_json(&record(), &namespace(), now()).is_ok());
    let mut value = record();
    value["$type"] = json!("app.bsky.feed.post");
    assert_eq!(
        ScrobbleRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "$type"
    );
    value = record();
    value.as_object_mut().unwrap().remove("createdAt");
    assert_eq!(
        ScrobbleRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "createdAt"
    );
}

#[test]
fn remote_validation_uses_event_receipt_time() {
    let mut value = record();
    value["listenedAt"] = json!("2026-01-15T12:05:01Z");
    assert_eq!(
        ScrobbleRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "listenedAt"
    );
    let replay_wall_clock = now() + chrono::Duration::days(30);
    assert!(
        ScrobbleRecord::from_json(&value, &namespace(), replay_wall_clock).is_ok(),
        "using replay time would incorrectly admit the record; callers must pass event receipt time"
    );
}

#[test]
fn repeated_equal_timestamp_listens_are_valid() {
    let first = ScrobbleInput::from_json(&input(), now()).unwrap();
    let second = ScrobbleInput::from_json(&input(), now()).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        [first, second].len(),
        2,
        "validation never deduplicates legitimate repeated listens"
    );
}

#[test]
fn invalid_record_fixtures_have_exact_fields() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/scrobbles/invalid.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let field = case["field"].as_str().unwrap();
        let mut value = record();
        value[field] = case["value"].clone();
        assert_eq!(
            ScrobbleRecord::from_json(&value, &namespace(), now())
                .unwrap_err()
                .field,
            field,
            "{}",
            case["reason"]
        );
    }
}

#[test]
fn follow_schema() {
    for subject in [
        "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        "did:web:alice.test",
        "did:web:alice.test%3A8443:users:alice",
    ] {
        let accepted = FollowRecord::from_json(
            &follow(subject, "2026-01-15T12:00:00Z"),
            &namespace(),
            now(),
        )
        .unwrap();
        assert_eq!(accepted.subject, subject);
    }
    for subject in [
        "https://alice.test",
        "alice.test",
        "",
        "did:web:",
        "did:Web:alice.test",
        "did:web:alice%GGtest",
        "did:web:alice.test/",
    ] {
        assert_eq!(
            FollowRecord::from_json(
                &follow(subject, "2026-01-15T12:00:00Z"),
                &namespace(),
                now()
            )
            .unwrap_err()
            .field,
            "subject"
        );
    }
    let mut value = follow("did:web:alice.test", "2026-01-15T12:00:00Z");
    value.as_object_mut().unwrap().remove("subject");
    assert_eq!(
        FollowRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "subject"
    );
    value = follow("did:web:alice.test", "2026-01-15T12:00:00Z");
    value["$type"] = json!("app.bsky.graph.follow");
    assert_eq!(
        FollowRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "$type"
    );
    value = follow("did:web:alice.test", "2026-01-15T12:00:00Z");
    value["schemaVersion"] = json!(2);
    let extended = FollowRecord::from_json(&value, &namespace(), now()).unwrap();
    assert!(
        serde_json::to_value(extended)
            .unwrap()
            .get("schemaVersion")
            .is_none(),
        "unknown extension must not create implicit v2 behavior"
    );
}

#[test]
fn follow_rkey() {
    let first = make_follow_rkey("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
    let again = make_follow_rkey("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
    let other = make_follow_rkey("did:plc:cccccccccccccccccccccccc").unwrap();
    assert_eq!(
        first,
        "f9a71cc1369cb0ae7a6fa16d2b9ecdc8d3ba62a9c519fe9af11a322c90e9ef6f2"
    );
    assert_eq!(first, again);
    assert_ne!(first, other);
    assert_eq!(first.len(), 65);
    assert!(first.starts_with('f'));
    assert!(
        first[1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
}

#[test]
fn follow_time() {
    let accepted = FollowRecord::from_json(
        &follow("did:web:alice.test", "2026-01-15T12:05:00Z"),
        &namespace(),
        now(),
    )
    .unwrap();
    assert_eq!(accepted.created_at, "2026-01-15T12:05:00Z");
    assert_eq!(
        FollowRecord::from_json(
            &follow("did:web:alice.test", "2026-01-15T12:05:01Z"),
            &namespace(),
            now()
        )
        .unwrap_err()
        .field,
        "createdAt"
    );
}

#[test]
fn lexicons_freeze_schema_v1() {
    let scrobble: Value =
        serde_json::from_str(include_str!("../../../lexicons/scrobble.json")).unwrap();
    let follow: Value =
        serde_json::from_str(include_str!("../../../lexicons/follow.json")).unwrap();
    assert_eq!(scrobble["lexicon"], 1);
    assert_eq!(follow["lexicon"], 1);
    assert_eq!(scrobble["id"], namespace().scrobble_collection());
    assert_eq!(follow["id"], namespace().follow_collection());
    assert_eq!(
        scrobble["defs"]["main"]["record"]["properties"]["artist"]["maxLength"],
        1_024
    );
    assert_eq!(
        scrobble["defs"]["main"]["record"]["properties"]["durationSeconds"]["maximum"],
        86_400
    );
    assert_eq!(
        follow["defs"]["main"]["record"]["properties"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn remote_display_spelling_is_retained() {
    let mut value = record();
    value["artist"] = json!("  BJÖRK  ");
    value["track"] = json!("jóga");
    value["album"] = json!(" HOMOGENIC ");
    let validated = ScrobbleRecord::from_json(&value, &namespace(), now()).unwrap();
    assert_eq!(validated.artist, "  BJÖRK  ");
    assert_eq!(validated.track, "jóga");
    assert_eq!(validated.album.as_deref(), Some(" HOMOGENIC "));
    value["artist"] = json!(format!("{}Björk", " ".repeat(256)));
    assert_eq!(
        ScrobbleRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "artist"
    );
}

#[test]
fn remote_lexicon_extensions_are_ignored() {
    let mut value = record();
    value["externalMetadata"] = json!({"source":"compatible-writer", "revision":2});
    value["owner"] = json!("did:plc:cccccccccccccccccccccccc");
    let validated = ScrobbleRecord::from_json(&value, &namespace(), now()).unwrap();
    assert_eq!(validated.artist, "Björk");
    let output = serde_json::to_value(validated).unwrap();
    assert!(output.get("externalMetadata").is_none());
    assert!(output.get("owner").is_none());
    let mut value = follow("did:web:alice.test", "2026-01-15T12:00:00Z");
    value["externalMetadata"] = json!("ignored");
    assert!(FollowRecord::from_json(&value, &namespace(), now()).is_ok());
    value["subject"] = json!("alice.test");
    assert_eq!(
        FollowRecord::from_json(&value, &namespace(), now())
            .unwrap_err()
            .field,
        "subject",
        "extensions never relax validation of known fields"
    );
}

#[test]
fn local_raw_bounds_match_published_schema() {
    let mut value = input();
    value["artist"] = json!(format!("{}Björk", " ".repeat(252)));
    assert_eq!(
        ScrobbleInput::from_json(&value, now()).unwrap_err().field,
        "artist"
    );
    value["artist"] = json!(format!("{}Björk", " ".repeat(251)));
    assert_eq!(
        ScrobbleInput::from_json(&value, now()).unwrap().artist,
        "Björk"
    );
}
