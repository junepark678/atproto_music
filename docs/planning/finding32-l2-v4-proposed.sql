CREATE TABLE love_api_bindings (
  did TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  incarnation_key TEXT NOT NULL,
  binding_seq INTEGER NOT NULL UNIQUE CHECK(binding_seq>=1),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(did,operation_id)
);
CREATE INDEX love_api_bindings_incarnation ON love_api_bindings(did,uri,incarnation_key);
CREATE TABLE love_api_recipients (
  did TEXT NOT NULL,
  uri TEXT NOT NULL,
  incarnation_key TEXT NOT NULL,
  link_id TEXT NOT NULL REFERENCES linked_accounts(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation>=1),
  aggregate_seq INTEGER NOT NULL UNIQUE CHECK(aggregate_seq>=1),
  state TEXT NOT NULL CHECK(state IN ('present','sealed','released')),
  sent_operation_id TEXT,
  next_member_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_member_seq>=1),
  validate_after_seq INTEGER NOT NULL DEFAULT 0 CHECK(validate_after_seq>=0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(did,uri,incarnation_key,link_id,generation)
);
CREATE TABLE love_api_recipient_members (
  link_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  did TEXT NOT NULL,
  uri TEXT NOT NULL,
  incarnation_key TEXT NOT NULL,
  member_seq INTEGER NOT NULL CHECK(member_seq>=1),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(link_id,generation,operation_id),
  FOREIGN KEY(did,uri,incarnation_key,link_id,generation)
    REFERENCES love_api_recipients(did,uri,incarnation_key,link_id,generation) ON DELETE CASCADE
);
CREATE INDEX love_api_recipient_members_aggregate ON love_api_recipient_members(did,uri,incarnation_key,link_id,generation,member_seq);
CREATE TABLE love_api_comparison_facts (
  authorization_uri TEXT NOT NULL,
  authorization_rev TEXT NOT NULL,
  fact_seq INTEGER NOT NULL UNIQUE CHECK(fact_seq>=1),
  action TEXT NOT NULL CHECK(action IN ('update','delete')),
  cid TEXT NOT NULL,
  horizon_ms INTEGER NOT NULL CHECK(horizon_ms>=1),
  conflicted INTEGER NOT NULL DEFAULT 0 CHECK(conflicted IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  CHECK((action='delete') = (cid='')),
  PRIMARY KEY(authorization_uri,authorization_rev)
);
CREATE TABLE love_api_window_owners (
  uri TEXT NOT NULL,
  member_uri TEXT NOT NULL,
  removed_cid TEXT NOT NULL,
  window_lo TEXT NOT NULL,
  window_hi TEXT NOT NULL,
  replaced_by_cid TEXT NOT NULL,
  did TEXT NOT NULL,
  incarnation_key TEXT NOT NULL,
  link_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid,link_id,generation),
  FOREIGN KEY(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid)
    REFERENCES live_pending_removals(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid) ON DELETE CASCADE,
  FOREIGN KEY(did,uri,incarnation_key,link_id,generation)
    REFERENCES love_api_recipients(did,uri,incarnation_key,link_id,generation) ON DELETE CASCADE
);
CREATE INDEX love_api_window_owners_aggregate ON love_api_window_owners(did,uri,incarnation_key,link_id,generation);
CREATE TABLE love_api_unlove_decisions (
  did TEXT NOT NULL,
  uri TEXT NOT NULL,
  incarnation_key TEXT NOT NULL,
  link_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  artist TEXT NOT NULL,
  track TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  track_key TEXT NOT NULL,
  recording_mbid TEXT,
  payload_json TEXT NOT NULL,
  love_source_service TEXT,
  love_import_sources TEXT,
  authorization_uri TEXT NOT NULL,
  authorization_rev TEXT NOT NULL,
  fact_action TEXT NOT NULL CHECK(fact_action IN ('update','delete')),
  fact_cid TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=1),
  due_at_ms INTEGER NOT NULL,
  scan_session TEXT,
  alias_epoch INTEGER,
  alias_cursor TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(did,uri,incarnation_key,link_id,generation),
  FOREIGN KEY(did,uri,incarnation_key,link_id,generation)
    REFERENCES love_api_recipients(did,uri,incarnation_key,link_id,generation) ON DELETE CASCADE,
  FOREIGN KEY(authorization_uri,authorization_rev)
    REFERENCES love_api_comparison_facts(authorization_uri,authorization_rev)
);
CREATE INDEX love_api_unlove_decisions_due ON love_api_unlove_decisions(due_at_ms,did,uri,incarnation_key,link_id,generation);
CREATE INDEX love_api_unlove_decisions_fact ON love_api_unlove_decisions(authorization_uri,authorization_rev);
CREATE INDEX love_api_unlove_decisions_uri ON love_api_unlove_decisions(uri,did,incarnation_key,link_id,generation);
CREATE TABLE love_api_intent_epochs (
  did TEXT PRIMARY KEY NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=0)
);
CREATE INDEX love_api_intent_alias_scan ON linked_love_intents(did,recording_mbid,love_key) WHERE intent='love';
CREATE INDEX love_api_active_love_put ON operations(did,
  (CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.artist') END),
  (CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.track') END))
  WHERE kind='love.put' AND state IN ('queued','blocked','running');
CREATE INDEX love_api_active_love_put_malformed ON operations(did)
  WHERE kind='love.put' AND state IN ('queued','blocked','running') AND (record_json IS NULL OR NOT json_valid(record_json));
CREATE TABLE love_api_proof_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
  lane_turn INTEGER NOT NULL DEFAULT 0 CHECK(lane_turn BETWEEN 0 AND 2),
  next_binding_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_binding_seq>=1),
  next_aggregate_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_aggregate_seq>=1),
  next_fact_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_fact_seq>=1),
  sweep_cursor INTEGER NOT NULL DEFAULT 0 CHECK(sweep_cursor>=0),
  sweep_frontier INTEGER NOT NULL DEFAULT 0 CHECK(sweep_frontier>=0),
  reclaim_kind TEXT NOT NULL DEFAULT 'binding' CHECK(reclaim_kind IN ('binding','fact')),
  binding_cursor INTEGER NOT NULL DEFAULT 0 CHECK(binding_cursor>=0),
  binding_frontier INTEGER NOT NULL DEFAULT 0 CHECK(binding_frontier>=0),
  fact_cursor INTEGER NOT NULL DEFAULT 0 CHECK(fact_cursor>=0),
  fact_frontier INTEGER NOT NULL DEFAULT 0 CHECK(fact_frontier>=0),
  sweep_passes INTEGER NOT NULL DEFAULT 0,
  reclaim_passes INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
)
