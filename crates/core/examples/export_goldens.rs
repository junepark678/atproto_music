//! Rust-oracle golden export for the pure `atmusic-core` rules (W0-03, ADR 0004 §10.4, §12).
//!
//! Every verdict, key, rendering and token below is produced by calling the frozen
//! production code in `crates/core/src`. The few values computed here (the derived cursor
//! key and the forged cursor payloads) are first checked against production output, so a
//! wrong local computation aborts the export instead of producing a golden.
//!
//! Usage: `cargo run --locked -p atmusic-core --example export_goldens -- [--out DIR]`
//! (default `tests/goldens`). The whole export is rendered twice in-process and must be
//! byte-identical before any file is written; `scripts/check_goldens.sh` adds the
//! cross-process comparison against the committed files.
//!
//! The cursor application keys below are fixed, public, test-only key material.

use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
};

use atmusic_core::{
    cursor::{CursorBinding, CursorCodec, CursorError, CursorPosition, PageCursor},
    follow::{FollowRecord, follow_rkey, validate_did_syntax},
    music_key::{AlbumKey, ArtistKey, GROUPING_UNICODE_VERSION, TrackKey, normalize},
    namespace::{FIXTURE_PREFIX, Namespace},
    scrobble::{ScrobbleInput, ScrobbleRecord, ValidationError, validate_timestamp},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

const RECEIPT: &str = "2026-01-15T12:00:00Z";
const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL: &str = "did:plc:cccccccccccccccccccccccc";
const CURSOR_KEY_CONTEXT: &[u8] = b"atmusic:cursor:hmac-sha256:v1";
const SOURCE: &str = "crates/core/examples/export_goldens.rs";

fn main() {
    let out = output_dir();
    let first = render_all();
    let second = render_all();
    assert_eq!(
        first, second,
        "golden export is not deterministic within one process"
    );
    fs::create_dir_all(&out).expect("create output directory");
    for (name, body) in &first {
        fs::write(out.join(name), body).expect("write golden file");
    }
    let total: usize = first.iter().map(|(_, body)| body.len()).sum();
    println!(
        "export_goldens: wrote {} core golden files ({total} bytes) to {}; two in-process renders byte-identical",
        first.len(),
        out.display()
    );
}

fn output_dir() -> PathBuf {
    let mut args = std::env::args().skip(1);
    let mut out = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = Some(PathBuf::from(args.next().expect("--out requires a path"))),
            other => panic!("unknown argument {other}; usage: export_goldens [--out DIR]"),
        }
    }
    out.unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/goldens"))
}

fn render_all() -> Vec<(&'static str, String)> {
    vec![
        ("music_keys.json", pretty(&music_keys())),
        ("validation.json", pretty(&validation())),
        ("timestamps.json", pretty(&timestamps())),
        ("follow_rkeys.json", pretty(&follow_rkeys())),
        ("cursors.json", pretty(&cursors())),
    ]
}

fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("serialize golden");
    text.push('\n');
    text
}

fn at(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("fixture timestamp")
        .with_timezone(&Utc)
}

fn receipt() -> DateTime<Utc> {
    at(RECEIPT)
}

fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).expect("fixture namespace")
}

fn code_points(value: &str) -> Vec<String> {
    value
        .chars()
        .map(|c| format!("U+{:04X}", u32::from(c)))
        .collect()
}

fn error_json(error: &ValidationError) -> Value {
    json!({"field": error.field, "code": error.code, "message": error.message})
}

