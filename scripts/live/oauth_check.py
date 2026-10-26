#!/usr/bin/env python3
"""Collect bounded, sanitized observations from an operator-owned OAuth deployment.

The helper cannot automate external browser consent or independently attest an
authorization server's refresh exchange. A zero exit means the requested phase
completed, not that the required live gate has passed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from verify_live_evidence import secure_url  # noqa: E402

REQUIRED = (
    "ATMUSIC_PUBLIC_ORIGIN", "ATMUSIC_OAUTH_TEST_HANDLE", "ATMUSIC_OAUTH_EXPECTED_DID",
    "ATMUSIC_OAUTH_PDS_ORIGIN", "ATMUSIC_LEXICON_PREFIX", "ATMUSIC_NAMESPACE_OWNER_DOMAIN",
    "ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE", "ATMUSIC_RELAY_URL",
    "ATMUSIC_OAUTH_RELAY_COVERAGE_REFERENCE", "ATMUSIC_OAUTH_ARTIFACT",
    "ATMUSIC_OAUTH_SOURCE_COMMIT", "ATMUSIC_OAUTH_EVIDENCE_DIR",
)
PRIVATE_PHASES = {"session", "record", "refresh", "logout"}


class CheckFailure(Exception):
    """Only fixed, non-sensitive diagnostics may be attached to this error."""


def require(condition, message):
    if not condition:
        raise CheckFailure(message)


def prerequisites(environment, phase):
    names = list(REQUIRED)
    if phase in PRIVATE_PHASES:
        names.append("ATMUSIC_OAUTH_COOKIE_FILE")
    if phase == "refresh":
        names.extend(("ATMUSIC_OAUTH_ACCESS_EXPIRES_AT", "ATMUSIC_OAUTH_REFRESH_EVIDENCE"))
    missing = [name for name in names if not environment.get(name)]
    for name in ("ATMUSIC_PUBLIC_ORIGIN", "ATMUSIC_OAUTH_PDS_ORIGIN"):
        value = environment.get(name)
        if value and (not secure_url(value, {"https"}, origin=True)
                      or urllib.parse.urlparse(value).port not in (None, 443)):
            missing.append(name + " (public default-port HTTPS origin required)")
    relay = environment.get("ATMUSIC_RELAY_URL")
    if relay and not secure_url(relay, {"https", "wss"}):
        missing.append("ATMUSIC_RELAY_URL (public secure relay required)")
    did = environment.get("ATMUSIC_OAUTH_EXPECTED_DID")
    if did and (not re.fullmatch(r"did:(?:plc:[a-z2-7]{24}|web:[^\s/?#]+)", did)
                or did in {"did:plc:" + letter * 24 for letter in "abc"}):
        missing.append("ATMUSIC_OAUTH_EXPECTED_DID (dedicated real identity required)")
    prefix = environment.get("ATMUSIC_LEXICON_PREFIX")
    if prefix and (not re.fullmatch(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}", prefix)
                   or prefix.startswith(("com.example.", "org.example.", "net.example."))):
        missing.append("ATMUSIC_LEXICON_PREFIX (owned production namespace required)")
    commit = environment.get("ATMUSIC_OAUTH_SOURCE_COMMIT")
    if commit and not re.fullmatch(r"[0-9a-f]{40}", commit):
        missing.append("ATMUSIC_OAUTH_SOURCE_COMMIT (exact source commit required)")
    artifact = environment.get("ATMUSIC_OAUTH_ARTIFACT")
    if artifact and not Path(artifact).is_file():
        missing.append("ATMUSIC_OAUTH_ARTIFACT (packaged binary required)")
    return missing


def private_read(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "r", encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and not info.st_mode & 0o077 and info.st_size <= 65536,
                "private input requires an owner-only regular file of at most 64 KiB")
        return source.read()


def save(directory, name, value):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o077, "evidence directory requires owner-only permissions")
    destination = directory / name
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                   "w", encoding="utf-8") as output:
        output.write(value if isinstance(value, str) else json.dumps(value, indent=2) + "\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class LiveClient:
    def __init__(self, environment):
        self.environment = environment
        self.origin = environment["ATMUSIC_PUBLIC_ORIGIN"].rstrip("/")
        # Default proxy and certificate trust are retained. Redirects never carry
        # application cookies to another destination.
        self.opener = urllib.request.build_opener(NoRedirect())
        self.cookie = None
        self.csrf = None

    def request(self, path, method="GET", payload=None, authenticated=False, external=False):
        target = self.environment["ATMUSIC_OAUTH_PDS_ORIGIN"].rstrip("/") if external else self.origin
        headers = {"Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["Origin"] = self.origin
        if authenticated:
            require(not external and self.cookie is not None, "application session missing")
            headers["Cookie"] = self.cookie
            if method != "GET":
                headers["X-CSRF-Token"] = self.csrf
                headers["Idempotency-Key"] = str(uuid.uuid4())
        request = urllib.request.Request(target + path, data=data, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, OSError, ValueError):
            raise CheckFailure("HTTPS request failed; inspect deployment connectivity privately") from None
        with response:
            body = response.read(1048577)
            require(len(body) <= 1048576, "HTTP response exceeded 1 MiB")
            try:
                value = json.loads(body) if body else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise CheckFailure("HTTP response was not expected JSON") from None
            return response.status, value, response.headers

    def session(self):
        raw = private_read(self.environment["ATMUSIC_OAUTH_COOKIE_FILE"]).strip()
        require(re.fullmatch(r"atmusic_session=[0-9a-fA-F]{64}", raw) is not None,
                "cookie file must contain only the application session cookie pair")
        self.cookie = raw
        status, value, headers = self.request("/api/v1/auth/session", authenticated=True)
        require(status == 200 and isinstance(value, dict)
                and value.get("did") == self.environment["ATMUSIC_OAUTH_EXPECTED_DID"]
                and isinstance(value.get("csrfToken"), str)
                and headers.get("Cache-Control") == "no-store", "expected DID session was not confirmed")
        self.csrf = value["csrfToken"]
        return {"sessionStatus": status, "expectedDidConfirmed": True, "noStore": True}

    def operation(self, operation_id):
        require(isinstance(operation_id, str) and re.fullmatch(r"[a-zA-Z0-9-]{1,128}", operation_id),
                "operation identifier was malformed")
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            status, value, _ = self.request("/api/v1/operations/" + operation_id, authenticated=True)
            require(status == 200 and isinstance(value, dict), "owner operation lookup failed")
            if value.get("state") == "succeeded":
                return value
            require(value.get("state") == "pending", "publication operation failed")
            time.sleep(1)
        raise CheckFailure("publication operation did not finish within 180 seconds")

    def disposable_record(self, observation):
        started = time.monotonic()
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        payload = {"artist": "AT Music OAuth verification", "track": "Disposable " + str(uuid.uuid4()),
                   "listenedAt": now}
        status, admitted, _ = self.request("/api/v1/scrobbles", "POST", payload, authenticated=True)
        require(status == 202 and isinstance(admitted, dict), "disposable record admission failed")
        operation_id = admitted.get("operationId")
        require(isinstance(operation_id, str) and re.fullmatch(r"[a-zA-Z0-9-]{1,128}", operation_id),
                "operation identifier was malformed")
        observation.update({"operationId": operation_id, "cleanup": "inspect operation before retry"})
        operation = self.operation(operation_id)
        observation["operationConfirmationSeconds"] = round(time.monotonic() - started, 3)
        uri = operation.get("recordUri")
        expected = "at://" + self.environment["ATMUSIC_OAUTH_EXPECTED_DID"] + "/" + self.environment["ATMUSIC_LEXICON_PREFIX"] + ".scrobble/"
        require(isinstance(uri, str) and uri.startswith(expected)
                and re.fullmatch(r"[a-zA-Z0-9._~:-]{1,512}", uri[len(expected):]), "published URI did not match owner/collection")
        observation.update({"atUri": uri, "cleanup": "required"})
        encoded = urllib.parse.quote(uri, safe="")
        try:
            status, local, _ = self.request("/api/v1/scrobbles/" + encoded)
            require(status == 200 and isinstance(local, dict)
                    and isinstance(local.get("scrobble"), dict)
                    and local["scrobble"].get("uri") == uri, "verified public record missing")
            query = urllib.parse.urlencode({"repo": self.environment["ATMUSIC_OAUTH_EXPECTED_DID"],
                                           "collection": self.environment["ATMUSIC_LEXICON_PREFIX"] + ".scrobble",
                                           "rkey": uri[len(expected):]})
            remote_path = "/xrpc/com.atproto.repo.getRecord?" + query
            status, remote, _ = self.request(remote_path, external=True)
            require(status == 200 and isinstance(remote, dict) and remote.get("uri") == uri
                    and isinstance(remote.get("cid"), str)
                    and re.fullmatch(r"[a-zA-Z0-9]{16,128}", remote["cid"])
                    and remote.get("cid") == local["scrobble"].get("cid")
                    and isinstance(remote.get("value"), dict)
                    and remote["value"].get("artist") == payload["artist"]
                    and remote["value"].get("track") == payload["track"], "independent PDS record did not match URI/CID/content")
            observation.update({"cid": remote["cid"], "createStatus": 202,
                                "localReadStatus": 200, "pdsReadStatus": 200, "uriCidContentMatch": True})
        finally:
            status, deletion, _ = self.request("/api/v1/scrobbles/" + encoded, "DELETE", authenticated=True)
            require(status in (202, 204), "disposable record cleanup failed; inspect recorded AT URI")
            if status == 202:
                require(isinstance(deletion, dict), "deletion operation response was malformed")
                self.operation(deletion.get("operationId"))
            status, _, _ = self.request("/api/v1/scrobbles/" + encoded)
            require(status == 404, "deleted local record still visible")
            owner, collection, rkey = uri.removeprefix("at://").split("/", 2)
            query = urllib.parse.urlencode({"repo": owner, "collection": collection, "rkey": rkey})
            status, absent, _ = self.request("/xrpc/com.atproto.repo.getRecord?" + query, external=True)
            require(status in (400, 404) and isinstance(absent, dict)
                    and absent.get("error") in ("RecordNotFound", "NotFound"), "external PDS did not confirm deletion")
            observation.update({"cleanup": "confirmed absent", "localAfterDeleteStatus": 404,
                                "pdsAfterDeleteStatus": status})


def run(environment, phase):
    missing = prerequisites(environment, phase)
    if missing:
        print("BLOCKED: live OAuth phase did not execute")
        for name in missing:
            print("- " + name)
        return 2
    directory = Path(environment["ATMUSIC_OAUTH_EVIDENCE_DIR"])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    observation = {"schemaVersion": 1, "phase": phase, "fixtureOnly": False,
                   "result": "partial", "recordedAt": datetime.now(timezone.utc).isoformat(),
                   "commit": environment["ATMUSIC_OAUTH_SOURCE_COMMIT"],
                   "expectedDid": environment["ATMUSIC_OAUTH_EXPECTED_DID"],
                   "publicHttpsOrigin": environment["ATMUSIC_PUBLIC_ORIGIN"],
                   "pdsOrigin": environment["ATMUSIC_OAUTH_PDS_ORIGIN"]}
    try:
        observation["artifactSha256"] = hashlib.sha256(Path(environment["ATMUSIC_OAUTH_ARTIFACT"]).read_bytes()).hexdigest()
        client = LiveClient(environment)
        status, metadata, _ = client.request("/oauth/client-metadata.json")
        scope = {"atproto", "repo:" + environment["ATMUSIC_LEXICON_PREFIX"] + ".scrobble",
                 "repo:" + environment["ATMUSIC_LEXICON_PREFIX"] + ".follow"}
        require(status == 200 and isinstance(metadata, dict)
                and metadata.get("client_id") == client.origin + "/oauth/client-metadata.json"
                and metadata.get("redirect_uris") == [client.origin + "/api/v1/auth/callback"]
                and isinstance(metadata.get("scope"), str)
                and set(metadata.get("scope", "").split()) == scope
                and metadata.get("token_endpoint_auth_method") == "none"
                and metadata.get("dpop_bound_access_tokens") is True
                and metadata.get("require_pushed_authorization_requests") is True,
                "live client metadata did not match configured origin/scopes")
        status, identity, _ = client.request("/api/v1/resolve?" + urllib.parse.urlencode({"handle": environment["ATMUSIC_OAUTH_TEST_HANDLE"]}))
        require(status == 200 and isinstance(identity, dict) and identity.get("verified") is True
                and identity.get("did") == environment["ATMUSIC_OAUTH_EXPECTED_DID"], "live handle did not resolve to expected verified DID")
        observation.update({"metadataStatus": 200, "resolveStatus": 200, "requestedScopes": sorted(scope)})
        if phase == "start":
            status, response, _ = client.request("/api/v1/auth/start", "POST", {"handle": environment["ATMUSIC_OAUTH_TEST_HANDLE"]})
            require(status == 200 and isinstance(response, dict)
                    and secure_url(response.get("authorizationUrl"), {"https"}), "live OAuth start did not return a secure authorization URL")
            save(directory, "authorization-" + stamp + ".private", response["authorizationUrl"] + "\n")
            observation["startStatus"] = 200
        if phase in PRIVATE_PHASES:
            observation.update(client.session())
        if phase == "refresh":
            expiry = datetime.fromisoformat(environment["ATMUSIC_OAUTH_ACCESS_EXPIRES_AT"].replace("Z", "+00:00"))
            require(expiry.tzinfo is not None and datetime.now(timezone.utc).timestamp() >= expiry.timestamp() + 30,
                    "refresh phase requires observed access expiry at least 30 seconds ago")
            attestation = json.loads(private_read(environment["ATMUSIC_OAUTH_REFRESH_EVIDENCE"]))
            require(isinstance(attestation, dict)
                    and set(attestation) == {"refreshGrantConfirmed", "refreshCredentialRotated", "oldRefreshRejected", "evidenceReference"}
                    and all(attestation[name] is True for name in ("refreshGrantConfirmed", "refreshCredentialRotated", "oldRefreshRejected"))
                    and re.fullmatch(r"[a-zA-Z0-9._-]{1,128}\.json", attestation["evidenceReference"]),
                    "refresh phase requires independently reviewed sanitized exchange evidence")
            observation.update({"accessExpiredBeforeRequest": True, "operatorRefreshEvidence": attestation})
        if phase in ("record", "refresh"):
            client.disposable_record(observation)
        if phase == "logout":
            status, _, headers = client.request("/api/v1/auth/logout", "POST", authenticated=True)
            cleared = headers.get("Set-Cookie", "")
            require(status == 204 and "Max-Age=0" in cleared and "Secure" in cleared
                    and "HttpOnly" in cleared and "SameSite=Lax" in cleared,
                    "logout did not clear the secure application cookie")
            status, _, _ = client.request("/api/v1/auth/session", authenticated=True)
            require(status == 401, "old session remained usable after logout")
            observation.update({"logoutStatus": 204, "cookieCleared": True, "oldSessionStatus": 401})
        observation["result"] = "observed"
        save(directory, "oauth-" + phase + "-" + stamp + ".json", observation)
        print("OBSERVED: " + phase + "; sanitized evidence saved; live gate requires independent review")
        return 0
    except (CheckFailure, OSError, ValueError, TypeError, KeyError):
        # HTTP bodies, authorization URLs, cookies, codes and token material are
        # intentionally excluded from both diagnostics and saved observations.
        observation["result"] = "failed"
        try:
            save(directory, "oauth-" + phase + "-" + stamp + ".json", observation)
        except (CheckFailure, OSError):
            pass
        print("FAILED: live OAuth phase did not complete; inspect deployment privately and recorded cleanup status")
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("preflight", "start", "session", "record", "refresh", "logout"), default="preflight")
    return run(os.environ, parser.parse_args().phase)


if __name__ == "__main__":
    raise SystemExit(main())
