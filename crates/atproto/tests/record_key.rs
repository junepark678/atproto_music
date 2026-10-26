use atmusic_atproto::pds::record_key::RecordKeyAllocator;
use atrium_api::types::string::Tid;
#[test]
fn monotonic_valid_tid() {
    let allocator = RecordKeyAllocator::default();
    let now = chrono::DateTime::parse_from_rfc3339("2026-01-15T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let mut previous = String::new();
    for _ in 0..100 {
        let key = allocator.allocate(now).unwrap();
        Tid::new(key.clone()).unwrap();
        assert!(key > previous);
        previous = key;
    }
}