fn cmp_number(ordering: Ordering) -> i8 {
    match ordering {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------
// music_keys.json
// ---------------------------------------------------------------------------------------

fn music_corpus() -> Vec<(&'static str, String)> {
    let s = |v: &str| v.to_string();
    vec![
        ("testing_bjork", s("Björk")),
        ("testing_bjork_upper_padded", s("  BJÖRK  ")),
        ("testing_bjork_decomposed", s(" BJO\u{308}RK ")),
        (
            "testing_bjork_unicode_spaces",
            s("\u{2003}\u{a0}BJÖRK\u{3000}"),
        ),
        ("testing_joga", s("Jóga")),
        ("testing_joga_lower", s("jóga")),
        ("testing_joga_decomposed", s(" jo\u{301}ga\u{a0}")),
        ("testing_homogenic", s("Homogenic")),
        ("testing_homogenic_padded_upper", s(" HOMOGENIC ")),
        ("sharp_s", s("Straße")),
        ("sharp_s_upper", s("STRASSE")),
        ("capital_sharp_s", s("\u{1e9e}")),
        (
            "fullwidth_strasse",
            s("\u{ff33}\u{ff34}\u{ff32}\u{ff21}\u{ff33}\u{ff33}\u{ff25}"),
        ),
        (
            "fullwidth_digits_letters",
            s("\u{ff21}\u{ff22}\u{ff23}\u{ff11}\u{ff12}\u{ff13}"),
        ),
        ("dotted_capital_i", s("\u{130}stanbul")),
        ("dotless_small_i", s("\u{131}stanbul")),
        ("plain_istanbul", s("Istanbul")),
        ("fi_ligature", s("\u{fb01}sh")),
        ("ffl_ligature", s("\u{fb04}")),
        ("kelvin_sign", s("\u{212a}elvin")),
        ("ascii_kelvin", s("Kelvin")),
        ("angstrom_sign", s("\u{212b}")),
        ("final_sigma", s("Σςσ")),
        ("cherokee_full_fold", s("\u{ab70}")),
        ("unicode16_mapping", s("\u{a7cb}")),
        ("nel_inside", s("Kate\u{85}Bush")),
        ("nel_edges", s("\u{85}Kate Bush\u{85}")),
        (
            "mixed_whitespace",
            s("Kate\u{2003}\u{a0}\t\n\u{3000}\u{2028}Bush"),
        ),
        ("ascii_kate_bush", s("Kate Bush")),
        ("bom_leading", s("\u{feff}Björk")),
        ("bom_only", s("\u{feff}")),
        ("zwj_sequence", s("\u{1f469}\u{200d}\u{1f3a4}")),
        ("zwj_between_letters", s("a\u{200d}b")),
        ("zwsp_not_whitespace", s("a\u{200b}b")),
        ("mongolian_vowel_separator", s("a\u{180e}b")),
        ("unit_separator_not_whitespace", s("a\u{1f}b")),
        ("diaeresis_spacing_mark", s("\u{a8}")),
        ("overline", s("x\u{203e}")),
        ("math_bold_a_astral", s("\u{1d400}")),
        ("deseret_capital_astral", s("\u{10400}")),
        ("emoji_astral", s("\u{1f600}")),
        ("first_astral", s("\u{10000}")),
        ("private_use_e000", s("\u{e000}")),
        ("replacement_fffd", s("\u{fffd}")),
        ("noncharacter_ffff", s("\u{ffff}")),
        ("halfwidth_hangul_ffdc", s("\u{ffdc}")),
        ("hangul_jamo_extended_d7ff", s("\u{d7ff}")),
        ("tuple_separator_ab", s("a|b")),
        ("tuple_separator_a", s("a")),
        ("prefix_a_space_b", s("a b")),
        ("credit_feat", s("Artist A feat. Artist B")),
        ("credit_plain", s("Artist A")),
        ("whitespace_only", s(" \t\u{3000}")),
        ("nel_only", s("\u{85}")),
        ("nbsp_only", s("\u{a0}")),
        ("empty", s("")),
    ]
}

fn music_keys() -> Value {
    assert_eq!(
        GROUPING_UNICODE_VERSION,
        (16, 0, 0),
        "golden corpus is pinned to Unicode 16"
    );
    let corpus = music_corpus();
    let entries: Vec<Value> = corpus
        .iter()
        .map(|(id, input)| {
            let normalized = normalize(input);
            let artist = ArtistKey::new(input);
            json!({
                "id": id,
                "input": input,
                "inputCodePoints": code_points(input),
                "normalized": normalized,
                "normalizedCodePoints": code_points(&normalized),
                "artistKey": artist.as_ref().ok().map(ArtistKey::as_str),
                "artistKeyError": artist.as_ref().err().map(error_json),
            })
        })
        .collect();

    // Pairwise ordering of every distinct valid artist key, in corpus order (i < j).
    let mut distinct: Vec<ArtistKey> = Vec::new();
    for (_, input) in &corpus {
        if let Ok(key) = ArtistKey::new(input)
            && !distinct.contains(&key)
        {
            distinct.push(key);
        }
    }
    let mut sorted = distinct.clone();
    sorted.sort();
    let mut artist_pairs = Vec::new();
    for (i, a) in distinct.iter().enumerate() {
        for b in &distinct[i + 1..] {
            artist_pairs
                .push(json!({"a": a.as_str(), "b": b.as_str(), "cmp": cmp_number(a.cmp(b))}));
        }
    }

    let tuple_corpus: Vec<(&str, &str, Option<&str>)> = vec![
        ("Björk", "Jóga", Some("Homogenic")),
        ("  BJÖRK  ", "jóga", Some(" HOMOGENIC ")),
        ("\u{2003}BJÖRK", " jo\u{301}ga\u{a0}", None),
        ("Radiohead", "Weird Fishes", Some("In Rainbows")),
        ("Radiohead", "Karma Police", Some("OK Computer")),
        ("Radiohead", "No Surprises", Some("OK Computer")),
        ("Kate Bush", "Running Up That Hill", None),
        ("Kate Bush", "Cloudbusting", Some("Hounds of Love")),
        ("a|b", "c", Some("c")),
        ("a", "b|c", Some("b|c")),
        ("a b", "a", None),
        ("a", "z", None),
        ("a", "\u{e000}", None),
        ("a", "\u{10000}", None),
        ("\u{e000}", "a", None),
        ("\u{10000}", "a", None),
        ("Björk", "", None),
        ("Björk", "Jóga", Some("")),
        ("Björk", "Jóga", Some(" \u{3000}")),
        ("", "Jóga", Some("Homogenic")),
    ];
    let mut tracks: Vec<TrackKey> = Vec::new();
    let tuples: Vec<Value> = tuple_corpus
        .iter()
        .map(|(artist, track, album)| {
            let track_key = TrackKey::new(artist, track);
            let album_key = AlbumKey::optional(artist, *album);
            if let Ok(key) = &track_key
                && !tracks.contains(key)
            {
                tracks.push(key.clone());
            }
            json!({
                "artist": artist,
                "track": track,
                "album": album,
                "trackKey": track_key.as_ref().ok().map(|k| json!([k.artist().as_str(), k.track()])),
                "trackKeyError": track_key.as_ref().err().map(error_json),
                "albumKey": match &album_key {
                    Ok(Some(k)) => json!([k.artist().as_str(), k.album()]),
                    _ => Value::Null,
                },
                "albumKeyError": album_key.as_ref().err().map(error_json),
            })
        })
        .collect();
    let mut track_pairs = Vec::new();
    for (i, a) in tracks.iter().enumerate() {
        for b in &tracks[i + 1..] {
            track_pairs.push(json!({
                "a": [a.artist().as_str(), a.track()],
                "b": [b.artist().as_str(), b.track()],
                "cmp": cmp_number(a.cmp(b)),
            }));
        }
    }

    // TESTING.md grouping expectations must hold in the oracle before they are exported.
    let artist = |v: &str| ArtistKey::new(v).unwrap();
    assert_eq!(artist("Björk"), artist("  BJÖRK  "));
    assert_eq!(artist("Björk").as_str(), "björk");
    assert_eq!(
        TrackKey::new("Björk", "Jóga").unwrap(),
        TrackKey::new("  BJÖRK  ", "jóga").unwrap()
    );
    assert_eq!(
        AlbumKey::optional("Björk", Some("Homogenic")).unwrap(),
        AlbumKey::optional("  BJÖRK  ", Some(" HOMOGENIC ")).unwrap()
    );
    assert_eq!(AlbumKey::optional("Björk", None).unwrap(), None);
    assert_eq!(normalize("Straße"), normalize("STRASSE"));
    assert!(
        artist("\u{e000}") < artist("\u{10000}"),
        "code-point order puts astral above U+E000"
    );
    assert!(
        artist("\u{ffff}") < artist("\u{10000}"),
        "code-point order puts astral above U+FFFF"
    );

    json!({
        "description": "Rust oracle music grouping keys: NFKC (Unicode 16) -> full default case fold -> trim and collapse Unicode White_Space. `normalized` is music_key::normalize; `artistKey` is ArtistKey::new (display-string validation first). Pairwise `cmp` is Rust Ord (-1/0/1), i.e. UTF-8 byte / code-point order, not UTF-16 order.",
        "source": SOURCE,
        "unicodeVersion": format!("{}.{}.{}", GROUPING_UNICODE_VERSION.0, GROUPING_UNICODE_VERSION.1, GROUPING_UNICODE_VERSION.2),
        "entries": entries,
        "artistKeyOrdering": {
            "sorted": sorted.iter().map(ArtistKey::as_str).collect::<Vec<_>>(),
            "pairs": artist_pairs,
        },
        "tuples": tuples,
        "trackKeyOrdering": {
            "pairs": track_pairs,
        },
    })
}

// ---------------------------------------------------------------------------------------
// validation.json
// ---------------------------------------------------------------------------------------

struct Vector {
    id: String,
    kind: &'static str,
    json: String,
}

fn vector(id: impl Into<String>, kind: &'static str, value: Value) -> Vector {
    Vector {
        id: id.into(),
        kind,
        json: serde_json::to_string(&value).expect("vector json"),
    }
}

fn raw_vector(id: &str, kind: &'static str, json: &str) -> Vector {
    Vector {
        id: id.into(),
        kind,
        json: json.into(),
    }
}

fn scrobble(artist: &str, track: &str, listened_at: &str) -> Value {
    json!({"artist": artist, "track": track, "listenedAt": listened_at})
}

fn remote_scrobble(artist: &str, listened_at: &str, created_at: &str) -> Value {
    json!({
        "$type": format!("{FIXTURE_PREFIX}.scrobble"),
        "artist": artist,
        "track": "Jóga",
        "listenedAt": listened_at,
        "createdAt": created_at,
    })
}

fn with(mut base: Value, field: &str, value: Value) -> Value {
    base[field] = value;
    base
}

fn validation_vectors() -> Vec<Vector> {
    let ok_time = "2026-01-15T11:00:00Z";
    let base = || scrobble("Björk", "Jóga", ok_time);
    let mut v = Vec::new();

    // Display-string scalar and byte bounds (counted on the raw, untrimmed value).
    let a = |n: usize| "a".repeat(n);
    let astral = |n: usize| "\u{1f600}".repeat(n);
    for (id, artist) in [
        ("artist_256_ascii_scalars", a(256)),
        ("artist_257_ascii_scalars", a(257)),
        ("artist_256_two_byte_scalars_512_bytes", "é".repeat(256)),
        ("artist_256_astral_scalars_1024_bytes", astral(256)),
        ("artist_257_astral_scalars_1028_bytes", astral(257)),
        (
            "artist_255_astral_plus_ascii_1021_bytes",
            format!("{}a", astral(255)),
        ),
        ("artist_padded_raw_257_trimmed_255", format!(" {} ", a(255))),
        ("artist_padded_raw_256_trimmed_254", format!(" {} ", a(254))),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "artist", json!(artist)),
        ));
    }
    for (id, track) in [
        ("track_256_ascii_scalars", a(256)),
        ("track_257_ascii_scalars", a(257)),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "track", json!(track)),
        ));
    }
    for (id, album) in [
        ("album_256_astral_scalars_1024_bytes", astral(256)),
        ("album_257_ascii_scalars", a(257)),
        ("album_empty", String::new()),
        ("album_whitespace_only", " \u{3000}".into()),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "album", json!(album)),
        ));
    }

    // Trim-to-empty uses Unicode White_Space (str::trim), not JS trim / \s.
    for (id, artist) in [
        ("artist_empty", ""),
        ("artist_spaces_only", "   "),
        ("artist_tab_newline_only", "\t\n\r"),
        ("artist_nel_only", "\u{85}"),
        ("artist_nbsp_only", "\u{a0}"),
        ("artist_ideographic_space_only", "\u{3000}"),
        ("artist_line_separator_only", "\u{2028}"),
        ("artist_bom_only_not_white_space", "\u{feff}"),
        ("artist_zwsp_only_not_white_space", "\u{200b}"),
        ("artist_unit_separator_only_not_white_space", "\u{1f}"),
        ("artist_mongolian_vowel_separator_only", "\u{180e}"),
        ("artist_trimmed_nel_edges", "\u{85}Björk\u{85}"),
        ("artist_trimmed_bom_edges_kept", "\u{feff}Björk\u{feff}"),
        (
            "artist_trimmed_mixed_edges",
            "\u{3000}\u{a0} Björk \t\u{2003}",
        ),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "artist", json!(artist)),
        ));
    }

    // Lone surrogates: serde_json refuses to decode them, so no Rust string can hold one.
    v.push(raw_vector(
        "artist_lone_high_surrogate",
        "scrobbleInput",
        r#"{"artist":"\ud800","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z"}"#,
    ));
    v.push(raw_vector(
        "artist_lone_low_surrogate",
        "scrobbleInput",
        r#"{"artist":"\udc00","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z"}"#,
    ));
    v.push(raw_vector(
        "track_embedded_lone_surrogate",
        "scrobbleInput",
        r#"{"artist":"Björk","track":"a\ud83db","listenedAt":"2026-01-15T11:00:00Z"}"#,
    ));
    v.push(raw_vector(
        "album_reversed_surrogate_pair",
        "scrobbleInput",
        r#"{"artist":"Björk","track":"Jóga","album":"\ude00\ud83d","listenedAt":"2026-01-15T11:00:00Z"}"#,
    ));
    v.push(raw_vector(
        "record_artist_lone_surrogate",
        "scrobbleRecord",
        r#"{"$type":"com.example.atmusic.scrobble","artist":"\ud800","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","createdAt":"2026-01-15T11:00:00Z"}"#,
    ));
    v.push(raw_vector(
        "artist_valid_surrogate_pair",
        "scrobbleInput",
        r#"{"artist":"😀","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z"}"#,
    ));

    // Timestamp bounds against receipt 2026-01-15T12:00:00Z.
    for (id, listened_at) in [
        ("listened_at_receipt", "2026-01-15T12:00:00Z"),
        ("listened_at_plus_300s", "2026-01-15T12:05:00Z"),
        (
            "listened_at_plus_300s_zero_fraction",
            "2026-01-15T12:05:00.000000000Z",
        ),
        (
            "listened_at_plus_300s_zero_subnanosecond_tail",
            "2026-01-15T12:05:00.0000000000Z",
        ),
        (
            "listened_at_plus_300s_plus_1ns",
            "2026-01-15T12:05:00.000000001Z",
        ),
        (
            "listened_at_plus_300s_subnanosecond_tail",
            "2026-01-15T12:05:00.0000000001Z",
        ),
        ("listened_at_plus_301s", "2026-01-15T12:05:01Z"),
        (
            "listened_at_plus_299_999999999s",
            "2026-01-15T12:04:59.999999999Z",
        ),
        ("listened_at_epoch", "1970-01-01T00:00:00Z"),
        (
            "listened_at_epoch_fraction",
            "1970-01-01T00:00:00.000000001Z",
        ),
        ("listened_at_before_epoch_1s", "1969-12-31T23:59:59Z"),
        (
            "listened_at_before_epoch_1ns",
            "1969-12-31T23:59:59.999999999Z",
        ),
        (
            "listened_at_utc_numeric_offset",
            "2026-01-15T11:00:00+00:00",
        ),
        (
            "listened_at_negative_zero_offset",
            "2026-01-15T11:00:00-00:00",
        ),
        ("listened_at_non_utc_offset", "2026-01-15T12:00:00+01:00"),
        ("listened_at_lowercase_t", "2026-01-15t11:00:00Z"),
        ("listened_at_lowercase_z", "2026-01-15T11:00:00z"),
        ("listened_at_space_separator", "2026-01-15 11:00:00Z"),
        ("listened_at_no_offset", "2026-01-15T11:00:00"),
        ("listened_at_no_seconds", "2026-01-15T11:00Z"),
        ("listened_at_leap_second", "2016-12-31T23:59:60Z"),
        ("listened_at_millis", "2026-01-15T11:00:00.123Z"),
        ("listened_at_nanos", "2026-01-15T11:00:00.123456789Z"),
        ("listened_at_invalid_date", "2026-02-30T11:00:00Z"),
        ("listened_at_empty", ""),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "listenedAt", json!(listened_at)),
        ));
    }
    v.push(vector(
        "listened_at_number",
        "scrobbleInput",
        with(base(), "listenedAt", json!(1_768_478_400)),
    ));

    // Duration bounds.
    for (id, duration) in [
        ("duration_0", json!(0)),
        ("duration_1", json!(1)),
        ("duration_86400", json!(86_400)),
        ("duration_86401", json!(86_401)),
        ("duration_negative", json!(-1)),
        ("duration_fractional", json!(1.5)),
        ("duration_integral_float", json!(60.0)),
        ("duration_string", json!("60")),
        ("duration_u32_overflow", json!(4_294_967_296_u64)),
        ("duration_null", Value::Null),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "durationSeconds", duration),
        ));
    }

    // MBID syntax.
    for (id, mbid) in [
        (
            "mbid_lower_hyphenated",
            json!("3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10"),
        ),
        (
            "mbid_upper_hyphenated",
            json!("3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10"),
        ),
        ("mbid_nil", json!("00000000-0000-0000-0000-000000000000")),
        (
            "mbid_simple_no_hyphens",
            json!("3f2f7f3e3c1d4b9e9a391f3a7c5b2d10"),
        ),
        (
            "mbid_braced",
            json!("{3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10}"),
        ),
        (
            "mbid_urn",
            json!("urn:uuid:3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10"),
        ),
        ("mbid_short", json!("3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d1")),
        (
            "mbid_non_hex",
            json!("3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2dzz"),
        ),
        (
            "mbid_misplaced_hyphen",
            json!("3f2f7f3-e3c1d-4b9e-9a39-1f3a7c5b2d10"),
        ),
        (
            "mbid_padded",
            json!(" 3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10"),
        ),
        ("mbid_empty", json!("")),
        ("mbid_number", json!(42)),
    ] {
        v.push(vector(
            id,
            "scrobbleInput",
            with(base(), "recordingMbid", mbid),
        ));
    }

    // Shape of local input: unknown fields and derived fields are rejected.
    v.push(vector("input_minimal_valid", "scrobbleInput", base()));
    v.push(vector(
        "input_all_fields_valid",
        "scrobbleInput",
        json!({"artist":"  BJÖRK  ","track":"jóga","album":" HOMOGENIC ","listenedAt":"2026-01-14T11:00:00Z","durationSeconds":305,"recordingMbid":"3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10"}),
    ));
    v.push(vector(
        "input_unknown_field",
        "scrobbleInput",
        with(base(), "mood", json!("happy")),
    ));
    v.push(vector(
        "input_created_at_not_accepted",
        "scrobbleInput",
        with(base(), "createdAt", json!(ok_time)),
    ));
    v.push(vector(
        "input_type_not_accepted",
        "scrobbleInput",
        with(base(), "$type", json!(format!("{FIXTURE_PREFIX}.scrobble"))),
    ));
    v.push(vector(
        "input_missing_artist",
        "scrobbleInput",
        json!({"track":"Jóga","listenedAt":ok_time}),
    ));
    v.push(vector(
        "input_missing_track",
        "scrobbleInput",
        json!({"artist":"Björk","listenedAt":ok_time}),
    ));
    v.push(vector(
        "input_missing_listened_at",
        "scrobbleInput",
        json!({"artist":"Björk","track":"Jóga"}),
    ));
    v.push(vector(
        "input_artist_number",
        "scrobbleInput",
        with(base(), "artist", json!(7)),
    ));
    v.push(vector(
        "input_album_null",
        "scrobbleInput",
        with(base(), "album", Value::Null),
    ));
    v.push(vector(
        "input_not_object",
        "scrobbleInput",
        json!(["Björk"]),
    ));

    // Remote scrobble records: open lexicon objects, remote spelling kept, createdAt bounded.
    let record = || remote_scrobble("Björk", ok_time, ok_time);
    v.push(vector("record_valid", "scrobbleRecord", record()));
    v.push(vector(
        "record_remote_spelling_kept",
        "scrobbleRecord",
        remote_scrobble("  BJÖRK  ", ok_time, ok_time),
    ));
    v.push(vector(
        "record_unknown_field_ignored",
        "scrobbleRecord",
        with(record(), "mood", json!("happy")),
    ));
    v.push(vector(
        "record_wrong_type",
        "scrobbleRecord",
        with(record(), "$type", json!("com.example.other.scrobble")),
    ));
    v.push(vector(
        "record_follow_type_in_scrobble_collection",
        "scrobbleRecord",
        with(record(), "$type", json!(format!("{FIXTURE_PREFIX}.follow"))),
    ));
    v.push(vector(
        "record_missing_type",
        "scrobbleRecord",
        scrobble("Björk", "Jóga", ok_time),
    ));
    v.push(vector(
        "record_missing_created_at",
        "scrobbleRecord",
        json!({"$type": format!("{FIXTURE_PREFIX}.scrobble"), "artist":"Björk","track":"Jóga","listenedAt":ok_time}),
    ));
    v.push(vector(
        "record_created_at_plus_300s",
        "scrobbleRecord",
        remote_scrobble("Björk", ok_time, "2026-01-15T12:05:00Z"),
    ));
    v.push(vector(
        "record_created_at_plus_301s",
        "scrobbleRecord",
        remote_scrobble("Björk", ok_time, "2026-01-15T12:05:01Z"),
    ));
    v.push(vector(
        "record_listened_at_plus_301s",
        "scrobbleRecord",
        remote_scrobble("Björk", "2026-01-15T12:05:01Z", ok_time),
    ));
    v.push(vector(
        "record_created_at_before_epoch",
        "scrobbleRecord",
        remote_scrobble("Björk", ok_time, "1969-12-31T23:59:59Z"),
    ));
    v.push(vector(
        "record_artist_257_scalars",
        "scrobbleRecord",
        remote_scrobble(&a(257), ok_time, ok_time),
    ));
    v.push(vector(
        "record_artist_whitespace_only",
        "scrobbleRecord",
        remote_scrobble("\u{3000}", ok_time, ok_time),
    ));
    v.push(vector(
        "record_duration_0",
        "scrobbleRecord",
        with(record(), "durationSeconds", json!(0)),
    ));
    v.push(vector(
        "record_duration_86400",
        "scrobbleRecord",
        with(record(), "durationSeconds", json!(86_400)),
    ));
    v.push(vector(
        "record_mbid_upper",
        "scrobbleRecord",
        with(
            record(),
            "recordingMbid",
            json!("3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10"),
        ),
    ));
    v.push(vector(
        "record_mbid_simple",
        "scrobbleRecord",
        with(
            record(),
            "recordingMbid",
            json!("3f2f7f3e3c1d4b9e9a391f3a7c5b2d10"),
        ),
    ));

    // Follow records and subjects.
    let follow = |subject: &str, created_at: &str| json!({"$type": format!("{FIXTURE_PREFIX}.follow"), "subject": subject, "createdAt": created_at});
    v.push(vector("follow_valid", "followRecord", follow(BOB, ok_time)));
    v.push(vector(
        "follow_did_web",
        "followRecord",
        follow("did:web:example.com", ok_time),
    ));
    v.push(vector(
        "follow_unknown_field_ignored",
        "followRecord",
        with(follow(BOB, ok_time), "note", json!("x")),
    ));
    v.push(vector(
        "follow_wrong_type",
        "followRecord",
        with(
            follow(BOB, ok_time),
            "$type",
            json!(format!("{FIXTURE_PREFIX}.scrobble")),
        ),
    ));
    v.push(vector(
        "follow_subject_handle",
        "followRecord",
        follow("bob.test", ok_time),
    ));
    v.push(vector(
        "follow_subject_uppercase_method",
        "followRecord",
        follow("did:PLC:bbbbbbbbbbbbbbbbbbbbbbbb", ok_time),
    ));
    v.push(vector(
        "follow_created_at_plus_300s",
        "followRecord",
        follow(BOB, "2026-01-15T12:05:00Z"),
    ));
    v.push(vector(
        "follow_created_at_plus_301s",
        "followRecord",
        follow(BOB, "2026-01-15T12:05:01Z"),
    ));
    v.push(vector(
        "follow_missing_subject",
        "followRecord",
        json!({"$type": format!("{FIXTURE_PREFIX}.follow"), "createdAt": ok_time}),
    ));
    v.push(vector(
        "follow_missing_created_at",
        "followRecord",
        json!({"$type": format!("{FIXTURE_PREFIX}.follow"), "subject": BOB}),
    ));
    v.push(vector(
        "follow_self_subject_syntax_only",
        "followRecord",
        follow(ALICE, ok_time),
    ));

    let long_ok = format!("did:plc:{}", "a".repeat(2_048 - 8));
    let long_bad = format!("did:plc:{}", "a".repeat(2_049 - 8));
    for (id, subject) in [
        ("subject_plc", BOB.to_string()),
        ("subject_web", "did:web:example.com".into()),
        (
            "subject_web_port_encoded",
            "did:web:localhost%3A8080".into(),
        ),
        ("subject_colon_inside", "did:example:abc:def".into()),
        ("subject_allowed_punctuation", "did:example:a._-b".into()),
        ("subject_2048_bytes", long_ok),
        ("subject_2049_bytes", long_bad),
        ("subject_trailing_colon", "did:plc:abc:".into()),
        ("subject_bad_percent", "did:web:example%2".into()),
        ("subject_bad_percent_hex", "did:web:example%zz".into()),
        ("subject_uppercase_method", "did:PLC:abc".into()),
        ("subject_digit_method", "did:plc1:abc".into()),
        ("subject_empty_method", "did::abc".into()),
        ("subject_empty_identifier", "did:plc:".into()),
        ("subject_no_identifier", "did:plc".into()),
        ("subject_uppercase_prefix", "DID:plc:abc".into()),
        ("subject_space", "did:plc:ab c".into()),
        ("subject_slash", "did:web:example.com/path".into()),
        ("subject_non_ascii", "did:plc:ä".into()),
        ("subject_handle", "alice.test".into()),
        ("subject_empty", String::new()),
    ] {
        v.push(vector(id, "followSubject", json!(subject)));
    }
    v
}

