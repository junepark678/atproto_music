PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL CHECK(typeof(version) = 'integer' AND version >= 1),
  name TEXT NOT NULL
);
INSERT INTO schema_migrations VALUES(1,'initial_workers_schema');
INSERT INTO schema_migrations VALUES(2,'node_schema');
INSERT INTO schema_migrations VALUES(3,'follow_proof_baseline');
INSERT INTO schema_migrations VALUES(4,'scrobble_delete_target_index');
INSERT INTO schema_migrations VALUES(5,'batch_listen_provenance');
INSERT INTO schema_migrations VALUES(6,'batch_outbox_recovery');
INSERT INTO schema_migrations VALUES(7,'batch_listen_removal_receipts');
INSERT INTO schema_migrations VALUES(8,'outbox_send_certainty');
INSERT INTO schema_migrations VALUES(9,'batch_removal_evidence');
INSERT INTO schema_migrations VALUES(10,'verified_listen_membership');
INSERT INTO schema_migrations VALUES(11,'removal_commit_fence');
INSERT INTO schema_migrations VALUES(12,'removal_completion_boundary');
INSERT INTO schema_migrations VALUES(13,'removal_reached');
INSERT INTO schema_migrations VALUES(14,'removal_send_pin');
INSERT INTO schema_migrations VALUES(15,'detailed_now_playing');
INSERT INTO schema_migrations VALUES(16,'musicbrainz_track_matches');
INSERT INTO schema_migrations VALUES(17,'musicbrainz_global_pacing');
INSERT INTO schema_migrations VALUES(18,'musicbrainz_seed_cursor');
INSERT INTO schema_migrations VALUES(19,'musicbrainz_love_revival_jobs');
INSERT INTO schema_migrations VALUES(20,'bounded_love_revival_scan');
INSERT INTO schema_migrations VALUES(21,'cover_art_cache_and_jobs');
INSERT INTO schema_migrations VALUES(22,'forward_admissions_and_love_provenance');
INSERT INTO schema_migrations VALUES(23,'forward_link_generations_and_health');
INSERT INTO schema_migrations VALUES(24,'linked_account_backfill_and_pull_state');
INSERT INTO schema_migrations VALUES(25,'forward_backfill_priority');
INSERT INTO schema_migrations VALUES(26,'forward_backfill_retry_state');
INSERT INTO schema_migrations VALUES(27,'linked_account_backfill_run_revision');
INSERT INTO schema_migrations VALUES(28,'bounded_link_backfill_progress_and_fairness');
INSERT INTO schema_migrations VALUES(29,'link_backfill_staged_membership');
INSERT INTO schema_migrations VALUES(30,'linked_service_pull_foundation');
INSERT INTO schema_migrations VALUES(31,'linked_pull_deletion_tombstones');
INSERT INTO schema_migrations VALUES(32,'linked_love_pull_cursor');
INSERT INTO schema_migrations VALUES(33,'linked_love_user_intent_fence');
INSERT INTO schema_migrations VALUES(34,'linked_pull_legacy_listen_second_recovery');
INSERT INTO schema_migrations VALUES(35,'linked_pull_persisted_poll_rounds');
INSERT INTO schema_migrations VALUES(36,'linked_listenbrainz_pull_round_guards');
INSERT INTO schema_migrations VALUES(37,'linked_pull_love_acceptance_admissions');
INSERT INTO schema_migrations VALUES(38,'love_delete_bridge_commit_revision');
INSERT INTO schema_migrations VALUES(39,'listenbrainz_delete_queue');
INSERT INTO schema_migrations VALUES(40,'listenbrainz_delete_lookup_progress');
INSERT INTO schema_migrations VALUES(41,'listenbrainz_delete_lookup_tie_fence');
INSERT INTO schema_migrations VALUES(42,'listenbrainz_delete_lookup_page_boundary');
INSERT INTO schema_migrations VALUES(43,'forward_love_key_heads');
INSERT INTO schema_migrations VALUES(44,'forward_love_lanes');
INSERT INTO schema_migrations VALUES(45,'forward_love_recording_history');
INSERT INTO schema_migrations VALUES(46,'forward_love_recording_targets');
INSERT INTO schema_migrations VALUES(47,'operations_record_target');
INSERT INTO schema_migrations VALUES(48,'live_admission_evidence');
INSERT INTO schema_migrations VALUES(49,'live_pending_removals');
INSERT INTO schema_migrations VALUES(50,'live_pending_removal_repair');
INSERT INTO schema_migrations VALUES(51,'live_pending_removal_bounds');
INSERT INTO schema_migrations VALUES(52,'a2_authorization_binding');
INSERT INTO schema_migrations VALUES(53,'a2_retention_epoch');
INSERT INTO schema_migrations VALUES(54,'love_import_bridges_source_class');
INSERT INTO schema_migrations VALUES(55,'link_coverage_receipts');
INSERT INTO schema_migrations VALUES(56,'link_love_coverage');
CREATE TABLE users (
      did TEXT PRIMARY KEY NOT NULL,
      handle TEXT,
      handle_checked_at_ms INTEGER,
      pds TEXT,
      joined_at TEXT NOT NULL,
      indexed_at TEXT,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
      account_status TEXT NOT NULL DEFAULT 'unknown' CHECK(account_status IN ('unknown','active','deactivated','takendown','suspended','deleted','desynchronized','throttled','not_found')),
      max_rev TEXT,
      indexing_state TEXT NOT NULL DEFAULT 'recovering' CHECK(indexing_state IN ('current','recovering','stale','suppressed')),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0),
      stats_version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stats_version) = 'integer' AND stats_version >= 0),
      last_snapshot_at_ms INTEGER,
      last_status_check_ms INTEGER,
      last_activity_ms INTEGER
    );
INSERT INTO users VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',NULL,NULL,NULL,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z',1,'active','3mchjvhag2522','current',1,0,NULL,NULL,1768478400000);
CREATE TABLE scrobbles (
      uri TEXT PRIMARY KEY NOT NULL,
      cid TEXT NOT NULL,
      did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
      rkey TEXT NOT NULL,
      revision TEXT NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      album TEXT,
      listened_at TEXT NOT NULL CHECK(length(listened_at) = 30 AND substr(listened_at, 30, 1) = 'Z'),
      created_at TEXT NOT NULL,
      duration_seconds INTEGER CHECK(duration_seconds BETWEEN 1 AND 86400),
      recording_mbid TEXT,
      indexed_at TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      track_key TEXT NOT NULL,
      album_key TEXT
    , album_artist TEXT, album_artist_key TEXT, track_number INTEGER, artist_mbids TEXT, release_mbid TEXT, release_group_mbid TEXT, isrc TEXT, submission_client TEXT, music_service TEXT, recording_msid TEXT, record_uri TEXT, listen_id TEXT);
CREATE TABLE follows (
      uri TEXT PRIMARY KEY NOT NULL,
      cid TEXT NOT NULL,
      actor TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      revision TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(length(created_at) = 30 AND substr(created_at, 30, 1) = 'Z'),
      indexed_at TEXT NOT NULL,
      CHECK(actor != subject)
    );
CREATE TABLE record_state (
      uri TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      collection TEXT NOT NULL,
      revision TEXT NOT NULL,
      cid TEXT,
      state TEXT NOT NULL CHECK(state IN ('present','absent','excluded')),
      reason TEXT,
      verified_at TEXT NOT NULL,
      CHECK(state = 'absent' OR cid IS NOT NULL),
      CHECK(state != 'excluded' OR reason IS NOT NULL)
    );
