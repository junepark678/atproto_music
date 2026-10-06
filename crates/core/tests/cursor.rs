use std::{cmp::Ordering, collections::HashSet};

use atmusic_core::cursor::{CursorBinding, CursorCodec, CursorError, CursorPosition, PageCursor};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

const ALICE: &str = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: &str = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const AS_OF: &str = "2026-01-15T12:00:00Z";
const KEY: &[u8; 32] = b"cursor-test-application-secret-3";

fn codec() -> CursorCodec {
    CursorCodec::from_application_key(KEY).unwrap()
}

fn position(rkey: &str, timestamp: &str) -> CursorPosition {
    CursorPosition::new(
        timestamp,
        format!("at://{ALICE}/com.example.atmusic.scrobble/{rkey}"),
    )
    .unwrap()
}

fn cursor(binding: CursorBinding) -> PageCursor {
    PageCursor::new(
        binding,
        position("r07", "2026-01-15T11:00:00Z"),
        position("r01", "2026-01-15T11:00:00Z"),
        AS_OF,
    )
    .unwrap()
}

fn payload(token: &str) -> Value {
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(token.split_once('.').unwrap().0)
            .unwrap(),
    )
    .unwrap()
}

// Deliberately generate malformed but authentic tokens independently of the codec.
fn sign_payload(value: &Value) -> String {
    let mut derivation = Hmac::<Sha256>::new_from_slice(KEY).unwrap();
    derivation.update(b"atmusic:cursor:hmac-sha256:v1");
    let key = derivation.finalize().into_bytes();
    let bytes = serde_json::to_vec(value).unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
    mac.update(&bytes);
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(bytes),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

#[test]
fn roundtrip_and_key_separation() {
    let expected = cursor(CursorBinding::history(ALICE));
    let token = codec().encode(&expected).unwrap();
    assert_eq!(codec().decode(&token, &expected.binding).unwrap(), expected);
    assert!(!token.contains('='));
    let (encoded_payload, encoded_signature) = token.split_once('.').unwrap();
    let bytes = URL_SAFE_NO_PAD.decode(encoded_payload).unwrap();
    assert!(!bytes.windows(KEY.len()).any(|window| window == KEY));
    let mut application_mac = Hmac::<Sha256>::new_from_slice(KEY).unwrap();
    application_mac.update(&bytes);
    assert_ne!(
        application_mac.finalize().into_bytes().as_slice(),
        URL_SAFE_NO_PAD.decode(encoded_signature).unwrap()
    );
    let other_key = CursorCodec::from_application_key(&[42; 32]).unwrap();
    assert_eq!(
        other_key.decode(&token, &expected.binding),
        Err(CursorError::InvalidCursor)
    );
    assert!(matches!(
        CursorCodec::from_application_key(&[1; 31]),
        Err(CursorError::InvalidKey)
    ));
}

#[test]
fn cursor_binding() {
    let expected = cursor(CursorBinding::history(ALICE));
    let token = codec().encode(&expected).unwrap();
    let (encoded_payload, signature) = token.split_once('.').unwrap();
    let mut bytes = URL_SAFE_NO_PAD.decode(encoded_payload).unwrap();
    bytes[0] ^= 1;
    let tampered = format!("{}.{}", URL_SAFE_NO_PAD.encode(bytes), signature);
    assert_eq!(
        codec().decode(&tampered, &expected.binding),
        Err(CursorError::InvalidCursor),
        "one-bit payload tamper"
    );
    let mut signature_bytes = URL_SAFE_NO_PAD.decode(signature).unwrap();
    signature_bytes[0] ^= 1;
    let tampered = format!(
        "{}.{}",
        encoded_payload,
        URL_SAFE_NO_PAD.encode(signature_bytes)
    );
    assert_eq!(
        codec().decode(&tampered, &expected.binding),
        Err(CursorError::InvalidCursor),
        "one-bit HMAC tamper"
    );
    for binding in [
        CursorBinding::history(BOB),
        CursorBinding::global_feed(),
        CursorBinding::following(ALICE),
        CursorBinding::followers(ALICE),
    ] {
        assert_eq!(
            codec().decode(&token, &binding),
            Err(CursorError::InvalidCursor),
            "wrong DID or query: {binding:?}"
        );
    }
    let private = cursor(CursorBinding::following_feed(ALICE));
    let private_token = codec().encode(&private).unwrap();
    for binding in [
        CursorBinding::following_feed(BOB),
        CursorBinding::global_feed(),
    ] {
        assert_eq!(
            codec().decode(&private_token, &binding),
            Err(CursorError::InvalidCursor),
            "wrong viewer or scope: {binding:?}"
        );
    }
    let mut unsupported = payload(&token);
    unsupported["version"] = json!(2);
    assert_eq!(
        codec().decode(&sign_payload(&unsupported), &expected.binding),
        Err(CursorError::InvalidCursor),
        "authentic unsupported version"
    );
}

#[test]
fn malformed_cursor_and_signed_payload() {
    let binding = CursorBinding::history(ALICE);
    let token = codec().encode(&cursor(binding.clone())).unwrap();
    for invalid in [
        "".to_owned(),
        "*invalid*.Zm9v".to_owned(),
        "e30.".to_owned(),
        format!("{token}.extra"),
        format!(" {token}"),
        format!("{token}="),
        "x".repeat(32_769),
    ] {
        assert_eq!(
            codec().decode(&invalid, &binding),
            Err(CursorError::InvalidCursor)
        );
    }
    let original = payload(&token);
    for invalid in [
        {
            let mut v = original.clone();
            v["last"]["timestamp"] = json!("2026-01-15T11:01:00Z");
            v
        },
        {
            let mut v = original.clone();
            v["asOf"] = json!("invalid");
            v
        },
        {
            let mut v = original.clone();
            v["upper"]["uri"] = json!("");
            v
        },
        {
            let mut v = original.clone();
            v["unexpected"] = json!(true);
            v
        },
        {
            let mut v = original.clone();
            v["binding"]["unexpected"] = json!(true);
            v
        },
        {
            let mut v = original.clone();
            v["binding"]["viewer"] = json!(ALICE);
            v
        },
    ] {
        assert_eq!(
            codec().decode(&sign_payload(&invalid), &binding),
            Err(CursorError::InvalidCursor),
            "malformed authentic payload: {invalid}"
        );
    }
}

#[test]
fn equal_timestamp() {
    let r07 = position("r07", "2026-01-15T11:00:00Z");
    let r01 = position("r01", "2026-01-15T11:00:00.000000000+00:00");
    assert_eq!(r07.compare(&r01).unwrap(), Ordering::Greater);
    let first = PageCursor::new(
        CursorBinding::history(ALICE),
        r07.clone(),
        r07.clone(),
        AS_OF,
    )
    .unwrap();
    let resumed = codec()
        .decode(&codec().encode(&first).unwrap(), &first.binding)
        .unwrap();
    assert!(!resumed.contains(&r07).unwrap());
    assert!(resumed.contains(&r01).unwrap());
    let second = resumed.advance(r01.clone()).unwrap();
    assert!(!second.contains(&r01).unwrap());
    assert!(!second.contains(&r07).unwrap());
    assert_eq!(second.upper, r07);
    assert_eq!(second.as_of, "2026-01-15T12:00:00.000000000Z");
}

fn alice_rows() -> Vec<CursorPosition> {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/read_models.json")).unwrap();
    let mut rows: Vec<_> = fixture["scrobbles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["owner"] == ALICE && row["state"] == "confirmed")
        .map(|row| {
            CursorPosition::new(
                row["record"]["listenedAt"].as_str().unwrap(),
                row["uri"].as_str().unwrap(),
            )
            .unwrap()
        })
        .collect();
    rows.sort_by(|left, right| right.compare(left).unwrap());
    rows
}

#[test]
fn complete_ordered_codec_traversal() {
    let rows = alice_rows();
    let mut cursor = None;
    let mut uris = Vec::new();
    loop {
        let page: Vec<_> = rows
            .iter()
            .filter(|row| {
                cursor
                    .as_ref()
                    .is_none_or(|cursor: &PageCursor| cursor.contains(row).unwrap())
            })
            .take(2)
            .cloned()
            .collect();
        if page.is_empty() {
            break;
        }
        uris.extend(page.iter().map(|row| row.uri.clone()));
        let next = if let Some(cursor) = cursor {
            cursor.advance(page.last().unwrap().clone()).unwrap()
        } else {
            PageCursor::new(
                CursorBinding::history(ALICE),
                page[0].clone(),
                page.last().unwrap().clone(),
                AS_OF,
            )
            .unwrap()
        };
        cursor = Some(
            codec()
                .decode(&codec().encode(&next).unwrap(), &next.binding)
                .unwrap(),
        );
    }
    let expected: Vec<_> = ["r07", "r01", "r02", "r03", "r04", "r05", "r06"]
        .iter()
        .map(|rkey| format!("at://{ALICE}/com.example.atmusic.scrobble/{rkey}"))
        .collect();
    assert_eq!(uris, expected);
    assert_eq!(uris.iter().collect::<HashSet<_>>().len(), uris.len());
}

#[test]
fn between_pages() {
    let mut rows = alice_rows();
    let boundary = PageCursor::new(
        CursorBinding::history(ALICE),
        rows[0].clone(),
        rows[1].clone(),
        AS_OF,
    )
    .unwrap();
    let boundary = codec()
        .decode(&codec().encode(&boundary).unwrap(), &boundary.binding)
        .unwrap();
    rows.retain(|row| !row.uri.ends_with("/r02"));
    rows.push(position("arrival", "2026-01-15T11:30:00Z"));
    rows.sort_by(|left, right| right.compare(left).unwrap());
    let resumed: Vec<_> = rows
        .iter()
        .filter(|row| boundary.contains(row).unwrap())
        .map(|row| row.uri.clone())
        .collect();
    let expected: Vec<_> = ["r03", "r04", "r05", "r06"]
        .iter()
        .map(|rkey| format!("at://{ALICE}/com.example.atmusic.scrobble/{rkey}"))
        .collect();
    assert_eq!(resumed, expected);
    assert_eq!(resumed.iter().collect::<HashSet<_>>().len(), resumed.len());
    assert!(
        rows[0].uri.ends_with("/arrival"),
        "fresh traversal sees the newer arrival"
    );
}

#[test]
fn current_record_update_visibility_and_timestamp_precision() {
    let boundary = cursor(CursorBinding::history(ALICE));
    assert!(
        boundary
            .contains(&position("r02", "2026-01-14T11:00:00Z"))
            .unwrap()
    );
    assert!(
        !boundary
            .contains(&position("r02", "2026-01-15T11:30:00Z"))
            .unwrap(),
        "unreturned record moved above anchor is omitted"
    );
    assert!(
        boundary
            .contains(&position("r07", "2026-01-13T11:00:00Z"))
            .unwrap(),
        "already returned record moved below last can recur; no snapshot claim"
    );
    let nanosecond = position("r01", "2026-01-15T11:00:00.000000001Z");
    let whole = position("r99", "2026-01-15T11:00:00Z");
    assert_eq!(nanosecond.compare(&whole).unwrap(), Ordering::Greater);
    assert!(CursorPosition::new("2026-01-15T11:00:00-00:00", "at://test/test/r01").is_err());
    assert!(CursorPosition::new("2026-01-15T11:00:00+01:00", "at://test/test/r01").is_err());
    assert!(CursorPosition::new("1969-12-31T23:59:59Z", "at://test/test/r01").is_err());
}