/// The canonicalization `POST /scrobbles` applies between `ScrobbleInput::from_json` and
/// `into_record` (crates/server/src/http/scrobbles/create.rs, the `input.listened_at =
/// parse_from_rfc3339(..).with_timezone(&Utc).to_rfc3339_opts(Nanos, true)` step, which also
/// precedes the input digest). Mirrored here because it lives in the server handler, not in
/// atmusic-core; `from_json` has already validated the timestamp, so parsing cannot fail.
fn canonicalize_listened_at(mut input: ScrobbleInput) -> ScrobbleInput {
    input.listened_at = DateTime::parse_from_rfc3339(&input.listened_at)
        .expect("from_json accepted an RFC 3339 listenedAt")
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Nanos, true);
    input
}

fn validate_vector(vector: &Vector) -> Value {
    let receipt = receipt();
    let namespace = namespace();
    let parsed: Value = match serde_json::from_str(&vector.json) {
        Ok(value) => value,
        Err(_) => {
            return json!({"verdict": "reject", "error": {"stage": "json", "code": "invalid_json", "field": Value::Null, "message": "serde_json rejects the document (lone surrogates are not representable as a Rust string)"}});
        }
    };
    let result: Result<Value, ValidationError> = match vector.kind {
        "scrobbleInput" => ScrobbleInput::from_json(&parsed, receipt)
            .map(canonicalize_listened_at)
            .and_then(|input| input.into_record(&namespace, receipt))
            .map(|record| serde_json::to_value(record).unwrap()),
        "scrobbleRecord" => ScrobbleRecord::from_json(&parsed, &namespace, receipt)
            .map(|record| serde_json::to_value(record).unwrap()),
        "followRecord" => FollowRecord::from_json(&parsed, &namespace, receipt)
            .map(|record| serde_json::to_value(record).unwrap()),
        "followSubject" => FollowRecord::new(
            parsed.as_str().expect("subject vector is a JSON string"),
            &namespace,
            receipt,
        )
        .map(|record| serde_json::to_value(record).unwrap()),
        other => unreachable!("unknown vector kind {other}"),
    };
    match result {
        Ok(output) => json!({"verdict": "accept", "output": output}),
        Err(error) => {
            json!({"verdict": "reject", "error": {"stage": "validation", "code": error.code, "field": error.field, "message": error.message}})
        }
    }
}