INSERT INTO record_state VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','com.example.atmusic.love','3mchjvhag2322','bafyreiciwpbu7j6hcypkmiqkc2nbbgbvromsio36lgfunhfchbdhboipta','present',NULL,'2026-01-15T12:00:00.000000000Z');
INSERT INTO record_state VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportlive001','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','com.example.atmusic.love','3mchjvhag2422','bafyreigthrbgexb5ilkwl7uzxfrddzhkvuzsri7pm3k7ksnhxyc3yabkc4','present',NULL,'2026-01-15T12:00:00.000000000Z');
INSERT INTO record_state VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','com.example.atmusic.love','3mchjvhag2522','bafyreia44yhnigwxpbzh4ypf7p7wubxmmmefwwd7h5zb6clclmmcpz4h5q','present',NULL,'2026-01-15T12:00:00.000000000Z');
CREATE TABLE suppression (
      did TEXT PRIMARY KEY NOT NULL,
      suppressed_at TEXT NOT NULL,
      settings_uri TEXT,
      settings_rev TEXT
    );
CREATE TABLE indexing_status (
      scope TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('current','recovering','stale','suppressed')),
      caught_up INTEGER NOT NULL DEFAULT 0 CHECK(caught_up IN (0,1)),
      last_indexed_at TEXT,
      lag_seconds INTEGER CHECK(lag_seconds >= 0)
    );
INSERT INTO indexing_status VALUES('global','recovering',0,'2026-01-15T12:00:00.000000000Z',NULL);
CREATE TABLE backfill_generation (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
      last_generation INTEGER NOT NULL CHECK(typeof(last_generation) = 'integer' AND last_generation >= 0)
    );
INSERT INTO backfill_generation VALUES(1,1);
CREATE TABLE repo_jobs (
      did TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('snapshot','status','identity')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed')),
      generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0),
      reason TEXT,
      head_rev TEXT,
      head_cid TEXT,
      frontier_json TEXT,
      restarts INTEGER NOT NULL DEFAULT 0 CHECK(restarts >= 0),
      reactivate INTEGER NOT NULL DEFAULT 0 CHECK(reactivate IN (0,1)),
      due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      failure_code TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,kind)
    );
CREATE TABLE ingest_checkpoint (
      stream TEXT PRIMARY KEY NOT NULL,
      cursor INTEGER CHECK(cursor >= 0),
      last_event_time_us INTEGER CHECK(last_event_time_us >= 0),
      connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0,1)),
      pending_gap INTEGER NOT NULL DEFAULT 1 CHECK(pending_gap IN (0,1)),
      gap_scan_after_did TEXT,
      mode TEXT CHECK(mode IN ('socket','pulse','off')),
      host_index INTEGER NOT NULL DEFAULT 0 CHECK(host_index >= 0),
      connected_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );
INSERT INTO ingest_checkpoint VALUES('jetstream',NULL,NULL,0,1,NULL,NULL,0,NULL,0);
CREATE TABLE hints (
      uri TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('jetstream','notify','reconcile')),
      priority INTEGER NOT NULL,
      hint_rev TEXT,
      receipt_time TEXT NOT NULL CHECK(length(receipt_time) = 30 AND substr(receipt_time, 30, 1) = 'Z'),
      due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      last_error TEXT
    , evidence_rev TEXT);
INSERT INTO hints VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','com.example.atmusic.love','3mchjvhag22jm','notify',0,NULL,'2026-01-15T12:00:00.000000000Z',1768478400000,0,NULL,NULL);
INSERT INTO hints VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','com.example.atmusic.love','3kimportoldreuse1','notify',0,NULL,'2026-01-15T12:00:00.000000000Z',1768478400000,0,NULL,NULL);
CREATE TABLE snapshot_blocks (
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY(did,cid)
    );
CREATE TABLE identity_cache (
      did TEXT PRIMARY KEY NOT NULL,
      doc_json TEXT,
      signing_key TEXT,
      pds TEXT,
      handle TEXT,
      fetched_at_ms INTEGER NOT NULL,
      neg_until_ms INTEGER
    );
CREATE TABLE verified_commits (
      did TEXT NOT NULL,
      commit_cid TEXT NOT NULL,
      rev TEXT NOT NULL,
      verified_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,commit_cid)
    );
CREATE TABLE host_backoff (
      host TEXT PRIMARY KEY NOT NULL,
      until_ms INTEGER NOT NULL
    );
CREATE TABLE admission (
      window_start_ms INTEGER PRIMARY KEY NOT NULL,
      admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted >= 0)
    );
CREATE TABLE timers (
      name TEXT PRIMARY KEY NOT NULL,
      due_at INTEGER NOT NULL
    );
INSERT INTO timers VALUES('drain',1768478400000);
CREATE TABLE stats_cache (
      did TEXT NOT NULL,
      win TEXT NOT NULL CHECK(win IN ('all','7d','30d','365d')),
      lim INTEGER NOT NULL CHECK(lim BETWEEN 1 AND 100),
      as_of TEXT NOT NULL,
      lower TEXT,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY(did,win,lim)
    );
CREATE TABLE counters (
      name TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      value INTEGER NOT NULL DEFAULT 0 CHECK(value >= 0),
      PRIMARY KEY(name,label)
    );
INSERT INTO counters VALUES('live_admission','addition_matched',3);
CREATE TABLE accounts (
      did TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE CHECK(length(username) BETWEEN 2 AND 64 AND substr(username, 1, 1) GLOB '[a-z0-9]' AND username NOT GLOB '*[^a-z0-9._-]*'),
      oauth_status TEXT NOT NULL DEFAULT 'active' CHECK(oauth_status IN ('active','reauth_required','signed_out')),
      share_now_playing INTEGER NOT NULL DEFAULT 1 CHECK(share_now_playing IN (0,1)),
      import_share_pct INTEGER NOT NULL DEFAULT 50 CHECK(typeof(import_share_pct) = 'integer' AND import_share_pct BETWEEN 10 AND 90),
      daily_listen_cap INTEGER NOT NULL DEFAULT 3000 CHECK(typeof(daily_listen_cap) = 'integer' AND daily_listen_cap >= 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
INSERT INTO accounts VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','u1','active',1,50,3000,1768478400000,1768478400000);
INSERT INTO accounts VALUES('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb','u2','active',1,50,3000,1768478400000,1768478400000);
CREATE TABLE web_sessions (
      token_hash BLOB PRIMARY KEY NOT NULL CHECK(typeof(token_hash) = 'blob' AND length(token_hash) = 32),
      did TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    );
CREATE TABLE oauth_states (
      key_hash BLOB PRIMARY KEY NOT NULL CHECK(typeof(key_hash) = 'blob' AND length(key_hash) = 32),
      ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      session_binding BLOB NOT NULL CHECK(typeof(session_binding) = 'blob' AND length(session_binding) = 32),
      expires_at_ms INTEGER NOT NULL
    );
CREATE TABLE oauth_sessions (
      did TEXT PRIMARY KEY NOT NULL,
      ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      client_kid TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation) = 'integer' AND generation >= 0),
      last_refresh_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reauth_required','signed_out')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
CREATE TABLE operations (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scrobble.create','scrobble.delete','follow.put','follow.delete','settings.put','love.put','love.delete')),
      origin TEXT NOT NULL CHECK(origin IN ('web','lastfm','listenbrainz','import')),
      priority INTEGER NOT NULL CHECK(typeof(priority) = 'integer' AND priority >= 0),
      collection TEXT NOT NULL,
      rkey TEXT,
      record_json TEXT,
      digest TEXT,
      swap_cid TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','blocked','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 10),
      due_at INTEGER NOT NULL,
      last_error TEXT,
      result_uri TEXT,
      result_cid TEXT,
      idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
      request_hash BLOB CHECK(request_hash IS NULL OR (typeof(request_hash) = 'blob' AND length(request_hash) = 32)),
      import_job_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, follow_proof_json TEXT, send_started_at_ms INTEGER, send_state TEXT NOT NULL DEFAULT 'unknown', legacy_absent_at_ms INTEGER, removal_fence_rev TEXT, removal_head_rev TEXT, removal_commit_rev TEXT, removal_done_rev TEXT, removal_done_basis TEXT, removal_reached TEXT, removal_reached_at_ms INTEGER, removal_send_state TEXT, removal_send_json TEXT, removal_send_at_ms INTEGER, removal_superseded_by TEXT,
      CHECK((record_json IS NULL) = (digest IS NULL)),
      UNIQUE(did,idempotency_key)
    );
