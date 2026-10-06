#!/usr/bin/env python3
"""Run honest fixture/subset evidence; incomplete packaged and live gates exit blocked."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from test_counts import executed_tests

# Required observable cases, not just a nonempty cargo invocation.
TARGETS = {
    "atmusic-atproto/oauth_flow": ["par_pkce", "expired_and_replay", "issuer_subject", "nonce_retry", "es256_backend_policy"],
    "atmusic-atproto/relay_apply": ["duplicate_commit", "tampering_matrix", "update_delete", "unavailable_revision_trust_never_indexes"],
    "atmusic-atproto/current_head": ["current_head_signed_repo", "current_head_old_records", "current_key_rotation", "head_binding_matrix", "head_identity_race", "invalid_trust_matrix", "private_destination", "invalid_signature", "transient_head_unavailable", "modern_and_legacy_keys", "first_valid_key_order"],
    "atmusic-atproto/backfill_recovery": ["historical_seed", "snapshot_live_race", "pds_migration", "deactivate_reactivate", "stale_account_reconciliation_preserves_fresh_authorization", "disconnect_during_account_reconciliation_keeps_local_state_removed"],
    "atmusic-atproto/relay_websocket": ["wss_binary_verified_and_dns_pinned", "wss_nonpublic_and_empty_dns_rejected_before_dial", "wss_url_credentials_fragment_and_plaintext_rejected", "wss_tls_hostname_and_certificate_verified", "wss_redirect_is_not_followed", "wss_frame_and_fragmented_message_limits", "wss_ping_and_close_acknowledged", "wss_control_budget_and_text_rejected", "wss_idle_receive_deadline_closes_socket", "wss_handshake_deadline_after_valid_tls", "wss_cancelled_receive_drop_closes_socket"],
    "atmusic-server/oauth_security": ["wrong_origin", "security_matrix", "refresh_persistence", "cross_owner"],
    "atmusic-server/logout_revocation": ["revocation_outage", "unsupported_revocation"],
    "atmusic-server/scrobble_admission": ["key_validation", "owner_and_validation", "body_boundary", "unavailable_publisher"],
    "atmusic-server/scrobble_lifecycle": ["lifecycle", "validation_matrix", "same_time_distinct"],
    "atmusic-server/scrobble_faults": ["kill_after_create", "kill_after_delete", "cursor_faults"],
    "atmusic-server/current_head_outbox": ["create_head_race_reconciles_without_rewrite", "delete_head_race_reconciles_signed_absence", "unfollow_final_head_race_reconciles_without_redelete", "unavailable_head_is_bounded_and_never_published", "invalid_head_trust_remains_permanent"],
    "atmusic-server/history_read": ["history_exact_order", "visibility", "default_twenty_pages"],
    "atmusic-server/history_cursor": ["equal_timestamp", "between_pages", "cursor_binding", "lookup_and_limits", "current_record_update_visibility"],
    "atmusic-storage/account_status": ["disconnect_then_inactive_does_not_recreate_state", "stale_account_status_preserves_new_generation", "recreated_account_never_reuses_backfill_generation", "backfill_generation_exhaustion_rolls_back_all_state", "cursor_rejection_allocates_distinct_global_generations"],
    "atmusic-storage/migrations": ["generation_upgrade_starts_above_existing_jobs"],
    "atmusic-server/proxy": ["untrusted_forwarded", "trusted_proxy", "origin_mismatch"],
    "atmusic-server/worker_runtime": ["notification_during_a_batch_is_retained_until_the_next_batch", "periodic_poll_discovers_work_without_a_notification", "notified_outbox_cancel_after_remote_commit_recovers_after_restart", "cancelled_backfill_releases_owned_tasks_and_retries_durable_job", "relay_cancellation_drops_connection_marks_gap_and_resumes_exact_checkpoint", "reconnect_wait_is_bounded_and_cancellable_without_spinning", "one_shutdown_deadline_reports_blocked_cleanup_and_keeps_admitted_write", "zero_poll_interval_is_rejected"],
    "atmusic-server/startup": ["publication_requires_an_owned_configured_namespace", "owned_namespace_initializes_delivery_without_enabling_relay", "authorized_backfill_uses_current_head_and_keeps_global_indexing_recovering", "head_advancement_retains_retryable_backfill_without_visibility", "account_inactive_hides_rows_and_verified_reactivation_restores_them", "pds_migration_during_snapshot_retries_without_visibility", "disconnect_during_snapshot_preserves_suppression", "stale_inactive_response_cannot_override_fresh_oauth_generation", "disconnect_reauthorize_cannot_reuse_an_old_backfill_generation"],
    "atmusic-server/shutdown_runtime": ["application_signal_closes_api_and_metrics_listeners", "both_http_servers_and_writer_share_thirty_seconds_and_retain_durable_work", "worker_cleanup_keeps_writer_admission_open_and_uses_the_http_deadline"],
    "atmusic-server/operations": ["status_contract"],
    "atmusic-server/outbox_retry": ["transient_schedule", "terminal_attempt", "permanent_error"],
    "atmusic-server/outbox_recovery": ["crash_after_remote", "conflicting_rkey", "five_retries"],
    "atmusic-server/federation_faults": ["independent_write", "independent_mutation", "coverage_failure", "convergence", "signature_failure", "worker_restart"],
    "atmusic-server/follows_write": ["self_and_duplicate", "restart_follow", "unfollow_absent"],
    "atmusic-server/follows_list": ["external_duplicates", "public_lists", "list_pagination"],
    "atmusic-server/follow_feed": ["pending_confirmed", "unfollow_target", "account_state"],
    "atmusic-server/stats_mutations": ["delete_effect", "update_artist", "query_plan"],
    "atmusic-server/deletion": ["wrong_owner", "hide_immediately", "pending_create_delete", "delete_restart", "external_delete"],
    "atmusic-server/account_export": ["export_owner", "export_auth", "export_secret_scan"],
    "atmusic-server/account_disconnect": ["disconnect_effect", "suppression", "explicit_reconnect"],
    "atmusic-server/read_model_acceptance": ["read_acceptance", "social_acceptance", "mutation_acceptance"],
    "atmusic-server/read_model_restart": ["durable_views", "durable_cursor", "durable_delete"],
    "atmusic-server/backup": ["backup_during_write", "restore_state", "wrong_key", "corrupt_or_newer_restore_preserves_existing_instance"],
    "atmusic-server/deployment": ["fresh_install", "upgrade_failure", "secret_example_scan", "owned_namespace_cli_starts_current_head_workers_and_stops_both_listeners"],
    "atmusic-server/shutdown": ["drain_success", "drain_timeout", "http_and_writer_share_one_shutdown_deadline"],
}
UNEXECUTED_PACKAGED = [
    "packaged_flow: complete OAuth/write/external/follow/stats/delete/disconnect fixture journey on the static executable",
    "packaged_recovery: kill static executable after remote write, restart and restore with exactly-one-record convergence",
]
FIXTURE_VALIDATOR_CASES = ["fixture_integrity", "manual_expectations", "time_reproducibility"]


def summary_counts(output: str) -> dict[str, int]:
    """Retain skipped counts without treating them as executed evidence."""
    fields = ["passed", "failed", "ignored", "measured", "filtered"]
    counts = dict.fromkeys(fields, 0)
    for row in re.findall(
        r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;",
        output,
    ):
        for field, value in zip(fields, row):
            counts[field] += int(value)
    return counts


def required_cases(output: str, cases: list[str]) -> int:
    count = executed_tests(output)
    missing = [case for case in cases if not re.search(rf"^test {re.escape(case)} \.\.\. ok$", output, re.MULTILINE)]
    if count == 0 or missing:
        raise ValueError(f"unexecuted required cases: {', '.join(missing) or 'zero executed tests'}")
    return count


def validate_targets(skip: list[str]) -> None:
    if skip:
        raise ValueError(f"unrun_gate: required targets omitted: {', '.join(skip)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "work/acceptance/backend")
    parser.add_argument("--fixture-only", action="store_true", help="return success only for executed host fixtures and packaged smoke subset; full gates remain blocked")
    parser.add_argument("--skip-target", action="append", choices=sorted(TARGETS), default=[], help="negative control: omitting any required target must fail")
    args = parser.parse_args()
    try:
        validate_targets(args.skip_target)
    except ValueError as error:
        parser.exit(1, f"FAIL {error}\n")
    binary = args.binary.resolve()
    if not binary.is_file(): parser.exit(1, "FAIL packaged binary does not exist\n")
    args.output.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    report = {"schemaVersion":1,"timestamp":datetime.now(timezone.utc).isoformat(),"artifactSha256":digest,"fixtureOnly":True,"fullPackagedGate":"blocked","liveGate":"blocked","rustFixtureTests":0,"rustFixtureIgnored":0,"rustFixtureFiltered":0,"targets":[],"unexecutedPackagedCases":UNEXECUTED_PACKAGED}
    def save(): (args.output / "report.json").write_text(json.dumps(report,sort_keys=True,indent=2)+"\n")
    save()
    try:
        validation = subprocess.run([sys.executable,str(ROOT / "scripts/validate_read_fixture.py")],cwd=ROOT,capture_output=True,text=True)
        validation_output = validation.stdout+validation.stderr
        (args.output / "fixture-validator.log").write_text(validation_output)
        if validation.returncode or any(not re.search(rf"^PASS {re.escape(case)}:", validation_output, re.MULTILINE) for case in FIXTURE_VALIDATOR_CASES):
            raise ValueError("required independent fixture validator case failed or was unexecuted")
        report["fixtureValidatorCases"] = FIXTURE_VALIDATOR_CASES
        save()
        print(f"PASS independent fixture validators: {len(FIXTURE_VALIDATOR_CASES)} required cases executed",flush=True)
        smoke = subprocess.run([sys.executable,str(ROOT / "scripts/smoke.py"),"--static",str(binary)],cwd=ROOT,capture_output=True,text=True)
        (args.output / "packaged-smoke.log").write_text(smoke.stdout+smoke.stderr)
        if smoke.returncode: raise ValueError("packaged static/HTTP/shutdown smoke failed")
        report["packagedSmokeSubset"]="passed"
        print(f"PASS packaged smoke subset, artifact SHA256 {digest}",flush=True)
        for target,cases in TARGETS.items():
            crate,name=target.split("/")
            command=["cargo","test","--locked","-p",crate,"--test",name]
            result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True)
            output=result.stdout+result.stderr
            (args.output / f"{crate}.{name}.log").write_text(output)
            if result.returncode: raise ValueError(f"{target}: cargo test failed with exit {result.returncode}")
            count=required_cases(output,cases)
            counts=summary_counts(output)
            report["targets"].append({"target":target,"passed":True,"executedTests":count,"ignoredTests":counts["ignored"],"filteredTests":counts["filtered"],"requiredCases":cases,"execution":"host Rust fixture in the owning crate"})
            report["rustFixtureTests"]+=count
            report["rustFixtureIgnored"]+=counts["ignored"]
            report["rustFixtureFiltered"]+=counts["filtered"]
            save()
            print(f"PASS FIXTURE {target}: {count} tests executed",flush=True)
        inventory=subprocess.run([sys.executable,str(ROOT / "scripts/verify_live_evidence.py"),"--artifact",str(binary)],cwd=ROOT,capture_output=True,text=True)
        (args.output / "live-inventory.log").write_text(inventory.stdout+inventory.stderr)
        report["liveInventoryExitCode"]=inventory.returncode
        report["liveInventoryMetadata"]="complete" if inventory.returncode==0 else "blocked"
        # Inventory metadata is not an actual live execution and cannot close this gate.
        if hashlib.sha256(binary.read_bytes()).hexdigest()!=digest: raise ValueError("packaged artifact changed while acceptance was running")
        report["fixtureSubset"]="passed"
        save()
    except (ValueError,OSError) as error:
        report["fixtureSubset"]="failed";report["failure"]=str(error);save()
        parser.exit(1,f"FAIL acceptance: {error}\n")
    print(f"PASS FIXTURE SUBSET ONLY: {report['rustFixtureTests']} Rust tests and packaged smoke; no full packaged/live acceptance")
    print("BLOCKED full gates: " + "; ".join(UNEXECUTED_PACKAGED) + "; actual dedicated live OAuth/PDS/relay matrix unexecuted")
    return 0 if args.fixture_only else 2


if __name__ == "__main__":
    raise SystemExit(main())