fn validation() -> Value {
    let vectors = validation_vectors();
    let mut ids = std::collections::BTreeSet::new();
    let rendered: Vec<Value> = vectors
        .iter()
        .map(|vector| {
            assert!(
                ids.insert(vector.id.clone()),
                "duplicate vector id {}",
                vector.id
            );
            let result = validate_vector(vector);
            json!({
                "id": vector.id,
                "kind": vector.kind,
                "receiptTime": RECEIPT,
                "json": vector.json,
                "verdict": result["verdict"],
                "output": result.get("output").cloned().unwrap_or(Value::Null),
                "error": result.get("error").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    // TESTING.md bounds must hold in the oracle before they are exported.
    let verdict = |id: &str| {
        rendered
            .iter()
            .find(|v| v["id"] == id)
            .map(|v| v["verdict"].as_str().unwrap().to_string())
            .unwrap()
    };
    for (id, expected) in [
        ("listened_at_plus_300s", "accept"),
        ("listened_at_plus_301s", "reject"),
        ("listened_at_epoch", "accept"),
        ("listened_at_before_epoch_1s", "reject"),
        ("artist_256_ascii_scalars", "accept"),
        ("artist_257_ascii_scalars", "reject"),
        ("artist_256_astral_scalars_1024_bytes", "accept"),
        ("duration_0", "reject"),
        ("duration_1", "accept"),
        ("duration_86400", "accept"),
        ("duration_86401", "reject"),
        ("artist_nel_only", "reject"),
        ("artist_bom_only_not_white_space", "accept"),
        ("artist_lone_high_surrogate", "reject"),
        ("mbid_simple_no_hyphens", "reject"),
        ("input_unknown_field", "reject"),
        ("record_unknown_field_ignored", "accept"),
    ] {
        assert_eq!(verdict(id), expected, "oracle verdict for {id}");
    }

    json!({
        "description": "Rust oracle validation verdicts. Parse `json` as the request/record body. kind scrobbleInput = the Rust POST /scrobbles path: ScrobbleInput::from_json, then listenedAt canonicalized to UTC with 9 fractional digits and Z (crates/server/src/http/scrobbles/create.rs, before the input digest), then into_record (local SPA input; unknown fields rejected; output is the record that path publishes, createdAt = receipt time); scrobbleRecord = ScrobbleRecord::from_json (remote record; unknown fields ignored; remote spelling kept); followRecord = FollowRecord::from_json; followSubject = FollowRecord::new(subject). Every Rust ValidationError has code invalid_field plus the field name; stage json means serde_json itself refused the document.",
        "source": SOURCE,
        "namespacePrefix": FIXTURE_PREFIX,
        "receiptTime": RECEIPT,
        "notes": [
            "Scalar (256) and byte (1024) limits are checked on the raw value before trimming; trimming uses Unicode White_Space (Rust str::trim): U+0085 is trimmed, U+FEFF/U+200B/U+001F/U+180E are not.",
            "Because a Unicode scalar is at most 4 UTF-8 bytes, 256 scalars can never exceed 1024 bytes; the byte limit is only reachable together with the scalar limit.",
            "The +300 s bound is inclusive at nanosecond precision: digits beyond the ninth fractional digit at exactly receipt+300 s reject when nonzero."
        ],
        "vectors": rendered,
    })
}

// ---------------------------------------------------------------------------------------
// timestamps.json
// ---------------------------------------------------------------------------------------

fn epoch_ns(value: DateTime<Utc>) -> String {
    (i128::from(value.timestamp()) * 1_000_000_000 + i128::from(value.timestamp_subsec_nanos()))
        .to_string()
}

fn timestamps() -> Value {
    let receipt = receipt();
    let inputs = [
        "2026-01-15T12:00:00Z",
        "2026-01-15T12:00:00+00:00",
        "2026-01-15T12:00:00.0Z",
        "2026-01-15T12:00:00.5Z",
        "2026-01-15T12:00:00.123Z",
        "2026-01-15T12:00:00.123456Z",
        "2026-01-15T12:00:00.123456789Z",
        "2026-01-15T12:00:00.1234567891Z",
        "2026-01-15T12:00:00.000000001Z",
        "2026-01-15T11:59:59.999999999Z",
        "2026-01-15T12:05:00Z",
        "2026-01-15T12:05:00.000000001Z",
        "2026-01-15T11:00:00Z",
        "2026-01-14T11:00:00Z",
        "2026-01-08T12:00:00Z",
        "2025-12-16T12:00:00Z",
        "2025-01-15T12:00:00Z",
        "2025-01-14T11:00:00Z",
        "2024-02-29T23:59:59.999Z",
        "2000-01-01T00:00:00Z",
        "1999-12-31T23:59:59Z",
        "1970-01-01T00:00:00Z",
        "1970-01-01T00:00:00.000000001Z",
        "1969-12-31T23:59:59Z",
        "2026-01-15T12:00:00-00:00",
        "2026-01-15T13:00:00+01:00",
        "2026-01-15t12:00:00Z",
        "2026-01-15T12:00:00z",
        "2026-01-15 12:00:00Z",
        "2026-01-15T12:00Z",
        "2016-12-31T23:59:60Z",
        "2026-13-01T00:00:00Z",
        "20260115T120000Z",
    ];
    let entries: Vec<Value> = inputs
        .iter()
        .map(
            |input| match validate_timestamp("listenedAt", input, receipt) {
                Ok(instant) => {
                    let storage =
                        CursorPosition::new(*input, "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/c/r")
                            .expect("accepted timestamps canonicalize")
                            .timestamp;
                    assert_eq!(
                        storage.len(),
                        30,
                        "storage form is 30 characters: {storage}"
                    );
                    assert_eq!(at(&storage), instant, "storage form round-trips");
                    json!({
                        "input": input,
                        "accepted": true,
                        "error": Value::Null,
                        "epochNs": epoch_ns(instant),
                        "storage": storage,
                        "dto": storage,
                    })
                }
                Err(error) => json!({
                    "input": input,
                    "accepted": false,
                    "error": error_json(&error),
                    "epochNs": Value::Null,
                    "storage": Value::Null,
                    "dto": Value::Null,
                }),
            },
        )
        .collect();

    // The record createdAt written by the SPA/local writer renders the receipt instant with
    // chrono SecondsFormat::AutoSi (shortest of 0/3/6/9 fractional digits).
    let renders: Vec<Value> = [
        "2026-01-15T12:00:00Z",
        "2026-01-15T12:00:00.5Z",
        "2026-01-15T12:00:00.123Z",
        "2026-01-15T12:00:00.1234Z",
        "2026-01-15T12:00:00.123456Z",
        "2026-01-15T12:00:00.1234567Z",
        "2026-01-15T12:00:00.123456789Z",
        "2026-01-15T12:00:00.000000001Z",
        "1970-01-01T00:00:00Z",
    ]
    .iter()
    .map(|instant| {
        let created_at = FollowRecord::new(BOB, &namespace(), at(instant))
            .expect("follow record")
            .created_at;
        json!({"receiptInstant": instant, "epochNs": epoch_ns(at(instant)), "recordCreatedAt": created_at})
    })
    .collect();

    json!({
        "description": "RFC 3339 input -> Rust validate_timestamp verdict (receipt 2026-01-15T12:00:00Z, listenedAt bounds) -> storage form (30-character YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ, chrono SecondsFormat::Nanos, the canonicalizer shared by cursor.rs and storage) -> DTO render. Rust DTOs serialize the stored column verbatim, so dto equals storage for every row-derived timestamp (listenedAt, createdAt, indexedAt, cursor asOf, statistics asOf).",
        "source": SOURCE,
        "receiptTime": RECEIPT,
        "entries": entries,
        "recordCreatedAtRenders": renders,
    })
}

// ---------------------------------------------------------------------------------------
// follow_rkeys.json
// ---------------------------------------------------------------------------------------

fn follow_rkeys() -> Value {
    let subjects = [
        ALICE,
        BOB,
        CAROL,
        "did:web:example.com",
        "did:web:localhost%3A8080",
        "did:plc:z72i7hdynmk6r22z27h6tvur",
        "did:example:abc:def",
        "did:plc:BBBBBBBBBBBBBBBBBBBBBBBB",
        "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb ",
        "did:plc:",
        "bob.test",
        "",
    ];
    let entries: Vec<Value> = subjects
        .iter()
        .map(|subject| match follow_rkey(subject) {
            Ok(rkey) => {
                assert_eq!(rkey.len(), 65);
                assert!(validate_did_syntax(subject).is_ok());
                json!({"subject": subject, "rkey": rkey, "error": Value::Null})
            }
            Err(error) => {
                json!({"subject": subject, "rkey": Value::Null, "error": error_json(&error)})
            }
        })
        .collect();
    json!({
        "description": "Rust follow_rkey: 'f' + lowercase hex SHA-256 of the exact subject DID bytes (no normalization), after DID syntax validation.",
        "source": SOURCE,
        "entries": entries,
    })
}

// ---------------------------------------------------------------------------------------
// cursors.json
// ---------------------------------------------------------------------------------------

type HmacSha256 = Hmac<Sha256>;

fn primary_key() -> Vec<u8> {
    (0_u8..32).collect()
}

fn other_key() -> Vec<u8> {
    vec![0x41; 32]
}

fn derive(application_key: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(application_key).unwrap();
    mac.update(CURSOR_KEY_CONTEXT);
    mac.finalize().into_bytes().to_vec()
}

fn sign_payload(derived: &[u8], payload: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(derived).unwrap();
    mac.update(payload);
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

fn binding_json(binding: &CursorBinding) -> Value {
    serde_json::to_value(binding).unwrap()
}

fn uri(owner: &str, rkey: &str) -> String {
    format!("at://{owner}/{FIXTURE_PREFIX}.scrobble/{rkey}")
}

fn cursor_error(error: CursorError) -> &'static str {
    match error {
        CursorError::InvalidCursor => "invalid_cursor",
        CursorError::InvalidKey => "invalid_key",
    }
}

fn cursors() -> Value {
    let codec = CursorCodec::from_application_key(&primary_key()).unwrap();
    let other = CursorCodec::from_application_key(&other_key()).unwrap();
    let derived = derive(&primary_key());

    let position = |timestamp: &str, uri: String| CursorPosition::new(timestamp, uri).unwrap();
    let r07 = || position("2026-01-15T11:00:00Z", uri(ALICE, "r07"));
    let r01 = || position("2026-01-15T11:00:00Z", uri(ALICE, "r01"));
    let r03 = || position("2026-01-08T12:00:00Z", uri(ALICE, "r03"));
    let r09 = || position("2026-01-15T11:30:00Z", uri(BOB, "r09"));
    let r10 = || position("2026-01-15T11:15:00Z", uri(CAROL, "r10"));
    let follow_uri = |actor: &str, subject: &str| {
        format!(
            "at://{actor}/{FIXTURE_PREFIX}.follow/{}",
            follow_rkey(subject).unwrap()
        )
    };

    let cases: Vec<(&str, PageCursor)> = vec![
        (
            "history_alice_page1",
            PageCursor::new(CursorBinding::history(ALICE), r07(), r01(), RECEIPT).unwrap(),
        ),
        (
            "feed_global_page1",
            PageCursor::new(CursorBinding::global_feed(), r09(), r10(), RECEIPT).unwrap(),
        ),
        (
            "feed_following_alice_page1",
            PageCursor::new(CursorBinding::following_feed(ALICE), r09(), r09(), RECEIPT).unwrap(),
        ),
        (
            "following_alice_page1",
            PageCursor::new(
                CursorBinding::following(ALICE),
                position("2025-01-01T00:00:00Z", follow_uri(ALICE, BOB)),
                position("2025-01-01T00:00:00Z", follow_uri(ALICE, BOB)),
                RECEIPT,
            )
            .unwrap(),
        ),
        (
            "followers_bob_page1",
            PageCursor::new(
                CursorBinding::followers(BOB),
                position("2025-01-01T00:00:00Z", follow_uri(ALICE, BOB)),
                position("2025-01-01T00:00:00Z", follow_uri(ALICE, BOB)),
                RECEIPT,
            )
            .unwrap(),
        ),
        (
            "history_alice_nanosecond_tuple",
            PageCursor::new(
                CursorBinding::history(ALICE),
                position("2026-01-15T11:59:59.999999999Z", uri(ALICE, "r20")),
                position("2026-01-15T11:59:59.000000001Z", uri(ALICE, "r21")),
                "2026-01-15T12:00:00.5Z",
            )
            .unwrap(),
        ),
    ];

    let mut valid = Vec::new();
    let mut tokens = std::collections::BTreeMap::new();
    for (id, cursor) in &cases {
        let token = codec.encode(cursor).unwrap();
        let (payload_b64, _) = token.split_once('.').unwrap();
        let payload = URL_SAFE_NO_PAD.decode(payload_b64).unwrap();
        // The locally derived key must reproduce the production token byte for byte.
        assert_eq!(
            sign_payload(&derived, &payload),
            token,
            "derived cursor key matches production"
        );
        let decoded = codec.decode(&token, &cursor.binding).unwrap();
        assert_eq!(&decoded, cursor);
        valid.push(json!({
            "id": id,
            "key": "primary",
            "binding": binding_json(&cursor.binding),
            "upper": serde_json::to_value(&cursor.upper).unwrap(),
            "last": serde_json::to_value(&cursor.last).unwrap(),
            "asOf": cursor.as_of,
            "payloadJson": String::from_utf8(payload).unwrap(),
            "token": token,
            "decoded": serde_json::to_value(&decoded).unwrap(),
        }));
        tokens.insert(*id, token);
    }

    // Canonicalization: equivalent UTC spellings produce the identical token.
    let alt = PageCursor::new(
        CursorBinding::history(ALICE),
        position("2026-01-15T11:00:00.000+00:00", uri(ALICE, "r07")),
        position("2026-01-15T11:00:00+00:00", uri(ALICE, "r01")),
        "2026-01-15T12:00:00.000000000+00:00",
    )
    .unwrap();
    let alt_token = codec.encode(&alt).unwrap();
    assert_eq!(&alt_token, &tokens["history_alice_page1"]);

    // Advancing keeps binding, upper anchor and asOf.
    let page1 = codec
        .decode(
            &tokens["history_alice_page1"],
            &CursorBinding::history(ALICE),
        )
        .unwrap();
    let advanced = page1.advance(r03()).unwrap();
    let advanced_token = codec.encode(&advanced).unwrap();
    let advance_rejected = page1.advance(r07()).map(|_| ()).map_err(cursor_error);

    let base = tokens["history_alice_page1"].clone();
    let (base_payload_b64, base_sig_b64) = base.split_once('.').unwrap();
    let base_payload = URL_SAFE_NO_PAD.decode(base_payload_b64).unwrap();
    let base_sig = URL_SAFE_NO_PAD.decode(base_sig_b64).unwrap();
    let payload_text = String::from_utf8(base_payload.clone()).unwrap();

    let flip_payload = {
        let mut bytes = base_payload.clone();
        bytes[10] ^= 0x01;
        format!("{}.{}", URL_SAFE_NO_PAD.encode(bytes), base_sig_b64)
    };
    let flip_signature = {
        let mut bytes = base_sig.clone();
        bytes[0] ^= 0x01;
        format!("{}.{}", base_payload_b64, URL_SAFE_NO_PAD.encode(bytes))
    };
    let forged = |text: String| sign_payload(&derived, text.as_bytes());
    let version_two = forged(payload_text.replacen("\"version\":1", "\"version\":2", 1));
    let version_zero = forged(payload_text.replacen("\"version\":1", "\"version\":0", 1));
    let unknown_field = forged(payload_text.replacen("{", "{\"extra\":true,", 1));
    let last_above_upper = forged(payload_text.replacen(
        "\"last\":{\"timestamp\":\"2026-01-15T11:00:00.000000000Z\"",
        "\"last\":{\"timestamp\":\"2026-01-15T11:30:00.000000000Z\"",
        1,
    ));
    let non_utc = forged(payload_text.replacen(
        "\"asOf\":\"2026-01-15T12:00:00.000000000Z\"",
        "\"asOf\":\"2026-01-15T13:00:00+01:00\"",
        1,
    ));
    let not_at_uri = forged(payload_text.replace("at://", "https://"));
    let binding_swapped = forged(payload_text.replacen(ALICE, BOB, 1));
    assert_ne!(last_above_upper, base);
    assert_ne!(non_utc, base);
    // Control: the forged path reproduces the genuine token when nothing is changed.
    assert_eq!(forged(payload_text.clone()), base);

    let long_token = format!("{}.{}", "A".repeat(32_769), base_sig_b64);
    let history_alice = CursorBinding::history(ALICE);
    let tampered_specs: Vec<(&str, String, &str, CursorBinding, &str)> = vec![
        (
            "payload_one_bit_flip",
            flip_payload,
            "primary",
            history_alice.clone(),
            "Flip bit 0 of decoded payload byte 10; signature unchanged.",
        ),
        (
            "signature_one_bit_flip",
            flip_signature,
            "primary",
            history_alice.clone(),
            "Flip bit 0 of the first HMAC byte.",
        ),
        (
            "wrong_application_key",
            base.clone(),
            "other",
            history_alice.clone(),
            "Genuine token decoded with a different application key.",
        ),
        (
            "wrong_did_binding",
            base.clone(),
            "primary",
            CursorBinding::history(BOB),
            "History token for Alice presented on Bob's history.",
        ),
        (
            "wrong_query_binding",
            base.clone(),
            "primary",
            CursorBinding::following(ALICE),
            "History token presented on the following list.",
        ),
        (
            "global_token_on_following_feed",
            tokens["feed_global_page1"].clone(),
            "primary",
            CursorBinding::following_feed(ALICE),
            "Global feed token presented with scope=following.",
        ),
        (
            "following_feed_wrong_viewer",
            tokens["feed_following_alice_page1"].clone(),
            "primary",
            CursorBinding::following_feed(BOB),
            "Following feed token for viewer Alice presented by viewer Bob.",
        ),
        (
            "following_token_on_followers",
            tokens["following_alice_page1"].clone(),
            "primary",
            CursorBinding::followers(ALICE),
            "Following-list token presented on the followers list.",
        ),
        (
            "unsupported_version_2",
            version_two,
            "primary",
            history_alice.clone(),
            "Correctly signed payload with version 2.",
        ),
        (
            "unsupported_version_0",
            version_zero,
            "primary",
            history_alice.clone(),
            "Correctly signed payload with version 0.",
        ),
        (
            "signed_unknown_field",
            unknown_field,
            "primary",
            history_alice.clone(),
            "Correctly signed payload with an extra field (deny_unknown_fields).",
        ),
        (
            "signed_last_above_upper",
            last_above_upper,
            "primary",
            history_alice.clone(),
            "Correctly signed payload whose last tuple is above the upper anchor.",
        ),
        (
            "signed_non_utc_as_of",
            non_utc,
            "primary",
            history_alice.clone(),
            "Correctly signed payload with a +01:00 asOf.",
        ),
        (
            "signed_non_at_uri",
            not_at_uri,
            "primary",
            history_alice.clone(),
            "Correctly signed payload whose URIs are not at:// URIs.",
        ),
        (
            "signed_binding_swapped_did",
            binding_swapped,
            "primary",
            history_alice.clone(),
            "Correctly signed payload bound to Bob, presented on Alice's history.",
        ),
        (
            "padding_appended",
            format!("{base}="),
            "primary",
            history_alice.clone(),
            "Base64 padding is not accepted.",
        ),
        (
            "payload_padding",
            format!("{}=.{}", base_payload_b64, base_sig_b64),
            "primary",
            history_alice.clone(),
            "Padding inside the payload segment.",
        ),
        (
            "missing_separator",
            base.replace('.', ""),
            "primary",
            history_alice.clone(),
            "No '.' separator.",
        ),
        (
            "extra_separator",
            format!("{base}.AAAA"),
            "primary",
            history_alice.clone(),
            "A third segment.",
        ),
        (
            "signature_truncated",
            base[..base.len() - 2].to_string(),
            "primary",
            history_alice.clone(),
            "Signature shorter than 32 bytes.",
        ),
        (
            "payload_invalid_base64_char",
            format!("*{}", &base[1..]),
            "primary",
            history_alice.clone(),
            "Character outside the base64url alphabet.",
        ),
        (
            "empty_token",
            String::new(),
            "primary",
            history_alice.clone(),
            "Empty token.",
        ),
        (
            "only_separator",
            ".".into(),
            "primary",
            history_alice.clone(),
            "Empty payload and signature.",
        ),
        (
            "oversized_token",
            long_token,
            "primary",
            history_alice.clone(),
            "Token longer than 32768 bytes.",
        ),
    ];
    let tampered: Vec<Value> = tampered_specs
        .into_iter()
        .map(|(id, token, key, binding, description)| {
            let decoder = if key == "primary" { &codec } else { &other };
            let error = decoder
                .decode(&token, &binding)
                .map(|_| ())
                .expect_err("tampered cursor must not decode");
            json!({
                "id": id,
                "description": description,
                "key": key,
                "binding": binding_json(&binding),
                "token": token,
                "expectedError": cursor_error(error),
            })
        })
        .collect();

    let short_key = CursorCodec::from_application_key(&[7_u8; 31])
        .map(|_| ())
        .map_err(cursor_error);

    json!({
        "description": "Rust CursorCodec golden tokens. Token = base64url(JSON payload) '.' base64url(HMAC-SHA256(derivedKey, payload)), no padding; derivedKey = HMAC-SHA256(applicationKey, 'atmusic:cursor:hmac-sha256:v1'). Every tampered token fails decode with invalid_cursor (one public error, HTTP 400). Key material here is fixed and test-only.",
        "source": SOURCE,
        "keys": {
            "primary": {"applicationKeyHex": hex(&primary_key()), "derivedKeyHex": hex(&derived)},
            "other": {"applicationKeyHex": hex(&other_key()), "derivedKeyHex": hex(&derive(&other_key()))},
            "context": String::from_utf8(CURSOR_KEY_CONTEXT.to_vec()).unwrap(),
        },
        "valid": valid,
        "canonicalization": {
            "description": "Equivalent UTC spellings (+00:00, fewer fractional digits) normalize to the nanosecond Z form and yield the identical token.",
            "upper": {"timestamp": "2026-01-15T11:00:00.000+00:00", "uri": uri(ALICE, "r07")},
            "last": {"timestamp": "2026-01-15T11:00:00+00:00", "uri": uri(ALICE, "r01")},
            "asOf": "2026-01-15T12:00:00.000000000+00:00",
            "token": alt_token,
            "equalsValidId": "history_alice_page1",
        },
        "advance": {
            "fromId": "history_alice_page1",
            "newLast": serde_json::to_value(r03()).unwrap(),
            "token": advanced_token,
            "decoded": serde_json::to_value(&advanced).unwrap(),
            "advanceToTupleNotBelowLast": {"newLast": serde_json::to_value(r07()).unwrap(), "expectedError": advance_rejected.expect_err("advance must reject")},
        },
        "tampered": tampered,
        "invalidKeys": [
            {"applicationKeyHex": hex(&[7_u8; 31]), "expectedError": short_key.expect_err("short key must be rejected")},
        ],
    })
}