INSERT INTO operations VALUES('16543578-5505-4f2e-a1df-6f11fa28d747','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','love.put','web',0,'com.example.atmusic.love','3mchjvhag22jm','{"$type":"com.example.atmusic.love","artist":"Legacy API producer","track":"Legacy actual SENT","createdAt":"2026-01-15T12:00:00Z"}','b48ea5bd98af8e861931440245283a952e3db38ceeebd6aebf4e35bf1454a462',NULL,'succeeded',1,1768478400000,NULL,'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm','bafyreiciwpbu7j6hcypkmiqkc2nbbgbvromsio36lgfunhfchbdhboipta',NULL,NULL,NULL,1768478400000,1768478400000,NULL,1768478400000,'unknown',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO operations VALUES('b8fb5343-e4b4-4c2c-b3d9-c2d2181dcac5','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','love.put','web',0,'com.example.atmusic.love','3mchjvhag23jm','{"$type":"com.example.atmusic.love","artist":"Legacy API reuse target","track":"Legacy reused track","createdAt":"2026-01-15T12:00:00Z"}','5cd3a3741f7470fc29b19a6566ffc99e1d68c018eb2eeb4d84ad702b13916e76',NULL,'succeeded',1,1768478400000,NULL,'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1','bafyreia44yhnigwxpbzh4ypf7p7wubxmmmefwwd7h5zb6clclmmcpz4h5q',NULL,NULL,NULL,1768478400000,1768478400000,NULL,1768478400000,'unknown',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE operation_deps (
      op_id TEXT NOT NULL,
      pred_id TEXT NOT NULL,
      PRIMARY KEY(op_id,pred_id),
      CHECK(op_id != pred_id)
    );
CREATE TABLE listen_keys (
      did TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      operation_id TEXT,
      source TEXT NOT NULL CHECK(source IN ('web','lastfm','listenbrainz','import')),
      created_at_ms INTEGER NOT NULL, listen_second INTEGER,
      PRIMARY KEY(did,dedupe_key)
    );
CREATE TABLE pds_budget (
      did TEXT NOT NULL,
      window TEXT NOT NULL CHECK(window IN ('hour','day')),
      window_start_ms INTEGER NOT NULL,
      points INTEGER NOT NULL DEFAULT 0 CHECK(typeof(points) = 'integer' AND points >= 0),
      limit_hint INTEGER CHECK(limit_hint >= 0),
      remaining_hint INTEGER CHECK(remaining_hint >= 0),
      reset_at_ms INTEGER,
      PRIMARY KEY(did,window)
    );
INSERT INTO pds_budget VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','hour',1768478400000,3,5000,4997,1768482000000);
INSERT INTO pds_budget VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','day',1768478400000,3,NULL,NULL,NULL);
CREATE TABLE lastfm_tokens (
      token_hash BLOB PRIMARY KEY NOT NULL CHECK(typeof(token_hash) = 'blob' AND length(token_hash) = 32),
      api_key TEXT NOT NULL CHECK(length(api_key) BETWEEN 1 AND 64),
      did TEXT,
      state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','authorized','consumed')),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      CHECK(state = 'issued' OR did IS NOT NULL)
    );
CREATE TABLE lastfm_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      sk_hash BLOB NOT NULL UNIQUE CHECK(typeof(sk_hash) = 'blob' AND length(sk_hash) = 32),
      did TEXT NOT NULL,
      api_key TEXT NOT NULL CHECK(length(api_key) BETWEEN 1 AND 64),
      client_name TEXT,
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER
    );
CREATE TABLE lastfm_apps (
      api_key TEXT PRIMARY KEY NOT NULL CHECK(length(api_key) BETWEEN 1 AND 64),
      did TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
CREATE TABLE app_passwords (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      label TEXT,
      hash BLOB NOT NULL UNIQUE CHECK(typeof(hash) = 'blob' AND length(hash) = 32),
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER
    );
CREATE TABLE lb_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      label TEXT,
      hash BLOB NOT NULL UNIQUE CHECK(typeof(hash) = 'blob' AND length(hash) = 32),
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER
    );
CREATE TABLE now_playing (
      did TEXT PRIMARY KEY NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      album TEXT,
      album_artist TEXT,
      duration_seconds INTEGER CHECK(duration_seconds BETWEEN 1 AND 86400),
      recording_mbid TEXT,
      client TEXT,
      source TEXT NOT NULL CHECK(source IN ('web','lastfm','listenbrainz')),
      started_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    , updated_at_ms INTEGER, track_number INTEGER, release_mbid TEXT, release_group_mbid TEXT, artist_mbids TEXT, isrc TEXT, submission_client_version TEXT, music_service TEXT, media_player TEXT, scrobbled_at_ms INTEGER);
CREATE TABLE loves (
      uri TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL REFERENCES users(did) ON DELETE CASCADE,
      rkey TEXT NOT NULL,
      cid TEXT NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      album TEXT,
      artist_key TEXT NOT NULL,
      track_key TEXT NOT NULL,
      recording_mbid TEXT,
      created_at TEXT NOT NULL CHECK(length(created_at) = 30 AND substr(created_at, 30, 1) = 'Z'),
      indexed_at TEXT NOT NULL
    , revision TEXT);
INSERT INTO loves VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','3mchjvhag22jm','bafyreiciwpbu7j6hcypkmiqkc2nbbgbvromsio36lgfunhfchbdhboipta','Legacy API producer','Legacy actual SENT',NULL,'legacy api producer','legacy actual sent',NULL,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z','3mchjvhag2322');
INSERT INTO loves VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportlive001','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','3kimportlive001','bafyreigthrbgexb5ilkwl7uzxfrddzhkvuzsri7pm3k7ksnhxyc3yabkc4','Producer restore Live','SENT love','Actual producer album','producer restore live','sent love','12345678-1234-1234-1234-123456789abc','2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z','3mchjvhag2422');
INSERT INTO loves VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1','did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','3kimportoldreuse1','bafyreia44yhnigwxpbzh4ypf7p7wubxmmmefwwd7h5zb6clclmmcpz4h5q','Legacy API reuse target','Legacy reused track',NULL,'legacy api reuse target','legacy reused track',NULL,'2026-01-15T12:00:00.000000000Z','2026-01-15T12:00:00.000000000Z','3mchjvhag2522');
CREATE TABLE linked_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      service TEXT NOT NULL CHECK(service IN ('lastfm','listenbrainz')),
      remote_user TEXT NOT NULL,
      credential_ciphertext BLOB NOT NULL,
      key_id TEXT NOT NULL,
      forward_scrobbles INTEGER NOT NULL DEFAULT 1 CHECK(forward_scrobbles IN (0,1)),
      forward_now_playing INTEGER NOT NULL DEFAULT 1 CHECK(forward_now_playing IN (0,1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','error')),
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1, generation_start_seq INTEGER NOT NULL DEFAULT 0, last_success_ms INTEGER, last_failure_ms INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, backfill_state TEXT NOT NULL DEFAULT 'pending', backfill_cursor TEXT, backfill_total INTEGER NOT NULL DEFAULT 0, backfill_done INTEGER NOT NULL DEFAULT 0, pull_enabled INTEGER NOT NULL DEFAULT 1, pull_watermark_ms INTEGER, last_pull_ms INTEGER, sync_remote_user TEXT, backfill_failures INTEGER NOT NULL DEFAULT 0, backfill_next_attempt_ms INTEGER, backfill_run_revision INTEGER NOT NULL DEFAULT 1, backfill_discovery_cursor TEXT, backfill_discovery_done INTEGER NOT NULL DEFAULT 0, backfill_last_serviced_seq INTEGER NOT NULL DEFAULT 0, backfill_last_error TEXT,
      UNIQUE(did,service)
    );
CREATE TABLE link_states (
      state_hash BLOB PRIMARY KEY NOT NULL CHECK(typeof(state_hash) = 'blob' AND length(state_hash) = 32),
      did TEXT NOT NULL,
      service TEXT NOT NULL CHECK(service IN ('lastfm','listenbrainz')),
      session_hash BLOB NOT NULL CHECK(typeof(session_hash) = 'blob' AND length(session_hash) = 32),
      expires_at_ms INTEGER NOT NULL
    );
CREATE TABLE forward_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      did TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scrobble','nowplaying','love','unlove')),
      dedupe_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','ignored','failed','expired','held')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts >= 0),
      due_at INTEGER NOT NULL,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, love_artist_key TEXT, love_track_key TEXT, generation INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, love_lane INTEGER, authorization_uri TEXT, authorization_rev TEXT,
      UNIQUE(link_id,kind,dedupe_key)
    );
