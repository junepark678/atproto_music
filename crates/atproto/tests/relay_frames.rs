use atmusic_atproto::sync::frames::{
    Action, BackfillReason, FrameError, MAX_FRAME_BYTES, RelayEvent, decode_frame,
};
use atmusic_core::namespace::{FIXTURE_PREFIX, Namespace};
use ciborium::value::Value;
use ipld_core::cid::{Cid, multihash::Multihash};

fn text(s: &str) -> Value {
    Value::Text(s.into())
}
fn map(fields: Vec<(&str, Value)>) -> Value {
    Value::Map(fields.into_iter().map(|(k, v)| (text(k), v)).collect())
}
fn cid() -> Value {
    let cid = Cid::new_v1(0x71, Multihash::wrap(0x12, &[1; 32]).unwrap());
    let mut bytes = vec![0];
    bytes.extend(cid.to_bytes());
    Value::Tag(42, Box::new(Value::Bytes(bytes)))
}
fn operation(collection: &str, rkey: &str) -> Value {
    map(vec![
        ("action", text("create")),
        ("path", text(&format!("{collection}/{rkey}"))),
        ("cid", cid()),
    ])
}
fn commit(ops: Vec<Value>, too_big: bool) -> Value {
    map(vec![
        ("seq", 1.into()),
        ("repo", text("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")),
        ("rev", text("3m4zm2ufr2222")),
        ("commit", cid()),
        ("time", text("2026-01-15T12:00:00Z")),
        ("blocks", Value::Bytes(vec![])),
        ("ops", Value::Array(ops)),
        ("tooBig", Value::Bool(too_big)),
    ])
}
fn frame(kind: &str, body: Value) -> Vec<u8> {
    let mut bytes = vec![];
    ciborium::ser::into_writer(&map(vec![("op", 1.into()), ("t", text(kind))]), &mut bytes)
        .unwrap();
    ciborium::ser::into_writer(&body, &mut bytes).unwrap();
    bytes
}
fn namespace() -> Namespace {
    Namespace::new(FIXTURE_PREFIX).unwrap()
}
fn valid_frame() -> Vec<u8> {
    frame(
        "#commit",
        commit(
            vec![operation("com.example.atmusic.scrobble", "r01")],
            false,
        ),
    )
}

#[test]
fn collection_filter() {
    let decoded = decode_frame(
        &frame(
            "#commit",
            commit(
                vec![
                    operation("com.example.atmusic.scrobble", "r01"),
                    operation("com.example.atmusic.follow", "r02"),
                    operation("app.bsky.feed.post", "r03"),
                ],
                false,
            ),
        ),
        &namespace(),
    )
    .unwrap();
    let RelayEvent::Commit(event) = decoded else {
        panic!("expected commit candidates")
    };
    assert_eq!(event.operations.len(), 2);
    assert_eq!(event.operations[0].path, "com.example.atmusic.scrobble/r01");
    assert_eq!(event.operations[1].path, "com.example.atmusic.follow/r02");
    assert!(
        event
            .operations
            .iter()
            .all(|op| op.action == Action::Create)
    );
}

#[test]
fn frame_limits() {
    assert_eq!(
        decode_frame(&[0xff, 0xff], &namespace()),
        Err(FrameError::InvalidCbor)
    );
    assert_eq!(
        decode_frame(&vec![0; MAX_FRAME_BYTES + 1], &namespace()),
        Err(FrameError::FrameTooLarge)
    );
    let too_many: Vec<_> = (0..10_001)
        .map(|i| operation("app.bsky.feed.post", &format!("r{i}")))
        .collect();
    assert_eq!(
        decode_frame(&frame("#commit", commit(too_many, false)), &namespace()),
        Err(FrameError::TooManyOperations)
    );
    // The decoder carries no poisoned state after rejection; a worker can reconnect and continue.
    let RelayEvent::Commit(event) = decode_frame(&valid_frame(), &namespace()).unwrap() else {
        panic!("next frame must decode")
    };
    assert_eq!(event.sequence, 1);
    assert_eq!(event.operations.len(), 1);
}

#[test]
fn event_types() {
    let identity = frame(
        "#identity",
        map(vec![
            ("seq", 2.into()),
            ("did", text("did:web:alice.test")),
            ("time", text("2026-01-15T12:00:00Z")),
        ]),
    );
    assert!(matches!(
        decode_frame(&identity, &namespace()).unwrap(),
        RelayEvent::Identity { sequence: 2, .. }
    ));
    let account = frame(
        "#account",
        map(vec![
            ("seq", 3.into()),
            ("did", text("did:web:alice.test")),
            ("time", text("2026-01-15T12:00:00Z")),
            ("active", Value::Bool(false)),
            ("status", text("deactivated")),
        ]),
    );
    assert!(matches!(
        decode_frame(&account, &namespace()).unwrap(),
        RelayEvent::Account { active: false, .. }
    ));
    assert!(matches!(
        decode_frame(&frame("#commit", commit(vec![], true)), &namespace()).unwrap(),
        RelayEvent::Backfill {
            reason: BackfillReason::TooBig,
            ..
        }
    ));
    let sync = frame(
        "#sync",
        map(vec![
            ("seq", 4.into()),
            ("did", text("did:web:alice.test")),
            ("rev", text("3m4zm2ufr2222")),
        ]),
    );
    assert!(matches!(
        decode_frame(&sync, &namespace()).unwrap(),
        RelayEvent::Backfill {
            reason: BackfillReason::Sync,
            ..
        }
    ));
    let legacy = frame(
        "#tooBig",
        map(vec![
            ("seq", 5.into()),
            ("repo", text("did:web:alice.test")),
        ]),
    );
    assert!(matches!(
        decode_frame(&legacy, &namespace()).unwrap(),
        RelayEvent::Backfill {
            reason: BackfillReason::TooBig,
            ..
        }
    ));
}

#[test]
fn malformed_frames_never_become_commits() {
    let mut trailing = valid_frame();
    trailing.push(0);
    assert_eq!(
        decode_frame(&trailing, &namespace()),
        Err(FrameError::InvalidCbor)
    );
    let mut deep = vec![];
    ciborium::ser::into_writer(
        &map(vec![("op", 1.into()), ("t", text("#future"))]),
        &mut deep,
    )
    .unwrap();
    deep.extend(std::iter::repeat_n(0x81, 100));
    deep.push(0);
    assert_eq!(
        decode_frame(&deep, &namespace()),
        Err(FrameError::InvalidCbor)
    );
    let mut invalid = operation("com.example.atmusic.scrobble", "r01");
    if let Value::Map(fields) = &mut invalid {
        fields.push((text("cid"), Value::Null));
    }
    assert!(
        decode_frame(
            &frame("#commit", commit(vec![invalid], false)),
            &namespace()
        )
        .is_err()
    );
    let mut trailing_cid = operation("com.example.atmusic.scrobble", "r01");
    let Value::Map(fields) = &mut trailing_cid else {
        unreachable!()
    };
    let (_, Value::Tag(42, value)) = fields
        .iter_mut()
        .find(|(field, _)| field == &text("cid"))
        .unwrap()
    else {
        unreachable!()
    };
    let Value::Bytes(bytes) = value.as_mut() else {
        unreachable!()
    };
    bytes.push(0);
    assert_eq!(
        decode_frame(
            &frame("#commit", commit(vec![trailing_cid], false)),
            &namespace()
        ),
        Err(FrameError::InvalidField("cid"))
    );
    assert!(matches!(
        decode_frame(&frame("#future", map(vec![])), &namespace()).unwrap(),
        RelayEvent::Ignored { .. }
    ));
}