CREATE TABLE import_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('lastfm_api','lastfm_json','listenbrainz_api','listenbrainz_zip')),
      remote_user TEXT,
      state TEXT NOT NULL DEFAULT 'waiting_index' CHECK(state IN ('waiting_index','fetching','writing','paused','done','failed','cancelled')),
      cursor_json TEXT,
      upload_path TEXT,
      upload_bytes INTEGER CHECK(upload_bytes IS NULL OR (typeof(upload_bytes) = 'integer' AND upload_bytes >= 0)),
      fetched INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fetched) = 'integer' AND fetched >= 0),
      staged INTEGER NOT NULL DEFAULT 0 CHECK(typeof(staged) = 'integer' AND staged >= 0),
      duplicates INTEGER NOT NULL DEFAULT 0 CHECK(typeof(duplicates) = 'integer' AND duplicates >= 0),
      invalid INTEGER NOT NULL DEFAULT 0 CHECK(typeof(invalid) = 'integer' AND invalid >= 0),
      invalid_reasons TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(invalid_reasons) AND json_type(invalid_reasons) = 'object'),
      written INTEGER NOT NULL DEFAULT 0 CHECK(typeof(written) = 'integer' AND written >= 0),
      failed_items INTEGER NOT NULL DEFAULT 0 CHECK(typeof(failed_items) = 'integer' AND failed_items >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts >= 0),
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER
    );
CREATE TABLE import_items (
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(typeof(seq) = 'integer' AND seq >= 0),
      dedupe_key TEXT NOT NULL,
      listened_at TEXT NOT NULL CHECK(length(listened_at) = 30 AND substr(listened_at, 30, 1) = 'Z'),
      record_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','queued','written','duplicate','invalid','failed')),
      operation_id TEXT, removal_operation_id TEXT, removed_at_ms INTEGER,
      PRIMARY KEY(job_id,seq),
      UNIQUE(job_id,dedupe_key)
    );
CREATE TABLE ignored_listens (
      id INTEGER PRIMARY KEY NOT NULL,
      did TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('listenbrainz')),
      reason TEXT NOT NULL CHECK(reason IN ('artist_invalid','track_invalid')),
      listened_at TEXT NOT NULL CHECK(length(listened_at) = 30 AND substr(listened_at, 30, 1) = 'Z'),
      artist_preview TEXT NOT NULL CHECK(length(artist_preview) <= 128),
      track_preview TEXT NOT NULL CHECK(length(track_preview) <= 128),
      created_at_ms INTEGER NOT NULL
    );
CREATE TABLE range_stats_cache (
      did TEXT NOT NULL,
      entity TEXT NOT NULL,
      range_key TEXT NOT NULL,
      as_of TEXT NOT NULL,
      lower TEXT,
      upper TEXT,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,entity,range_key)
    );
CREATE TABLE backup_runs (
      id INTEGER PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('daily','manual','pre_migration','pre_restore')),
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      path TEXT,
      bytes INTEGER CHECK(bytes IS NULL OR (typeof(bytes) = 'integer' AND bytes >= 0)),
      ok INTEGER NOT NULL DEFAULT 0 CHECK(ok IN (0,1)),
      error TEXT
    );
CREATE TABLE schema_compat (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
      min_compatible_version INTEGER NOT NULL CHECK(typeof(min_compatible_version) = 'integer' AND min_compatible_version >= 1)
    );
INSERT INTO schema_compat VALUES(1,2);
CREATE TABLE listen_removals (
      did TEXT NOT NULL,
      record_uri TEXT NOT NULL,
      listen_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, operation_id TEXT, removed_cid TEXT,
      PRIMARY KEY(did,record_uri,listen_id)
    );
CREATE TABLE batch_entry_items (
      operation_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL, removal_operation_id TEXT, removed_at_ms INTEGER,
      PRIMARY KEY(operation_id,entry_id,job_id,seq)
    );
CREATE TABLE batch_delete_listens (
      operation_id TEXT NOT NULL,
      listen_id TEXT NOT NULL,
      PRIMARY KEY(operation_id,listen_id)
    );
CREATE TABLE batch_delete_children (
      parent_operation_id TEXT NOT NULL,
      child_operation_id TEXT NOT NULL,
      PRIMARY KEY(parent_operation_id,child_operation_id)
    );
CREATE TABLE listen_removal_cids (
      operation_id TEXT NOT NULL,
      cid TEXT NOT NULL,
      PRIMARY KEY(operation_id,cid)
    );
CREATE TABLE verified_membership (
      record_uri TEXT NOT NULL,
      listen_id TEXT NOT NULL,
      did TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('present','excluded','absent')),
      revision TEXT NOT NULL,
      cid TEXT,
      reason TEXT,
      last_absent_revision TEXT,
      PRIMARY KEY(record_uri,listen_id)
    );
CREATE TABLE mb_tracks (
      artist_key TEXT NOT NULL, track_key TEXT NOT NULL, album_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_attempt_ms INTEGER, submitted_recording_mbid TEXT, matched_by TEXT, score INTEGER,
      recording_mbid TEXT, title TEXT, artist_credit TEXT, artist_mbids TEXT, release_mbid TEXT, release_title TEXT, release_group_mbid TEXT,
      duration_ms INTEGER, isrcs TEXT, first_release_date TEXT, synced_at_ms INTEGER, created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (artist_key, track_key, album_key)
    );
INSERT INTO mb_tracks VALUES('legacy api producer','legacy actual sent','','pending',0,0,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1768478400000);
INSERT INTO mb_tracks VALUES('producer restore live','sent love','','pending',0,0,0,NULL,'12345678-1234-1234-1234-123456789abc',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1768478400000);
INSERT INTO mb_tracks VALUES('legacy api reuse target','legacy reused track','','pending',0,0,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1768478400000);
CREATE TABLE mb_pacing (singleton INTEGER PRIMARY KEY NOT NULL, available_at_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mb_seed_state (singleton INTEGER PRIMARY KEY NOT NULL, cursor_uri TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mb_love_revive_jobs (artist_key TEXT NOT NULL,track_key TEXT NOT NULL,album_key TEXT NOT NULL DEFAULT '',recording_mbid TEXT NOT NULL,matched_at_ms INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,cursor_link_id TEXT NOT NULL DEFAULT '',PRIMARY KEY (artist_key,track_key,album_key));
CREATE TABLE mb_forward_love_current (link_id TEXT NOT NULL, love_artist_key TEXT NOT NULL, love_track_key TEXT NOT NULL,
      forward_rowid INTEGER NOT NULL, PRIMARY KEY(link_id,love_artist_key,love_track_key),
      FOREIGN KEY(link_id) REFERENCES linked_accounts(id) ON DELETE CASCADE);
CREATE TABLE mb_love_revival_state (singleton INTEGER PRIMARY KEY NOT NULL, cursor_rowid INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mb_cover_art (
      release_mbid TEXT PRIMARY KEY NOT NULL, mime_type TEXT NOT NULL, image_bytes BLOB NOT NULL,
      byte_size INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, fetched_at_ms INTEGER NOT NULL, last_access_ms INTEGER NOT NULL
    );
CREATE TABLE mb_cover_art_jobs (
      release_mbid TEXT PRIMARY KEY NOT NULL, release_group_mbid TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_due_ms INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
    );
CREATE TABLE mb_cover_art_usage (singleton INTEGER PRIMARY KEY NOT NULL, used_bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO mb_cover_art_usage VALUES(1,0);
CREATE TABLE forward_admissions (
      did TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      path TEXT NOT NULL,
      source_service TEXT,
      created_at_ms INTEGER NOT NULL,
      admission_seq INTEGER NOT NULL UNIQUE,
      PRIMARY KEY(did,identity_key)
    );
INSERT INTO forward_admissions VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','love:at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm:3mchjvhag2322','api',NULL,1768478400000,2);
INSERT INTO forward_admissions VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','love:at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportlive001:3mchjvhag2422','import','lastfm',1768478400000,4);
INSERT INTO forward_admissions VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','love:at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1:3mchjvhag2522','import','listenbrainz',1768478400000,6);
CREATE TABLE forward_admission_clock (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
      next_seq INTEGER NOT NULL CHECK(typeof(next_seq)='integer' AND next_seq>=0)
    );
INSERT INTO forward_admission_clock VALUES(1,7);
CREATE TABLE love_incarnations (
      uri TEXT PRIMARY KEY NOT NULL,
      incarnation_key TEXT NOT NULL,
      state TEXT NOT NULL,
      path TEXT NOT NULL,
      source_service TEXT,
      updated_at_ms INTEGER NOT NULL
    );
INSERT INTO love_incarnations VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm','love:at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3mchjvhag22jm:3mchjvhag2322','present','api',NULL,1768478400000);
INSERT INTO love_incarnations VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportlive001','love:at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportlive001:3mchjvhag2422','present','import','lastfm',1768478400000);
INSERT INTO love_incarnations VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1','love:at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/3kimportoldreuse1:3mchjvhag2522','present','import','listenbrainz',1768478400000);
CREATE TABLE love_delete_bridges (
      did TEXT NOT NULL,
      uri TEXT NOT NULL,
      incarnation_key TEXT NOT NULL,
      expected_cid TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, delete_rev TEXT,
      PRIMARY KEY(did,uri,incarnation_key,operation_id)
    );
CREATE TABLE love_import_bridges (
      did TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      incarnation_key TEXT NOT NULL,
      source_service TEXT,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,operation_id)
    );
CREATE TABLE forward_storage_scan (
      table_key TEXT PRIMARY KEY NOT NULL,
      cursor_json TEXT,
      rows_seen INTEGER NOT NULL DEFAULT 0 CHECK(typeof(rows_seen)='integer' AND rows_seen>=0),
      logical_bytes_seen INTEGER NOT NULL DEFAULT 0 CHECK(typeof(logical_bytes_seen)='integer' AND logical_bytes_seen>=0),
      complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
    );
CREATE TABLE link_backfill_items (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      run_revision INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      identity_key TEXT NOT NULL,
      uri TEXT NOT NULL,
      cid TEXT NOT NULL,
      kind TEXT NOT NULL,
      event_at TEXT NOT NULL,
      PRIMARY KEY(link_id,generation,run_revision,identity_key)
    );
CREATE TABLE linked_pull_state (
      link_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      source_service TEXT NOT NULL,
      source_account TEXT NOT NULL,
      listen_watermark_ms INTEGER NOT NULL,
      love_boundary_ms INTEGER,
      love_boundary_key TEXT,
      page_kind TEXT,
      page_cursor TEXT,
      page_started_at_ms INTEGER,
      hold_reason TEXT,
      retry_at_ms INTEGER,
      failures INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL, love_cursor TEXT, poll_next_at_ms INTEGER, listen_round_upper_ms INTEGER, listen_round_floor_ms INTEGER, listen_round_page INTEGER, love_round_upper_ms INTEGER, love_round_page INTEGER, love_round_floor_ms INTEGER, poll_phase TEXT NOT NULL DEFAULT 'listen', skipped_count INTEGER NOT NULL DEFAULT 0, listen_floor_at_ms INTEGER, love_floor_at_ms INTEGER, listen_round_saturated INTEGER NOT NULL DEFAULT 0, love_round_total_count INTEGER, love_round_first_key TEXT, love_round_newest_ms INTEGER,
      PRIMARY KEY(link_id,generation)
    );
CREATE TABLE linked_pull_items (
      link_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_service TEXT NOT NULL,
      source_account TEXT NOT NULL,
      listened_at_ms INTEGER,
      love_key TEXT,
      recording_mbid TEXT,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      staged_at_ms INTEGER NOT NULL,
      PRIMARY KEY(link_id,generation,item_key)
    );
CREATE TABLE linked_pull_tombstones (
      did TEXT NOT NULL,
      kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      listen_second INTEGER,
      artist_key TEXT,
      track_key TEXT,
      love_key TEXT,
      recording_mbid TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,kind,identity_key)
    );
CREATE TABLE linked_love_intents (
    did TEXT NOT NULL,
    love_key TEXT NOT NULL,
    intent TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL, recording_mbid TEXT,
    PRIMARY KEY(did,love_key)
  );
INSERT INTO linked_love_intents VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','legacy api producer','love','16543578-5505-4f2e-a1df-6f11fa28d747',1768478400000,NULL);
INSERT INTO linked_love_intents VALUES('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa','legacy api reuse target','love','b8fb5343-e4b4-4c2c-b3d9-c2d2181dcac5',1768478400000,NULL);
CREATE TABLE linked_pull_receipt_seed (
      singleton INTEGER PRIMARY KEY NOT NULL,
      last_rowid INTEGER NOT NULL DEFAULT 0,
      member_offset INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );
CREATE TABLE linked_pull_projection_scan (
      did TEXT PRIMARY KEY NOT NULL,
      rowid_cursor INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );
CREATE TABLE linked_pull_love_admissions (
      did TEXT NOT NULL,
      link_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      love_key TEXT NOT NULL,
      recording_mbid TEXT,
      source_service TEXT NOT NULL,
      source_account TEXT NOT NULL,
      state TEXT NOT NULL,
      uri TEXT,
      incarnation_key TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(did,operation_id)
    );
CREATE TABLE listenbrainz_deletes (
      id TEXT PRIMARY KEY NOT NULL,
      event_key TEXT NOT NULL,
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      did TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      listened_at INTEGER NOT NULL,
      artist_key TEXT NOT NULL,
      track_key TEXT NOT NULL,
      artist TEXT NOT NULL,
      track TEXT NOT NULL,
      source_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','ignored','unsupported','sent','failed','expired')),
      attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      target_msid TEXT,
      target_listened_at INTEGER,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL, lookup_min_ts INTEGER, lookup_candidates TEXT, lookup_last_earliest INTEGER, lookup_last_max INTEGER, authorization_uri TEXT, authorization_rev TEXT,
      UNIQUE(link_id,generation,event_key)
    );
CREATE TABLE forward_love_lanes (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      love_artist_key TEXT NOT NULL,
      love_track_key TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority IN (0,1)),
      due_at INTEGER NOT NULL,
      head_created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (link_id,generation,love_artist_key,love_track_key)
    );
CREATE TABLE forward_love_recording_history (
      did TEXT NOT NULL, artist_key TEXT NOT NULL, track_key TEXT NOT NULL,
      operation_rowid INTEGER NOT NULL, recording_mbid TEXT NOT NULL,
      PRIMARY KEY(did,artist_key,track_key,operation_rowid)
    );
CREATE TABLE forward_love_recording_history_state (singleton INTEGER PRIMARY KEY NOT NULL, cursor_rowid INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE forward_love_recording_targets (
      target_id INTEGER PRIMARY KEY NOT NULL, forward_rowid INTEGER NOT NULL UNIQUE, link_id TEXT NOT NULL, generation INTEGER NOT NULL,
      artist_key TEXT NOT NULL, track_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL, recording_mbid TEXT NOT NULL
    );
CREATE TABLE forward_love_recording_targets_state (singleton INTEGER PRIMARY KEY NOT NULL, cursor_rowid INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE forward_love_operation_targets (
      target_id INTEGER PRIMARY KEY NOT NULL, operation_rowid INTEGER NOT NULL UNIQUE, did TEXT NOT NULL, artist_key TEXT NOT NULL,
      track_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL, recording_mbid TEXT NOT NULL
    );
CREATE TABLE forward_love_operation_targets_state (singleton INTEGER PRIMARY KEY NOT NULL, cursor_rowid INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE forward_unlove_lookup_progress (
      unlove_rowid INTEGER PRIMARY KEY NOT NULL, cursor_created_at_ms INTEGER NOT NULL, cursor_operation_rowid INTEGER NOT NULL
    );
CREATE TABLE live_record_evidence (
      uri TEXT PRIMARY KEY NOT NULL, did TEXT NOT NULL, collection TEXT NOT NULL, rkey TEXT NOT NULL,
      up_rev TEXT, up_action TEXT CHECK(up_action IS NULL OR up_action IN ('create','update')), up_cid TEXT,
      del_rev TEXT, conflict_rev TEXT, received_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      CHECK(up_rev IS NOT NULL OR del_rev IS NOT NULL),
      CHECK((up_rev IS NULL) = (up_action IS NULL) AND (up_rev IS NULL) = (up_cid IS NULL))
    );
CREATE TABLE live_acceptance_candidates (
      uri TEXT NOT NULL, identity_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('scrobble','love')),
      member_uri TEXT NOT NULL, cid TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY(uri,identity_key)
    );
CREATE TABLE live_pending_removals (
      uri TEXT NOT NULL, member_uri TEXT NOT NULL, removed_cid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scrobble','love')),
      window_lo TEXT NOT NULL, window_hi TEXT NOT NULL, replaced_by_cid TEXT NOT NULL,
      identity_key TEXT NOT NULL, listened_at INTEGER,
      artist_key TEXT NOT NULL, track_key TEXT NOT NULL, artist TEXT NOT NULL, track TEXT NOT NULL,
      recording_mbid TEXT, love_source_service TEXT, love_import_sources TEXT,
      authorized_rev TEXT, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, conflict_invalidated INTEGER NOT NULL DEFAULT 0, conflicted_auth_rev TEXT,
      PRIMARY KEY(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid)
    );
CREATE TABLE live_pending_removal_events (
      uri TEXT NOT NULL, rev TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','update','delete')),
      cid TEXT NOT NULL DEFAULT '', conflicted INTEGER NOT NULL DEFAULT 0 CHECK(conflicted IN (0,1)),
      cursor_window_hi TEXT NOT NULL DEFAULT '', cursor_window_lo TEXT NOT NULL DEFAULT '',
      cursor_replaced_by_cid TEXT NOT NULL DEFAULT '', cursor_kind TEXT NOT NULL DEFAULT '',
      cursor_member_uri TEXT NOT NULL DEFAULT '', cursor_removed_cid TEXT NOT NULL DEFAULT '',
      scan_complete INTEGER NOT NULL DEFAULT 0 CHECK(scan_complete IN (0,1)),
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, cleanup_due_ms INTEGER NOT NULL DEFAULT 0, cleanup_frontier TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(uri,rev)
    );
CREATE TABLE live_pending_removal_reconcile (
      uri TEXT NOT NULL, window_lo TEXT NOT NULL, window_hi TEXT NOT NULL, replaced_by_cid TEXT NOT NULL,
      cursor_rev TEXT NOT NULL, next_due_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(uri,window_lo,window_hi,replaced_by_cid)
    );
CREATE TABLE live_pending_removal_retention_epoch (
      uri TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>=0)
    );
CREATE TABLE forward_receipts (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('scrobble','love','unlove')),
      dedupe_key TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      retired_at_ms INTEGER,
      PRIMARY KEY(link_id,generation,kind,dedupe_key)
    );
CREATE TABLE forward_link_gaps (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      from_seq INTEGER NOT NULL CHECK(from_seq>=0),
      to_seq INTEGER CHECK(to_seq IS NULL OR to_seq>from_seq),
      reason TEXT NOT NULL CHECK(reason IN ('disabled','revoked','legacy')),
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      PRIMARY KEY(link_id,generation,from_seq)
    );
CREATE TABLE forward_love_delivery (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      love_artist_key TEXT NOT NULL,
      love_track_key TEXT NOT NULL,
      last_sent_kind TEXT NOT NULL CHECK(last_sent_kind IN ('love','unlove')),
      last_sent_dedupe_key TEXT NOT NULL,
      row_created_at_ms INTEGER NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY(link_id,generation,love_artist_key,love_track_key)
    );
CREATE TABLE forward_deferred_love_heads (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      love_artist_key TEXT NOT NULL,
      love_track_key TEXT NOT NULL,
      head_seq INTEGER NOT NULL UNIQUE CHECK(head_seq>=1),
      next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq>=1),
      live_from_seq INTEGER NOT NULL DEFAULT 1 CHECK(live_from_seq>=1 AND live_from_seq<=next_seq),
      armed_seq INTEGER CHECK(armed_seq IS NULL OR armed_seq>=1),
      maintenance_seq INTEGER CHECK(maintenance_seq IS NULL OR maintenance_seq>=1),
      decided_seq INTEGER CHECK(decided_seq IS NULL OR decided_seq>=1),
      scan_seq INTEGER CHECK(scan_seq IS NULL OR scan_seq>=1),
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(link_id,generation,love_artist_key,love_track_key)
    );
CREATE TABLE forward_deferred_love_intents (
      link_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      love_artist_key TEXT NOT NULL,
      love_track_key TEXT NOT NULL,
      intent_seq INTEGER NOT NULL CHECK(intent_seq>=1),
      kind TEXT NOT NULL CHECK(kind IN ('love','unlove')),
      operation_id TEXT NOT NULL,
      origin_class TEXT NOT NULL CHECK(origin_class IN ('operation','authorized','live_love','unclassified')),
      payload_json TEXT NOT NULL,
      authorization_uri TEXT,
      authorization_rev TEXT,
      intent_at_ms INTEGER NOT NULL,
      CHECK((authorization_uri IS NULL) = (authorization_rev IS NULL)),
      CHECK((origin_class='authorized') = (authorization_uri IS NOT NULL)),
      PRIMARY KEY(link_id,generation,love_artist_key,love_track_key,intent_seq),
      UNIQUE(link_id,generation,operation_id),
      FOREIGN KEY(link_id,generation,love_artist_key,love_track_key)
        REFERENCES forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key) ON DELETE CASCADE
    );
CREATE TABLE forward_deferred_love_witnesses (
      link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      group_seq INTEGER NOT NULL CHECK(group_seq>=1),
      kind TEXT NOT NULL CHECK(kind IN ('love','unlove')),
      love_artist_key TEXT NOT NULL,
      love_track_key TEXT NOT NULL,
      authorization_uri TEXT,
      authorization_rev TEXT,
      created_at_ms INTEGER NOT NULL,
      CHECK((authorization_uri IS NULL) = (authorization_rev IS NULL)),
      PRIMARY KEY(link_id,generation,operation_id)
    );
CREATE TABLE forward_deferred_love_authorities (
      authorization_uri TEXT NOT NULL,
      authorization_rev TEXT NOT NULL,
      authority_seq INTEGER NOT NULL UNIQUE CHECK(authority_seq>=1),
      action TEXT NOT NULL CHECK(action IN ('update','delete')),
      cid TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','conflicted')),
      due_seq INTEGER CHECK(due_seq IS NULL OR due_seq>=1),
      cursor_link_id TEXT NOT NULL DEFAULT '',
      cursor_generation INTEGER NOT NULL DEFAULT 0,
      cursor_operation_id TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      CHECK((state='conflicted') = (due_seq IS NOT NULL)),
      CHECK((action='delete') = (cid='')),
      PRIMARY KEY(authorization_uri,authorization_rev)
    );
CREATE TABLE forward_deferred_love_maintenance (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
      lane_turn INTEGER NOT NULL DEFAULT 0 CHECK(lane_turn BETWEEN 0 AND 4),
      next_head_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_head_seq>=1),
      next_group_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_group_seq>=1),
      next_authority_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_authority_seq>=1),
      rr_cursor INTEGER NOT NULL DEFAULT 0,
      rr_frontier INTEGER NOT NULL DEFAULT 0,
      wit_cursor INTEGER NOT NULL DEFAULT 0,
      wit_frontier INTEGER NOT NULL DEFAULT 0,
      wit_state TEXT NOT NULL DEFAULT 'scan' CHECK(wit_state IN ('scan','pruning')),
      wit_link_id TEXT NOT NULL DEFAULT '',
      wit_generation INTEGER NOT NULL DEFAULT 0,
      auth_cursor INTEGER NOT NULL DEFAULT 0,
      auth_frontier INTEGER NOT NULL DEFAULT 0,
      rr_passes INTEGER NOT NULL DEFAULT 0,
      wit_passes INTEGER NOT NULL DEFAULT 0,
      auth_passes INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );
CREATE UNIQUE INDEX users_verified_handle ON users(handle) WHERE handle IS NOT NULL;
CREATE INDEX scrobbles_owner_time ON scrobbles(did,listened_at DESC,uri DESC);
CREATE INDEX scrobbles_global_time ON scrobbles(listened_at DESC,uri DESC);
CREATE INDEX scrobbles_stats ON scrobbles(did,artist_key,track_key,listened_at);
CREATE INDEX follows_actor_subject ON follows(actor,subject,uri);
CREATE INDEX follows_subject_actor ON follows(subject,actor,uri);
CREATE INDEX repo_jobs_due ON repo_jobs(kind,state,due_at,did);
CREATE INDEX hints_due ON hints(due_at);
CREATE INDEX hints_did ON hints(did);
CREATE INDEX scrobbles_msid ON scrobbles(did,recording_msid,listened_at) WHERE recording_msid IS NOT NULL;
CREATE INDEX scrobbles_track_global ON scrobbles(artist_key,track_key);
CREATE INDEX scrobbles_artist_global ON scrobbles(artist_key);
CREATE INDEX scrobbles_album_stats ON scrobbles(did,album_key,listened_at) WHERE album_key IS NOT NULL;
CREATE INDEX web_sessions_did ON web_sessions(did);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at_ms);
CREATE INDEX operations_due ON operations(state,priority,due_at);
CREATE INDEX operations_did_state ON operations(did,state);
CREATE INDEX loves_owner_time ON loves(did,created_at DESC,uri DESC);
CREATE INDEX loves_owner_track ON loves(did,artist_key,track_key);
CREATE INDEX forward_outbox_due ON forward_outbox(state,due_at);
CREATE INDEX import_jobs_did_state ON import_jobs(did,state);
CREATE INDEX import_items_job_state ON import_items(job_id,state,seq);
CREATE INDEX ignored_listens_did_time ON ignored_listens(did,created_at_ms DESC);
CREATE INDEX operations_scrobble_delete_target ON operations(did,rkey) WHERE kind = 'scrobble.delete';
CREATE INDEX scrobbles_batch_visibility ON scrobbles(did,artist_key,track_key,listened_at) WHERE listen_id IS NOT NULL;
CREATE INDEX scrobbles_single_visibility ON scrobbles(did,artist_key,track_key,listened_at) WHERE record_uri IS NULL;
CREATE INDEX listen_removals_container ON listen_removals(record_uri);
CREATE INDEX batch_entry_items_job ON batch_entry_items(job_id,seq);
CREATE INDEX scrobbles_record_uri ON scrobbles(record_uri);
CREATE INDEX batch_delete_listens_operation ON batch_delete_listens(operation_id);
CREATE INDEX batch_delete_children_child ON batch_delete_children(child_operation_id);
CREATE INDEX verified_membership_did ON verified_membership(did);
CREATE INDEX mb_tracks_due ON mb_tracks(status,next_attempt_ms,priority);
CREATE INDEX mb_love_revive_jobs_due ON mb_love_revive_jobs(matched_at_ms,artist_key,track_key,album_key);
CREATE INDEX mb_forward_love_current_key ON mb_forward_love_current(love_artist_key,love_track_key,link_id);
CREATE INDEX mb_cover_art_lru ON mb_cover_art(last_access_ms,release_mbid);
CREATE INDEX mb_cover_art_jobs_due ON mb_cover_art_jobs(status,next_due_ms,release_mbid);
CREATE INDEX love_delete_bridges_pending ON love_delete_bridges(did,uri,state);
CREATE INDEX love_import_bridges_incarnation ON love_import_bridges(did,uri,incarnation_key,state);
CREATE INDEX forward_outbox_due_generation ON forward_outbox(link_id,generation,state,due_at);
CREATE INDEX forward_outbox_order_generation ON forward_outbox(link_id,generation,state,created_at_ms);
CREATE INDEX forward_outbox_priority_due ON forward_outbox(link_id,generation,priority,state,due_at,created_at_ms);
CREATE INDEX linked_accounts_backfill_due ON linked_accounts(backfill_state,backfill_next_attempt_ms,created_at_ms,id);
CREATE INDEX linked_accounts_backfill_fair ON linked_accounts(status,forward_scrobbles,backfill_state,backfill_next_attempt_ms,backfill_last_serviced_seq,created_at_ms,id);
CREATE INDEX forward_outbox_history_state ON forward_outbox(priority,state);
CREATE INDEX link_backfill_items_pending ON link_backfill_items(link_id,generation,run_revision,ordinal);
CREATE INDEX linked_pull_items_pending ON linked_pull_items(link_id,generation,kind,staged_at_ms,item_key);
CREATE INDEX listen_keys_did_second ON listen_keys(did,listen_second) WHERE listen_second IS NOT NULL;
CREATE INDEX linked_pull_tombstones_listen_second ON linked_pull_tombstones(did,listen_second) WHERE kind = 'listen';
CREATE INDEX linked_pull_tombstones_love_key ON linked_pull_tombstones(did,love_key,recording_mbid) WHERE kind = 'love';
CREATE INDEX linked_love_intents_mbid ON linked_love_intents(did,recording_mbid,updated_at_ms);
CREATE INDEX linked_pull_love_admissions_generation ON linked_pull_love_admissions(link_id,generation,state);
CREATE INDEX linked_pull_love_admissions_key ON linked_pull_love_admissions(did,state,love_key);
CREATE INDEX linked_pull_love_admissions_mbid ON linked_pull_love_admissions(did,state,recording_mbid) WHERE recording_mbid IS NOT NULL;
CREATE INDEX linked_pull_love_admissions_uri ON linked_pull_love_admissions(did,uri,state) WHERE uri IS NOT NULL;
CREATE INDEX listenbrainz_deletes_due ON listenbrainz_deletes(state,due_at);
CREATE INDEX forward_outbox_love_heads ON forward_outbox(link_id,generation,state,love_artist_key,love_track_key,created_at_ms);
CREATE INDEX forward_love_lanes_due ON forward_love_lanes(link_id,generation,priority,due_at);
CREATE INDEX forward_outbox_love_unkeyed ON forward_outbox(link_id,generation,kind,created_at_ms)
      WHERE state='queued' AND (love_artist_key IS NULL OR love_track_key IS NULL);
CREATE INDEX forward_outbox_love_unframed ON forward_outbox(link_id,generation,kind,created_at_ms)
      WHERE state='queued' AND love_lane IS NULL;
CREATE INDEX forward_outbox_kind_due ON forward_outbox(link_id,generation,kind,state,due_at);
CREATE INDEX forward_outbox_link_expiry ON forward_outbox(link_id,state,kind,created_at_ms);
CREATE INDEX forward_outbox_held_expiry ON forward_outbox(state,updated_at_ms);
CREATE INDEX forward_love_recording_history_latest ON forward_love_recording_history(did,artist_key,track_key,operation_rowid DESC);
CREATE INDEX forward_outbox_love_recording_lookup ON forward_outbox(link_id,generation,love_artist_key,love_track_key,created_at_ms);
CREATE INDEX forward_love_recording_targets_latest ON forward_love_recording_targets(link_id,generation,artist_key,track_key,created_at_ms DESC,forward_rowid DESC);
CREATE INDEX forward_love_operation_targets_latest ON forward_love_operation_targets(did,artist_key,track_key,created_at_ms DESC,operation_rowid DESC);
CREATE INDEX operations_record_target ON operations(did,collection,rkey,created_at_ms);
CREATE INDEX live_record_evidence_expiry ON live_record_evidence(expires_at_ms);
CREATE INDEX live_acceptance_candidates_expiry ON live_acceptance_candidates(expires_at_ms);
CREATE INDEX live_pending_removals_ready ON live_pending_removals(authorized_rev,created_at_ms,uri,window_hi,expires_at_ms);
CREATE INDEX live_pending_removals_uri_ready ON live_pending_removals(uri,authorized_rev,created_at_ms,window_hi,expires_at_ms);
CREATE INDEX live_pending_removals_group ON live_pending_removals(uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev,expires_at_ms,member_uri);
CREATE INDEX live_pending_removals_authorize ON live_pending_removals(uri,window_hi,window_lo DESC,replaced_by_cid,authorized_rev,expires_at_ms);
CREATE INDEX live_pending_removals_expiry ON live_pending_removals(expires_at_ms,uri,window_hi);
CREATE INDEX loves_newer_by_track ON loves(did,artist_key,track_key,revision);
CREATE INDEX live_pending_removals_page ON live_pending_removals(uri,window_hi,window_lo,replaced_by_cid,kind,member_uri,removed_cid);
CREATE INDEX live_pending_removal_events_expiry ON live_pending_removal_events(expires_at_ms,uri,rev);
CREATE INDEX live_pending_removal_events_by_uri ON live_pending_removal_events(uri,rev,expires_at_ms);
CREATE INDEX live_pending_removal_events_scan ON live_pending_removal_events(scan_complete,expires_at_ms,created_at_ms,uri,rev);
CREATE INDEX live_pending_removal_events_uri_scan ON live_pending_removal_events(uri,scan_complete,expires_at_ms,created_at_ms,rev);
CREATE INDEX live_pending_removal_reconcile_due ON live_pending_removal_reconcile(next_due_ms,created_at_ms,uri,window_lo,window_hi,replaced_by_cid);
CREATE INDEX live_pending_removal_events_ready_v2 ON live_pending_removal_events(scan_complete,created_at_ms,uri,rev);
CREATE INDEX live_pending_removal_events_cleanup ON live_pending_removal_events(cleanup_due_ms,uri,rev,expires_at_ms);
CREATE INDEX listenbrainz_deletes_authorization ON listenbrainz_deletes(authorization_uri,authorization_rev,state);
CREATE INDEX forward_outbox_authorization ON forward_outbox(authorization_uri,authorization_rev,state);
CREATE INDEX live_pending_removal_events_uri_ready_order ON live_pending_removal_events(uri,scan_complete,created_at_ms,rev);
CREATE INDEX love_import_bridges_source_class ON love_import_bridges(did,uri,incarnation_key,state,(CASE WHEN source_service IN ('lastfm','lastfm_api','lastfm_json') THEN 1 WHEN source_service IN ('listenbrainz','listenbrainz_api','listenbrainz_zip') THEN 2 ELSE 0 END));
CREATE INDEX forward_deferred_love_heads_armed ON forward_deferred_love_heads(link_id,generation,armed_seq) WHERE armed_seq IS NOT NULL;
CREATE INDEX forward_deferred_love_heads_maintenance ON forward_deferred_love_heads(maintenance_seq) WHERE maintenance_seq IS NOT NULL;
CREATE INDEX forward_deferred_love_intents_authorization ON forward_deferred_love_intents(authorization_uri,authorization_rev,link_id,generation,operation_id) WHERE authorization_uri IS NOT NULL;
CREATE INDEX forward_deferred_love_witnesses_group ON forward_deferred_love_witnesses(group_seq,link_id,generation);
CREATE INDEX forward_deferred_love_authorities_due ON forward_deferred_love_authorities(due_seq) WHERE due_seq IS NOT NULL;
CREATE INDEX forward_outbox_unlove_authority_dependency ON forward_outbox(authorization_uri,authorization_rev) WHERE kind='unlove' AND authorization_uri IS NOT NULL AND (state IN ('queued','held','retrying') OR (state='ignored' AND last_error IN ('no_recording_mbid','mbid_unresolved')));
COMMIT;
