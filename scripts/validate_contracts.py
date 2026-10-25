#!/usr/bin/env python3
"""Offline, dependency-pinned OpenAPI 1.2.0/schema, lexicon and frozen contract regression checks.

Contract v1.1 (ADR 0004 §9) is frozen inside v1.2 (ADR 0005 B14, B13): every v1.1 route, status matrix and
payload shape is unchanged except the additive optional Scrobble fields, the v1.2 cookie routes are additive, and
the lexicons only gain optional fields and the new love collection.
"""

from __future__ import annotations

import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
from importlib import metadata
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
API = ROOT / 'api'
METHODS = {'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'}
CLOCK = datetime(2026, 1, 15, 12, tzinfo=timezone.utc)
# Unicode White_Space, matching Rust str::trim rather than Python's broader
# isspace(), which additionally recognizes U+001C–U+001F control characters.
UNICODE_WHITE_SPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'
OPENAPI_SCHEMA_SHA256 = 'da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0'


class ContractError(Exception):
    """A reproducible contract violation; always produces a failing exit status."""


def require(condition, message):
    if not condition:
        raise ContractError(message)


def load_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ContractError(f'{path.relative_to(ROOT)}: {error}') from error


def check_dependencies():
    for line in (API / 'requirements-contracts.txt').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        name, expected = line.split('==', 1)
        try:
            actual = metadata.version(name)
        except metadata.PackageNotFoundError as error:
            raise ContractError(f'Missing {line}; install api/requirements-contracts.txt before validation.') from error
        require(actual == expected, f'{name}: installed {actual}, expected {expected}; install api/requirements-contracts.txt before validation.')


def parse_timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp is not a string')
    if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|\+00:00)', value):
        raise ValueError('not a UTC RFC3339 timestamp')
    parsed = datetime.fromisoformat(value.replace('z', '+00:00').replace('Z', '+00:00'))
    if parsed < datetime(1970, 1, 1, tzinfo=timezone.utc):
        raise ValueError('timestamp precedes 1970')
    return parsed


def valid_did(value):
    if not isinstance(value, str) or len(value) > 2048:
        return False
    if not re.fullmatch(r'did:[a-z]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+', value) or value.endswith(':'):
        return False
    return True


def valid_nsid(value):
    parts = value.split('.')
    return (3 <= len(parts) and len(value) <= 317 and
            parts[0][0:1].isalpha() and
            all(len(p) <= 63 and re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?', p) for p in parts[:-1]) and
            len(parts[-1]) <= 63 and re.fullmatch(r'[A-Za-z][A-Za-z0-9]*', parts[-1]) is not None)


def valid_at_uri(value):
    if not isinstance(value, str):
        return False
    parts = value.removeprefix('at://').split('/')
    return (value.startswith('at://') and len(parts) == 3 and valid_did(parts[0]) and valid_nsid(parts[1]) and
            1 <= len(parts[2]) <= 512 and parts[2] not in ('.', '..') and
            re.fullmatch(r'[A-Za-z0-9._~:-]+', parts[2]) is not None)


def valid_cid(value):
    if not isinstance(value, str) or not re.fullmatch(r'b[a-z2-7]+', value):
        return False
    try:
        raw = base64.b32decode(value[1:].upper() + '=' * (-len(value[1:]) % 8))
    except ValueError:
        return False
    # CIDv1, DAG-CBOR codec, SHA-256 multihash, 32-byte digest.
    return len(raw) == 36 and raw[:4] == bytes([1, 0x71, 0x12, 0x20]) and ('b' + base64.b32encode(raw).decode().lower().rstrip('=')) == value


def valid_handle(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 253:
        return False
    labels = value.split('.')
    return (len(labels) >= 2 and not labels[-1][0:1].isdigit() and
            all(1 <= len(label) <= 63 and re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?', label) for label in labels))


def build_validator():
    from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators

    checker = FormatChecker()

    @checker.checks('at-utc-datetime', raises=(ValueError, OverflowError))
    def timestamp(value):
        if not isinstance(value, str):
            return True  # JSON Schema type handles nonstrings.
        parse_timestamp(value)
        return True

    @checker.checks('music-text', raises=UnicodeError)
    def music_text(value):
        if not isinstance(value, str):
            return True
        trimmed = value.strip(UNICODE_WHITE_SPACE)
        return bool(trimmed) and len(value) <= 256 and len(value.encode('utf-8')) <= 1024

    checker.checks('at-did')(lambda value: not isinstance(value, str) or valid_did(value))
    checker.checks('at-record-uri')(lambda value: not isinstance(value, str) or valid_at_uri(value))
    checker.checks('at-record-cid')(lambda value: not isinstance(value, str) or valid_cid(value))
    checker.checks('at-handle')(lambda value: not isinstance(value, str) or valid_handle(value))

    def maximum_future(validator, seconds, instance, schema):
        if not isinstance(instance, str):
            return
        try:
            parsed = parse_timestamp(instance)
        except (ValueError, OverflowError):
            return  # The timestamp format emits the primary error.
        maximum = CLOCK + timedelta(seconds=seconds)
        fraction = re.search(r'\.([0-9]+)', instance)
        # datetime preserves six fractional digits, whereas Rust chrono and
        # RFC3339 inputs can contain nanoseconds. Do not truncate a +1ns bypass
        # at the inclusive future boundary into an accepted microsecond.
        positive_submicrosecond = fraction and any(digit != '0' for digit in fraction[1][6:])
        if parsed > maximum or (parsed == maximum and positive_submicrosecond):
            yield ValidationError(f'timestamp exceeds receipt time plus {seconds} seconds')

    def json_integer_representation(validator, required, instance, schema):
        if required and not (isinstance(instance, int) and not isinstance(instance, bool)):
            yield ValidationError('expected a JSON integer representation, not a decimal or boolean')

    def maximum_utf8_bytes(validator, limit, instance, schema):
        if isinstance(instance, str):
            try:
                size = len(instance.encode('utf-8'))
            except UnicodeError:
                yield ValidationError('string is not valid Unicode scalar text')
                return
            if size > limit:
                yield ValidationError(f'string exceeds {limit} UTF-8 bytes')

    return validators.extend(Draft202012Validator, {'x-maxFutureSeconds': maximum_future,
                                                    'x-jsonIntegerRepresentation': json_integer_representation,
                                                    'x-maxUtf8Bytes': maximum_utf8_bytes}), checker


def dereference(spec, value):
    while isinstance(value, dict) and '$ref' in value:
        reference = value['$ref']
        require(reference.startswith('#/'), f'External reference forbidden during offline validation: {reference}')
        current = spec
        for segment in reference[2:].split('/'):
            key = segment.replace('~1', '/').replace('~0', '~')
            require(key in current, f'Unresolved reference: {reference}')
            current = current[key]
        value = current
    return value


def walk_refs(spec, value):
    if isinstance(value, dict):
        if '$ref' in value:
            dereference(spec, value)
        for child in value.values():
            walk_refs(spec, child)
    elif isinstance(value, list):
        for child in value:
            walk_refs(spec, child)


def schema_validator(spec, schema, validator_type, checker):
    # All refs are checked local. The components live at the root to resolve
    # ordinary OpenAPI #/components/schemas references without remote retrieval.
    return validator_type({'components': spec['components'], **schema}, format_checker=checker)


def validate(value, schema, spec, validator_type, checker, label):
    errors = list(schema_validator(spec, schema, validator_type, checker).iter_errors(value))
    if errors:
        error = errors[0]
        location = '/'.join(str(part) for part in error.absolute_path) or '<root>'
        raise ContractError(f'{label}: schema violation at {location}: {error.message}')


def operations(spec):
    return {(method.upper(), path): operation for path, item in spec['paths'].items()
            for method, operation in item.items() if method in METHODS}


CONTRACT_VERSION = '1.2.0'

# This status matrix is independent of the document and its fixture inventory.
# The v1.1 entries are frozen in MVP.md and API.md as amended by ADR 0004 §9
# (A3, A8, A9, A10, N1–N3); ADR 0005 B14 keeps every one of them.
V11_STATUSES = {
    ('GET', '/health/live'): {200},
    ('GET', '/health/ready'): {200, 503},
    ('GET', '/api/v1/meta'): {200, 429},
    # B14: the dynamic confidential-client document (ADR 0005 §5.3); same path, same status.
    ('GET', '/oauth/client-metadata.json'): {200},
    ('GET', '/api/v1/resolve'): {200, 404, 422, 429, 502},
    ('GET', '/api/v1/scrobbles/{id}'): {200, 404, 422, 429},
    ('GET', '/api/v1/users/{did}/scrobbles'): {200, 400, 422, 429},
    # A8: following requires viewer=<did> (422), never a session (no 401).
    ('GET', '/api/v1/feed'): {200, 400, 422, 429},
    ('GET', '/api/v1/users/{did}/profile'): {200, 404, 422, 429},
    ('GET', '/api/v1/users/{did}/stats'): {200, 422, 429},
    ('GET', '/api/v1/users/{did}/following'): {200, 400, 422, 429},
    ('GET', '/api/v1/users/{did}/followers'): {200, 400, 422, 429},
    ('GET', '/api/v1/users/{did}/export'): {200, 404, 422, 429},
    ('POST', '/api/v1/notify'): {202, 400, 413, 422, 429, 503},
    ('GET', '/api/v1/records/status'): {200, 422, 429},
}

# ADR 0005 §5.7, §11.4, §12.1 and B14: the v1.2 cookie, write, account,
# credential, link and import routes, and the JWKS document.
V12_STATUSES = {
    ('GET', '/oauth/jwks.json'): {200},
    ('POST', '/api/v1/auth/start'): {200, 400, 403, 413, 422, 429, 502},
    ('GET', '/oauth/callback'): {303, 403, 502},
    ('GET', '/api/v1/auth/session'): {200, 401},
    ('POST', '/api/v1/auth/logout'): {204, 400, 401, 403, 413},
    ('DELETE', '/api/v1/account/connection'): {204, 401, 403},
    ('POST', '/api/v1/scrobbles'): {202, 400, 401, 403, 409, 413, 422, 503},
    ('DELETE', '/api/v1/scrobbles/{id}'): {202, 401, 403, 404, 422, 503},
    ('PUT', '/api/v1/follows/{did}'): {202, 401, 403, 422, 503},
    ('DELETE', '/api/v1/follows/{did}'): {202, 401, 403, 422, 503},
    ('PUT', '/api/v1/loves'): {202, 400, 401, 403, 413, 422, 503},
    ('DELETE', '/api/v1/loves'): {202, 401, 403, 422, 503},
    ('PUT', '/api/v1/account/indexing'): {202, 400, 401, 403, 413, 422, 503},
    ('GET', '/api/v1/operations/{id}'): {200, 401, 404},
    ('GET', '/api/v1/account'): {200, 401},
    ('PATCH', '/api/v1/account'): {200, 400, 401, 403, 409, 413, 422},
    ('GET', '/api/v1/account/ignored-listens'): {200, 400, 401, 422},
    ('GET', '/api/v1/account/credentials'): {200, 401},
    ('POST', '/api/v1/account/app-passwords'): {201, 400, 401, 403, 413, 422},
    ('DELETE', '/api/v1/account/app-passwords/{id}'): {204, 401, 403, 404},
    ('POST', '/api/v1/account/listenbrainz-tokens'): {201, 400, 401, 403, 413, 422},
    ('DELETE', '/api/v1/account/listenbrainz-tokens/{id}'): {204, 401, 403, 404},
    ('POST', '/api/v1/account/lastfm-apps'): {201, 400, 401, 403, 413, 422},
    ('DELETE', '/api/v1/account/lastfm-apps/{apiKey}'): {204, 401, 403, 404},
    ('DELETE', '/api/v1/account/lastfm-sessions/{id}'): {204, 401, 403, 404},
    ('POST', '/api/v1/lastfm/authorize'): {200, 400, 401, 403, 404, 413, 422},
    ('GET', '/api/v1/links'): {200, 401},
    ('POST', '/api/v1/links/lastfm/start'): {200, 401, 403, 503},
    ('GET', '/api/v1/links/lastfm/callback'): {303, 401, 403, 502},
    ('POST', '/api/v1/links/listenbrainz'): {201, 400, 401, 403, 413, 422, 502},
    ('PATCH', '/api/v1/links/{id}'): {200, 400, 401, 403, 404, 413, 422},
    ('DELETE', '/api/v1/links/{id}'): {204, 401, 403, 404},
    ('GET', '/api/v1/imports'): {200, 401},
    ('POST', '/api/v1/imports'): {202, 400, 401, 403, 409, 413, 422, 503},
    ('POST', '/api/v1/imports/upload'): {202, 401, 403, 409, 413, 422, 429, 503, 507},
    ('GET', '/api/v1/imports/{id}'): {200, 401, 404},
    ('POST', '/api/v1/imports/{id}/cancel'): {200, 401, 403, 404},
    ('POST', '/api/v1/imports/{id}/resume'): {200, 401, 403, 404},
}
EXPECTED_STATUSES = {**V11_STATUSES, **V12_STATUSES}

# ADR 0005 §5.7 "Not restored": these v1.0 routes stay dropped, with their schema.
NOT_RESTORED_ROUTES = {('GET', '/api/v1/account/export'), ('DELETE', '/api/v1/account/local-data')}
NOT_RESTORED_SCHEMAS = {'AccountExport'}
# The §5.7 "Writes": publication-gated (503 publication_disabled) and answered 202 Accepted.
WRITE_ROUTES = {
    ('POST', '/api/v1/scrobbles'), ('DELETE', '/api/v1/scrobbles/{id}'), ('PUT', '/api/v1/follows/{did}'),
    ('DELETE', '/api/v1/follows/{did}'), ('PUT', '/api/v1/loves'), ('DELETE', '/api/v1/loves'),
    ('PUT', '/api/v1/account/indexing'),
}
# Each named v1.2 error response must declare these codes (x-error-codes) and bind a fixture for each.
REQUIRED_ERROR_CODES = {
    ('POST', '/api/v1/scrobbles', 400): {'idempotency_key_required', 'invalid_idempotency_key'},
    ('POST', '/api/v1/scrobbles', 409): {'idempotency_conflict'},
    ('POST', '/api/v1/auth/start', 403): {'csrf_failed', 'signin_not_allowed'},
    ('POST', '/api/v1/auth/start', 502): {'oauth_upstream'},
    ('GET', '/oauth/callback', 403): {'oauth_binding_mismatch', 'signin_not_allowed'},
    ('GET', '/oauth/callback', 502): {'oauth_upstream'},
    ('PATCH', '/api/v1/account', 409): {'username_taken'},
    ('PATCH', '/api/v1/account', 422): {'username_invalid', 'validation_failed'},
    ('POST', '/api/v1/imports', 409): {'import_active'},
    ('POST', '/api/v1/imports', 503): {'publication_disabled', 'lastfm_not_configured'},
    ('POST', '/api/v1/imports/upload', 507): {'insufficient_storage'},
    ('POST', '/api/v1/links/lastfm/start', 503): {'lastfm_not_configured'},
}
# The v1.2 error vocabulary with the status each is served with (ADR 0005 §5.6–§5.8, §11). A code
# that packages/core/src/errors.ts does not define yet is reported pending: the implementing
# packages add it (no wave-0 package owns errors.ts), and once defined its DEFAULT_STATUS must agree.
V12_ERROR_CODES = {
    'unauthenticated': 401, 'csrf_failed': 403, 'signin_not_allowed': 403, 'oauth_binding_mismatch': 403,
    'idempotency_key_required': 400, 'invalid_idempotency_key': 400, 'idempotency_conflict': 409,
    'username_taken': 409, 'import_active': 409, 'username_invalid': 422, 'oauth_upstream': 502,
    'publication_disabled': 503, 'lastfm_not_configured': 503, 'insufficient_storage': 507,
}
SESSION_SCHEMES = {
    'SessionCookie': {'type': 'apiKey', 'in': 'cookie', 'name': '__Host-atmusic_session'},
    'CsrfToken': {'type': 'apiKey', 'in': 'header', 'name': 'X-CSRF-Token'},
}
LIST_ROUTES = {
    ('GET', '/api/v1/users/{did}/scrobbles'), ('GET', '/api/v1/feed'),
    ('GET', '/api/v1/users/{did}/following'), ('GET', '/api/v1/users/{did}/followers'),
}
NO_STORE_RESPONSES = {
    ('GET', '/api/v1/users/{did}/export', 200), ('GET', '/api/v1/records/status', 200),
    ('GET', '/api/v1/auth/session', 200), ('GET', '/api/v1/operations/{id}', 200), ('GET', '/api/v1/account', 200),
    ('GET', '/api/v1/account/ignored-listens', 200), ('GET', '/api/v1/account/credentials', 200),
    ('POST', '/api/v1/account/app-passwords', 201), ('POST', '/api/v1/account/listenbrainz-tokens', 201),
    ('POST', '/api/v1/account/lastfm-apps', 201), ('POST', '/api/v1/lastfm/authorize', 200),
    ('GET', '/api/v1/links', 200), ('POST', '/api/v1/links/lastfm/start', 200), ('GET', '/api/v1/imports', 200),
    ('GET', '/api/v1/imports/{id}', 200),
}
NOTIFY_MAX_BODY_BYTES = 2048
V12_MAX_BODY_BYTES = 65536
UPLOAD_MAX_BODY_BYTES = 64 * 1024 * 1024
# The v1.1 response-case inventory (api/examples/response-cases.json) is what the SPA's contract
# test consumes until N5-01; the v1.2 inventory lives beside the v1.2 fixtures. The one v1.1 route
# whose payload B14 changed is re-bound there; its v1.1 case keeps the legacy static-asset fixture,
# validated against the retained OAuthClientMetadata schema that scripts/gen-config.ts still emits.
V11_CASES = 'response-cases.json'
V12_CASES = 'v1.2/response-cases.json'
INVENTORY_FILES = {V11_CASES, 'schema-cases.json', V12_CASES}
LEGACY_CASES = {('GET', '/oauth/client-metadata.json', 200): 'OAuthClientMetadata'}
LEXICON_PREFIX = 'com.example.atmusic'
LEXICON_COLLECTIONS = {'scrobble', 'follow', 'settings', 'love'}

# Inline object shapes of every v1.1 component schema, recorded from the 1.1.0 document:
# {schema: {path: (properties, required)}}. v1.2 may add optional properties but never drops a
# property or changes a required set (B14).
V11_SHAPES = {
    'Indexing': {
        '': (['caughtUp', 'lagSeconds', 'lastIndexedAt', 'state'], ['caughtUp', 'lagSeconds', 'lastIndexedAt', 'state']),
    },
    'Error': {
        '': (['error'], ['error']),
        '.error': (['code', 'fields', 'message', 'requestId'], ['code', 'message', 'requestId']),
    },
    'Live': {'': (['status'], ['status'])},
    'Ready': {'': (['status'], ['status'])},
    'Meta': {
        '': (['capabilities', 'indexing', 'lexiconPrefix', 'name', 'stage', 'version'],
             ['capabilities', 'indexing', 'lexiconPrefix', 'name', 'stage', 'version']),
    },
    'ResolvedIdentity': {'': (['did', 'handle', 'verified'], ['did', 'handle', 'verified'])},
    'ScrobbleInput': {
        '': (['album', 'artist', 'durationSeconds', 'listenedAt', 'recordingMbid', 'track'], ['artist', 'listenedAt', 'track']),
    },
    'Scrobble': {
        '': (['album', 'artist', 'cid', 'createdAt', 'did', 'durationSeconds', 'indexedAt', 'listenedAt', 'recordingMbid',
              'revision', 'track', 'uri'],
             ['artist', 'cid', 'createdAt', 'did', 'indexedAt', 'listenedAt', 'revision', 'track', 'uri']),
    },
    'Follow': {'': (['actor', 'cid', 'createdAt', 'subject', 'uri'], ['actor', 'cid', 'createdAt', 'subject', 'uri'])},
    'Profile': {
        '': (['did', 'followerCount', 'followingCount', 'handle', 'indexedAt', 'indexing', 'joinedAt', 'totalScrobbles'],
             ['did', 'followerCount', 'followingCount', 'handle', 'indexedAt', 'indexing', 'joinedAt', 'totalScrobbles']),
    },
    'Statistics': {
        '': (['asOf', 'did', 'distinctArtists', 'distinctTracks', 'topAlbums', 'topArtists', 'topTracks', 'totalScrobbles', 'window'],
             ['asOf', 'did', 'distinctArtists', 'distinctTracks', 'topAlbums', 'topArtists', 'topTracks', 'totalScrobbles', 'window']),
        '.topArtists[]': (['artist', 'scrobbleCount'], ['artist', 'scrobbleCount']),
        '.topTracks[]': (['artist', 'scrobbleCount', 'track'], ['artist', 'scrobbleCount', 'track']),
        '.topAlbums[]': (['album', 'artist', 'scrobbleCount'], ['album', 'artist', 'scrobbleCount']),
    },
    'OAuthClientMetadata': {
        '': (['application_type', 'client_id', 'client_name', 'client_uri', 'contacts', 'dpop_bound_access_tokens', 'grant_types',
              'logo_uri', 'policy_uri', 'redirect_uris', 'response_types', 'scope', 'token_endpoint_auth_method', 'tos_uri'],
             ['application_type', 'client_id', 'dpop_bound_access_tokens', 'grant_types', 'redirect_uris', 'response_types', 'scope',
              'token_endpoint_auth_method']),
    },
    'ScrobblePage': {'': (['asOf', 'indexing', 'items', 'nextCursor'], ['asOf', 'indexing', 'items', 'nextCursor'])},
    'ScrobbleResult': {'': (['scrobble'], ['scrobble'])},
    'FollowPage': {'': (['asOf', 'indexing', 'items', 'nextCursor'], ['asOf', 'indexing', 'items', 'nextCursor'])},
    'Export': {
        '': (['did', 'exportedAt', 'follows', 'indexing', 'schemaVersion', 'scrobbles'],
             ['did', 'exportedAt', 'follows', 'indexing', 'schemaVersion', 'scrobbles']),
    },
    'NotifyInput': {'<oneOf0>': (['uri'], ['uri']), '<oneOf1>': (['did'], ['did'])},
    'NotifyAccepted': {'': (['state'], ['state'])},
    'RecordStatus': {'': (['cid', 'indexing', 'reason', 'revision', 'state', 'uri'], ['indexing', 'state', 'uri'])},
}
# The response schema of every v1.1 operation status, from the 1.1.0 document. B14 re-binds only
# the client metadata document (static public client -> dynamic confidential client).
V11_REBOUND = {('GET', '/oauth/client-metadata.json', 200): 'ConfidentialClientMetadata'}


def object_shapes(schema, path=''):
    """Inline object shapes of one schema: {path: (properties, required)}; $ref children are separate schemas."""
    out = {}
    if not isinstance(schema, dict) or '$ref' in schema:
        return out
    if 'properties' in schema:
        out[path] = (sorted(schema['properties']), sorted(schema.get('required', [])))
        for name, child in schema['properties'].items():
            out.update(object_shapes(child, f'{path}.{name}'))
    if 'items' in schema:
        out.update(object_shapes(schema['items'], f'{path}[]'))
    for key in ('oneOf', 'anyOf', 'allOf'):
        for index, child in enumerate(schema.get(key, [])):
            if isinstance(child, dict) and 'properties' in child:
                out.update(object_shapes(child, f'{path}<{key}{index}>'))
    return out


def v11_compatibility(spec):
    """Every v1.1 schema keeps every property and its required set; v1.1 routes keep their response schemas (B14)."""
    schemas = spec['components']['schemas']
    for name, frozen in V11_SHAPES.items():
        require(name in schemas, f'v1.1 compatibility: schema {name} was removed')
        current = object_shapes(schemas[name])
        for path, (properties, required) in frozen.items():
            label = f'{name}{path}'
            require(path in current, f'v1.1 compatibility: {label} is no longer an object with properties')
            lost = sorted(set(properties) - set(current[path][0]))
            require(not lost, f'v1.1 compatibility: {label} lost properties {lost}')
            require(current[path][1] == required,
                    f'v1.1 compatibility: {label} changed its required set from {required} to {current[path][1]}')
            if path == '' and name != 'NotifyInput':
                # Every v1.1 object stays closed; only the legacy client metadata admits extension fields.
                require(schemas[name].get('additionalProperties') is (name == 'OAuthClientMetadata'),
                        f'v1.1 compatibility: {name} changed additionalProperties')
    found = operations(spec)
    checked = 0
    for (method, path), statuses in V11_STATUSES.items():
        for status in statuses:
            response = found[(method, path)]['responses'][str(status)]
            schema = response.get('content', {}).get('application/json', {}).get('schema', {}).get('$ref', '').rsplit('/', 1)[-1]
            expected = V11_REBOUND.get((method, path, status))
            if expected:
                require(schema == expected, f'v1.1 compatibility: {method} {path} {status} must respond with {expected}')
            elif status >= 400:
                require(schema == 'Error', f'v1.1 compatibility: {method} {path} {status} must respond with Error')
            checked += 1
    return len(V11_SHAPES), checked


def section_routes(text):
    return {(method, path.split('?', 1)[0]) for method, path in re.findall(r'\b(GET|POST|PUT|PATCH|DELETE)\s+(/[^\s;|`]+)', text)}


def route_inventory(spec, mvp=None, api=None):
    """MVP.md lists exactly the frozen v1.1 routes; API.md and openapi.yaml list exactly v1.1 plus v1.2, with exact status matrices.

    `mvp` and `api` override the document texts (the negative controls pass mutated copies).
    """
    found = operations(spec)
    mvp = (ROOT / 'docs/planning/MVP.md').read_text() if mvp is None else mvp
    api = (ROOT / 'docs/planning/API.md').read_text() if api is None else api
    require('## API contract to freeze in M1' in mvp and '## Completion and execution rules' in mvp,
            'route_inventory: MVP.md lost its API contract section')
    section = mvp.split('## API contract to freeze in M1', 1)[1].split('## Completion and execution rules', 1)[0]
    documented = section_routes(section)
    fixed = {(method, path) for method, path in re.findall(r'\| (GET|POST|PUT|PATCH|DELETE) `([^`]+)`', api)}
    differences = {label: (sorted(routes - expected), sorted(expected - routes))
                   for label, routes, expected in [('MVP.md', documented, set(V11_STATUSES)),
                                                   ('API.md', fixed, set(EXPECTED_STATUSES)),
                                                   ('openapi', set(found), set(EXPECTED_STATUSES))] if routes != expected}
    require(not differences, 'route_inventory: route sets differ from the inventory (MVP.md: v1.1; API.md and openapi: v1.1 + v1.2); ' +
            '; '.join(f'{label} extra={extra} missing={missing}' for label, (extra, missing) in differences.items()))
    ids = [operation.get('operationId') for operation in found.values()]
    require(all(ids) and len(set(ids)) == len(ids), 'route_inventory: duplicate or missing operationId')
    for key, operation in found.items():
        require({int(status) for status in operation['responses']} == EXPECTED_STATUSES[key], f'route_inventory: incorrect status matrix for {key}')
        params = [dereference(spec, p) for p in operation.get('parameters', [])]
        expected_path_fields = set(re.findall(r'\{([^}]+)\}', key[1]))
        actual_path_fields = {p['name'] for p in params if p['in'] == 'path' and p.get('required')}
        require(expected_path_fields == actual_path_fields, f'route_inventory: missing required path field for {key}')
        require((key in V12_STATUSES) == (operation.get('x-contract') == '1.2'), f'route_inventory: {key} must carry x-contract 1.2 exactly when it is a v1.2 route')
    for method, path, status in NO_STORE_RESPONSES:
        header = found[(method, path)]['responses'][str(status)].get('headers', {}).get('Cache-Control', {})
        require(header.get('required') is True and header.get('schema') == {'const': 'no-store'},
                f'route_inventory: {method} {path} {status} must declare Cache-Control: no-store')
    disposition = found[('GET', '/api/v1/users/{did}/export')]['responses']['200']['headers'].get('Content-Disposition', {})
    require(disposition.get('required') is True and disposition.get('schema') == {'const': 'attachment; filename="music-export.json"'},
            'route_inventory: export must be the music-export.json attachment (A9)')
    for key in [('POST', '/api/v1/notify'), ('POST', '/api/v1/auth/start'), ('POST', '/api/v1/imports/upload')]:
        retry = found[key]['responses']['429'].get('headers', {}).get('Retry-After', {})
        require(retry.get('required') is True, f'route_inventory: {key} 429 must declare Retry-After')
    for key in [('GET', '/oauth/callback'), ('GET', '/api/v1/links/lastfm/callback')]:
        location = found[key]['responses']['303'].get('headers', {}).get('Location', {})
        require(location.get('required') is True and 'content' not in found[key]['responses']['303'],
                f'route_inventory: {key} 303 must declare a Location header and no body')
    return len(found)


def route_inventory_controls(spec):
    """route_inventory must reject an omitted route, an undocumented method or route, and a changed status matrix.

    Each control mutates an in-memory copy of openapi.yaml, MVP.md or API.md; repository files are never altered.
    Returns the labels of the rejected mutations.
    """
    mvp = (ROOT / 'docs/planning/MVP.md').read_text()
    api = (ROOT / 'docs/planning/API.md').read_text()

    def spec_with(mutate):
        mutated = deepcopy(spec)
        mutate(mutated)
        return mutated

    def replaced(text, needle, replacement=''):
        require(text.count(needle) == 1, f'route_inventory_controls: expected exactly one {needle!r}')
        return text.replace(needle, replacement)

    def add_status(mutated, path, method, status, like):
        responses = mutated['paths'][path][method]['responses']
        responses[status] = deepcopy(responses[like])

    meta_get = spec['paths']['/api/v1/meta']['get']
    controls = [
        ('openapi omits GET /health/live',
         spec_with(lambda m: m['paths'].pop('/health/live')), None, None,
         "openapi extra=[] missing=[('GET', '/health/live')]"),
        ('openapi omits POST /api/v1/notify',
         spec_with(lambda m: m['paths'].pop('/api/v1/notify')), None, None,
         "openapi extra=[] missing=[('POST', '/api/v1/notify')]"),
        ('openapi omits v1.2 POST /api/v1/scrobbles',
         spec_with(lambda m: m['paths'].pop('/api/v1/scrobbles')), None, None,
         "openapi extra=[] missing=[('POST', '/api/v1/scrobbles')]"),
        ('openapi adds undocumented DELETE /api/v1/meta',
         spec_with(lambda m: m['paths']['/api/v1/meta'].update(delete={**deepcopy(meta_get), 'operationId': 'deleteMeta'})), None, None,
         "openapi extra=[('DELETE', '/api/v1/meta')] missing=[]"),
        ('openapi adds undocumented GET /api/v1/extra',
         spec_with(lambda m: m['paths'].update({'/api/v1/extra': {'get': {**deepcopy(meta_get), 'operationId': 'getExtra'}}})), None, None,
         "openapi extra=[('GET', '/api/v1/extra')] missing=[]"),
        ('openapi adds status 500 to GET /health/ready',
         spec_with(lambda m: add_status(m, '/health/ready', 'get', '500', '503')), None, None,
         "incorrect status matrix for ('GET', '/health/ready')"),
        ('openapi drops status 503 from GET /health/ready',
         spec_with(lambda m: m['paths']['/health/ready']['get']['responses'].pop('503')), None, None,
         "incorrect status matrix for ('GET', '/health/ready')"),
        ('openapi drops status 413 from POST /api/v1/notify',
         spec_with(lambda m: m['paths']['/api/v1/notify']['post']['responses'].pop('413')), None, None,
         "incorrect status matrix for ('POST', '/api/v1/notify')"),
        ('openapi drops status 409 from POST /api/v1/scrobbles',
         spec_with(lambda m: m['paths']['/api/v1/scrobbles']['post']['responses'].pop('409')), None, None,
         "incorrect status matrix for ('POST', '/api/v1/scrobbles')"),
        ('MVP.md omits GET /api/v1/records/status',
         spec, replaced(mvp, '; GET /api/v1/records/status?uri=... (N2)'), None,
         "MVP.md extra=[] missing=[('GET', '/api/v1/records/status')]"),
        ('MVP.md adds undocumented POST /api/v1/scrobbles',
         spec, replaced(mvp, '| Indexing | POST /api/v1/notify (N1);', '| Indexing | POST /api/v1/notify (N1); POST /api/v1/scrobbles;'), None,
         "MVP.md extra=[('POST', '/api/v1/scrobbles')] missing=[]"),
        ('API.md omits GET /api/v1/users/{did}/export',
         spec, None, replaced(api, '| GET `/api/v1/users/{did}/export` |', '| `/api/v1/users/{did}/export` |'),
         "API.md extra=[] missing=[('GET', '/api/v1/users/{did}/export')]"),
        ('API.md omits v1.2 DELETE /api/v1/account/connection',
         spec, None, replaced(api, '| DELETE `/api/v1/account/connection` |', '| `/api/v1/account/connection` |'),
         "API.md extra=[] missing=[('DELETE', '/api/v1/account/connection')]"),
        ('API.md adds undocumented GET /api/v1/extra',
         spec, None, api + '\n| GET `/api/v1/extra` | none | 200 |\n',
         "API.md extra=[('GET', '/api/v1/extra')] missing=[]"),
    ]
    rejected = []
    for label, mutated_spec, mutated_mvp, mutated_api, expected in controls:
        try:
            route_inventory(mutated_spec, mvp=mutated_mvp, api=mutated_api)
        except ContractError as error:
            # Rejected for the mutation itself, not for an unrelated reason.
            require(expected in str(error), f'route_inventory rejected {label} without reporting {expected!r}: {error}')
            rejected.append(label)
            continue
        raise ContractError('route_inventory did not reject ' + label)
    return rejected


ERRORS_TS = ROOT / 'packages/core/src/errors.ts'


def _example_names(case):
    return [name for name in [case.get('example'), *(variant['example'] for variant in case.get('alternatives', []))] if name]


def _example_file(spec, name):
    """The api/examples-relative file of a component example name."""
    return spec['components']['examples'][name]['externalValue'][len('examples/'):]


def load_cases():
    return {V11_CASES: load_json(API / 'examples' / V11_CASES), V12_CASES: load_json(API / 'examples' / V12_CASES)}


def error_codes(spec, cases=None, errors_ts=None, vocabulary=None):
    """Every error envelope fixture uses a code errors.ts defines with its DEFAULT_STATUS, or a v1.2 code still pending there.

    Returns (codes used, codes defined in errors.ts, sorted v1.2 codes errors.ts does not define yet).
    """
    text = ERRORS_TS.read_text() if errors_ts is None else errors_ts
    vocabulary = V12_ERROR_CODES if vocabulary is None else vocabulary
    union = re.search(r'export const ERROR_CODES = \[(.*?)\] as const;', text, re.S)
    defaults = re.search(r'export const DEFAULT_STATUS[^=]*= \{(.*?)\};', text, re.S)
    require(union is not None and defaults is not None, 'error_codes: errors.ts lost ERROR_CODES or DEFAULT_STATUS')
    codes = re.findall(r"^\s*'([a-z_]+)',", union.group(1), re.M)
    statuses = {code: int(status) for code, status in re.findall(r'^\s*([a-z_]+): (\d{3}),', defaults.group(1), re.M)}
    require(codes and len(set(codes)) == len(codes), 'error_codes: ERROR_CODES is empty or repeats a code')
    require(set(codes) == set(statuses), f'error_codes: ERROR_CODES and DEFAULT_STATUS differ: {sorted(set(codes) ^ set(statuses))}')
    for code, status in vocabulary.items():
        require(code not in statuses or statuses[code] == status,
                f'error_codes: errors.ts serves the v1.2 code {code} as {statuses.get(code)}, but the contract says {status}')
    cases = load_cases() if cases is None else cases
    used, pending = set(), set()
    for inventory, entries in cases.items():
        for case in entries:
            for name in _example_names(case):
                path = _example_file(spec, name) if name in spec['components']['examples'] else f'{name}.json'
                if not Path(path).name.startswith('error'):
                    continue
                code = load_json(API / 'examples' / path)['error']['code']
                expected = statuses.get(code, vocabulary.get(code))
                require(expected is not None, f'error_codes: {path} uses {code!r}, which neither errors.ts nor the v1.2 vocabulary defines')
                require(expected == case['status'],
                        f'error_codes: {path} ({code}) is served as {case["status"]} but its status is {expected}')
                used.add(code)
                if code not in statuses:
                    pending.add(code)
    bound = {(_example_file(spec, name) if name in spec['components']['examples'] else f'{name}.json')
             for entries in cases.values() for case in entries for name in _example_names(case)}
    on_disk = {str(p.relative_to(API / 'examples')) for p in (API / 'examples').rglob('error*.json')}
    unbound = sorted(on_disk - bound)
    require(not unbound, f'error_codes: error examples bound to no response case: {unbound}')
    return len(used), len(codes), sorted(pending)


def error_code_controls(spec):
    """error_codes must reject an example code nobody defines and a status that disagrees with DEFAULT_STATUS or the v1.2 table."""
    text = ERRORS_TS.read_text()
    cases = load_cases()

    def replaced(needle, replacement):
        require(text.count(needle) == 1, f'error_code_controls: expected exactly one {needle!r}')
        return text.replace(needle, replacement)

    removed = replaced("  'validation_failed', //", '  //')
    removed = removed.replace('  validation_failed: 422,\n', '', 1)
    v11 = cases[V11_CASES]
    v12 = cases[V12_CASES]
    controls = [
        ('validation_failed removed from errors.ts', None, removed, None,
         "error-422.json uses 'validation_failed', which neither errors.ts nor the v1.2 vocabulary defines"),
        ('not_ready given DEFAULT_STATUS 500', None, replaced('  not_ready: 503,', '  not_ready: 500,'), None,
         'error-503.json (not_ready) is served as 503 but its status is 500'),
        ('error-404 bound to a 422 response case',
         {V11_CASES: [{**case, 'status': 422} if case.get('example') == 'error-404' else case for case in v11], V12_CASES: v12}, None, None,
         'error-404.json (not_found) is served as 422 but its status is 404'),
        ('idempotency_conflict missing from the v1.2 vocabulary', None, None,
         {code: status for code, status in V12_ERROR_CODES.items() if code != 'idempotency_conflict'},
         "v1.2/error-409-idempotency.json uses 'idempotency_conflict', which neither errors.ts nor the v1.2 vocabulary defines"),
        ('csrf_failed defined in errors.ts with status 400', None,
         replaced("  'bad_request', //", "  'csrf_failed', //\n  'bad_request', //").replace('  bad_request: 400,\n', '  csrf_failed: 400,\n  bad_request: 400,\n', 1),
         None, 'errors.ts serves the v1.2 code csrf_failed as 400, but the contract says 403'),
    ]
    for label, mutated_cases, mutated_text, vocabulary, expected in controls:
        try:
            error_codes(spec, cases=mutated_cases, errors_ts=mutated_text, vocabulary=vocabulary)
        except ContractError as error:
            require(expected in str(error), f'error_codes rejected {label} without reporting {expected!r}: {error}')
            continue
        raise ContractError('error_codes did not reject ' + label)
    return len(controls)


def not_restored(spec):
    """ADR 0005 §5.7: v1.0's GET /api/v1/account/export and DELETE /api/v1/account/local-data stay dropped (A9, A10 stay)."""
    found = operations(spec)
    present = sorted(NOT_RESTORED_ROUTES & set(found))
    require(not present, f'not_restored: dropped v1.0 routes present: {present}')
    schemas = sorted(NOT_RESTORED_SCHEMAS & set(spec['components']['schemas']))
    require(not schemas, f'not_restored: dropped schemas present: {schemas}')
    text = json.dumps(spec)
    for marker in ['/api/v1/account/export', '/api/v1/account/local-data', '#/components/schemas/AccountExport"']:
        require(marker not in text, f'not_restored: stale reference {marker!r}')
    return len(NOT_RESTORED_ROUTES)


def public_access(spec):
    """No v1.1 read route reads a session, cookie, CSRF token or Origin header; the OAuth documents are the confidential client."""
    found = operations(spec)
    for key in V11_STATUSES:
        operation = found[key]
        require(operation.get('security') == [], f'public_access: {key} must declare security: []')
        require(operation.get('x-auth-mode') == 'public', f'public_access: {key} must be x-auth-mode public')
        headers = [p['name'] for p in [dereference(spec, p) for p in operation.get('parameters', [])] if p['in'] in ('header', 'cookie')]
        require(not headers, f'public_access: {key} reads header/cookie parameters {headers}')
        require(not any(status in (401, 403) for status in V11_STATUSES[key]), f'public_access: {key} must never answer 401 or 403')
    metadata = found[('GET', '/oauth/client-metadata.json')]
    require('x-served-by' not in metadata, 'public_access: client metadata is served by the router, not as a static asset (ADR 0005 §5.3)')
    cache = metadata['responses']['200'].get('headers', {}).get('Cache-Control', {})
    require(cache.get('required') is True and cache.get('schema') == {'const': 'public, max-age=300'},
            'public_access: client metadata must declare Cache-Control: public, max-age=300')
    schema = spec['components']['schemas']['ConfidentialClientMetadata']
    properties = schema['properties']
    require(schema.get('additionalProperties') is False and set(schema['required']) == set(properties),
            'public_access: the confidential metadata document is exact: closed, every field required')
    require(properties['application_type'] == {'const': 'web'} and properties['token_endpoint_auth_method'] == {'const': 'private_key_jwt'}
            and properties['token_endpoint_auth_signing_alg'] == {'const': 'ES256'} and properties['dpop_bound_access_tokens'] == {'const': True},
            'public_access: client metadata must be the web confidential client: private_key_jwt with ES256 and DPoP-bound tokens')
    require(properties['redirect_uris']['items'].get('pattern') == '^https://[^/?#]+/oauth/callback$'
            and properties['redirect_uris'].get('maxItems') == 1, 'public_access: the only redirect is https://<host>/oauth/callback')
    require(properties['jwks_uri'].get('pattern') == '^https://[^/?#]+/oauth/jwks\\.json$', 'public_access: jwks_uri is https://<host>/oauth/jwks.json')
    jwks = found[('GET', '/oauth/jwks.json')]
    require(jwks.get('security') == [] and jwks['responses']['200']['content']['application/json']['schema'] == {'$ref': '#/components/schemas/Jwks'},
            'public_access: /oauth/jwks.json is public and serves Jwks')
    jwk = spec['components']['schemas']['Jwk']
    require(jwk.get('additionalProperties') is False and 'd' not in jwk['properties'] and jwk['properties']['alg'] == {'const': 'ES256'},
            'public_access: a published JWK is closed, ES256 and never carries d')
    legacy = spec['components']['schemas']['OAuthClientMetadata']
    require(legacy['properties']['token_endpoint_auth_method'] == {'const': 'none'} and
            not any(dereference(spec, r.get('content', {}).get('application/json', {}).get('schema', {})) is legacy
                    for op in found.values() for r in op['responses'].values()),
            'public_access: the legacy public-client schema is bound to no operation')
    return len(V11_STATUSES)


def session_access(spec):
    """Every v1.2 cookie route declares the session cookie; unsafe ones also CSRF and Origin, with 401/403; writes are gated."""
    found = operations(spec)
    require(spec['components'].get('securitySchemes', {}).keys() == SESSION_SCHEMES.keys() and
            all({k: v for k, v in spec['components']['securitySchemes'][name].items() if k != 'description'} == scheme
                for name, scheme in SESSION_SCHEMES.items()),
            'session_access: securitySchemes must be exactly SessionCookie (__Host-atmusic_session) and CsrfToken (X-CSRF-Token)')
    counts = {}
    for key in V12_STATUSES:
        operation = found[key]
        mode = operation.get('x-auth-mode')
        statuses = V12_STATUSES[key]
        params = {(p['in'], p['name']): p for p in [dereference(spec, p) for p in operation.get('parameters', [])]}
        responses = operation['responses']

        def codes(status):
            return set(responses.get(str(status), {}).get('x-error-codes', []))

        if mode == 'session':
            require(operation.get('security') == [{'SessionCookie': []}] and key[0] == 'GET',
                    f'session_access: {key} must be a GET with security [SessionCookie]')
            require(401 in statuses and 'unauthenticated' in codes(401), f'session_access: {key} must answer 401 unauthenticated')
        elif mode == 'session+csrf':
            require(operation.get('security') == [{'SessionCookie': [], 'CsrfToken': []}] and key[0] != 'GET',
                    f'session_access: {key} must be an unsafe method with security [SessionCookie + CsrfToken]')
            require(params.get(('header', 'Origin'), {}).get('required') is True, f'session_access: {key} must require the Origin header')
            require('unauthenticated' in codes(401) and 'csrf_failed' in codes(403), f'session_access: {key} must answer 401 unauthenticated and 403 csrf_failed')
        elif mode == 'origin':
            require(key == ('POST', '/api/v1/auth/start') and operation.get('security') == [] and
                    params.get(('header', 'Origin'), {}).get('required') is True and 'csrf_failed' in codes(403),
                    f'session_access: only auth/start is Origin-checked without a session, with 403 csrf_failed')
        elif mode == 'oauth-binding':
            require(key == ('GET', '/oauth/callback') and params.get(('cookie', '__Host-atmusic_oauth'), {}).get('required') is True,
                    'session_access: only /oauth/callback is bound to the __Host-atmusic_oauth cookie')
        elif mode == 'public':
            require(key == ('GET', '/oauth/jwks.json') and operation.get('security') == [], f'session_access: {key} may not be public')
        else:
            raise ContractError(f'session_access: {key} has unknown x-auth-mode {mode!r}')
        counts[mode] = counts.get(mode, 0) + 1
        if key in WRITE_ROUTES:
            require(202 in statuses and responses['202']['content']['application/json']['schema'] == {'$ref': '#/components/schemas/Accepted'}
                    and 'publication_disabled' in codes(503), f'session_access: write {key} must answer 202 Accepted and 503 publication_disabled')
    for (method, path, status), required in REQUIRED_ERROR_CODES.items():
        declared = set(found[(method, path)]['responses'][str(status)].get('x-error-codes', []))
        require(required <= declared, f'session_access: {method} {path} {status} must declare error codes {sorted(required - declared)}')
    scrobble = found[('POST', '/api/v1/scrobbles')]
    key_param = [dereference(spec, p) for p in scrobble['parameters'] if dereference(spec, p)['name'] == 'Idempotency-Key']
    require(key_param and key_param[0]['in'] == 'header' and key_param[0]['required'] is True and
            key_param[0]['schema'] == {'$ref': '#/components/schemas/IdempotencyKey'},
            'session_access: POST /api/v1/scrobbles must require the Idempotency-Key header')
    states = spec['components']['schemas']['Operation']['properties']['state']['enum']
    require(states == ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'],
            'session_access: Operation.state must be queued, running, succeeded, failed, blocked or cancelled')
    return counts


def query_bounds(spec, validator_type, checker):
    count = 0
    found = operations(spec)
    for key, operation in found.items():
        query = {p['name']: p for p in [dereference(spec, p) for p in operation.get('parameters', [])] if p['in'] == 'query'}
        if key in LIST_ROUTES or key == ('GET', '/api/v1/users/{did}/stats'):
            schema = query['limit']['schema']
            require(schema == {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 10 if key[1].endswith('/stats') else 20}, f'query_bounds: incorrect limit for {key}')
            for value, valid in [(1, True), (100, True), (0, False), (-1, False), (101, False), (1.5, False), ('20', False), (True, False)]:
                errors = list(schema_validator(spec, schema, validator_type, checker).iter_errors(value))
                require(not bool(errors) == valid, f'query_bounds: wrong limit acceptance {value!r} for {key}')
                count += 1
            require(('cursor' in query) == (key in LIST_ROUTES), f'query_bounds: incorrect cursor availability for {key}')
    stats = found[('GET', '/api/v1/users/{did}/stats')]
    window = next(dereference(spec, p)['schema'] for p in stats['parameters'] if dereference(spec, p)['name'] == 'window')
    require(window == {'enum': ['all', '7d', '30d', '365d'], 'default': 'all'}, 'query_bounds: incorrect statistics window')
    feed = {dereference(spec, p)['name']: dereference(spec, p) for p in found[('GET', '/api/v1/feed')]['parameters']}
    require(feed['scope']['schema'] == {'enum': ['global', 'following'], 'default': 'global'}, 'query_bounds: incorrect feed scope')
    viewer = feed.get('viewer')
    require(viewer is not None and viewer['in'] == 'query' and not viewer.get('required')
            and viewer.get('x-required-when') == {'scope': 'following'} and viewer['schema'] == {'$ref': '#/components/schemas/Did'},
            'query_bounds: feed viewer must be a DID required when scope=following (A8)')
    for value, valid in [('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', True), ('did:web:music.example', True), ('alice.test', False), ('', False), (7, False)]:
        errors = list(schema_validator(spec, viewer['schema'], validator_type, checker).iter_errors(value))
        require(not bool(errors) == valid, f'query_bounds: wrong viewer acceptance {value!r}')
        count += 1
    status = {dereference(spec, p)['name']: dereference(spec, p) for p in found[('GET', '/api/v1/records/status')]['parameters']}
    require(status['uri'].get('required') is True and status['uri']['schema'] == {'$ref': '#/components/schemas/AtUri'},
            'query_bounds: records/status requires an AT URI')
    body = found[('POST', '/api/v1/notify')]['requestBody']
    require(body.get('required') is True and body.get('x-maxBodyBytes') == NOTIFY_MAX_BODY_BYTES, 'query_bounds: notify body must be required and capped at 2 KiB (N1)')
    # v1.2: body caps (ADR 0005 §3.6), the Idempotency-Key syntax and the required query fields.
    for key in V12_STATUSES:
        body = found[key].get('requestBody')
        if body is None:
            continue
        cap = UPLOAD_MAX_BODY_BYTES if key == ('POST', '/api/v1/imports/upload') else V12_MAX_BODY_BYTES
        require(body.get('x-maxBodyBytes') == cap, f'query_bounds: {key} body must be capped at {cap} bytes')
        require(413 in V12_STATUSES[key], f'query_bounds: {key} takes a body and must answer 413')
        count += 1
    upload = found[('POST', '/api/v1/imports/upload')]['requestBody']
    require(upload.get('x-rawBody') is True and set(upload['content']) == {'application/octet-stream'},
            'query_bounds: the import upload is a raw application/octet-stream body')
    key_schema = {'$ref': '#/components/schemas/IdempotencyKey'}
    for value, valid in [('k' * 128, True), ('k' * 129, False), ('', False), ('a b', False), ('a/b', False), ('Az09._~-', True)]:
        errors = list(schema_validator(spec, key_schema, validator_type, checker).iter_errors(value))
        require(not bool(errors) == valid, f'query_bounds: wrong Idempotency-Key acceptance {value!r}')
        count += 1
    love = {dereference(spec, p)['name']: dereference(spec, p) for p in found[('DELETE', '/api/v1/loves')]['parameters']}
    require(love['artist'].get('required') is True and love['track'].get('required') is True,
            'query_bounds: DELETE /api/v1/loves requires artist and track')
    source = {dereference(spec, p)['name']: dereference(spec, p) for p in found[('POST', '/api/v1/imports/upload')]['parameters']}['source']
    require(source.get('required') is True and source['schema'] == {'enum': ['lastfm_json', 'listenbrainz_zip']},
            'query_bounds: an upload names source lastfm_json or listenbrainz_zip')
    return count


def fixture_value(spec, name):
    example = dereference(spec, {'$ref': '#/components/examples/' + name})
    require('externalValue' in example and 'value' not in example, f'response_examples: missing external fixture {name}')
    path = (API / example['externalValue']).resolve()
    require(path.is_relative_to(API / 'examples'), f'response_examples: fixture escapes examples directory: {name}')
    return load_json(path)


def response_examples(spec, validator_type, checker, validated, cases=None):
    """Every documented (method, path, status) has one case across the v1.1 and v1.2 inventories, bound to its fixture."""
    found = operations(spec)
    cases = load_cases() if cases is None else cases
    expected = {(method, path, int(status)) for (method, path), operation in found.items() for status in operation['responses']}
    inventories = {V11_CASES: {(m, p, s) for (m, p), statuses in V11_STATUSES.items() for s in statuses},
                   V12_CASES: {(m, p, s) for (m, p), statuses in V12_STATUSES.items() for s in statuses} | set(LEGACY_CASES)}
    seen = set()
    negative_count = total = 0
    for inventory, entries in cases.items():
        keys = set()
        for case in entries:
            key = (case['method'], case['path'], case['status'])
            require(key not in keys, f'response_examples: duplicate case {key} in {inventory}')
            keys.add(key)
            total += 1
            if inventory == V11_CASES and key in LEGACY_CASES:
                # The SPA still decodes the static asset until N5-01; it is not this route's 1.2 payload.
                validate(fixture_value(spec, case['example']), {'$ref': '#/components/schemas/' + LEGACY_CASES[key]},
                         spec, validator_type, checker, f'{key} legacy')
                validated.add(case['example'])
                continue
            require(key in expected, f'response_examples: undocumented response case {key}')
            seen.add(key)
            negative_count += _check_case(spec, validator_type, checker, validated, found, case, key)
        require(keys == inventories[inventory],
                f'response_examples: {inventory} must hold exactly its contract\'s cases; extra={sorted(keys - inventories[inventory])} '
                f'missing={sorted(inventories[inventory] - keys)}')
    require(seen == expected, f'response_examples: missing statuses {sorted(expected - seen)}')
    # Also validate the declared request examples, rather than assuming success
    # response coverage makes request bodies valid, and prove the request schema is closed.
    request_count = 0
    for key, operation in found.items():
        if 'requestBody' not in operation:
            continue
        if operation['requestBody'].get('x-rawBody'):
            continue  # a raw upload has no JSON request schema (query_bounds checks its cap and media type)
        media = operation['requestBody']['content']['application/json']
        name = media['examples']['fixture']['$ref'].rsplit('/', 1)[1]
        value = fixture_value(spec, name)
        validate(value, media['schema'], spec, validator_type, checker, f'{key} request')
        validated.add(name)
        corrupt = {**value, 'unexpectedField': True}
        require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: unknown request field accepted for {key}')
        request_count += 1
    return total, negative_count, request_count


def _check_case(spec, validator_type, checker, validated, found, case, key):
    response = dereference(spec, found[key[:2]]['responses'][str(key[2])])
    headers = case.get('headers', {})
    for name, header in response.get('headers', {}).items():
        header = dereference(spec, header)
        require(not header.get('required') or name in headers, f'response_examples: missing {name} for {key}')
        if name in headers:
            validate(headers[name], header['schema'], spec, validator_type, checker, f'{key} {name}')
    if 'content' not in response:
        require(case.get('body', 'missing') is None and 'example' not in case, f'response_examples: {key} must have no response body')
        return 0
    media = response['content']['application/json']
    declared_example = media['examples']['fixture']['$ref'].rsplit('/', 1)[1]
    require(case.get('example') == declared_example, f'response_examples: fixture not bound to OpenAPI example for {key}')
    allowed = response.get('x-error-codes')
    require(key[2] < 400 or key[:2] not in V12_STATUSES or allowed, f'response_examples: v1.2 error response {key} must declare x-error-codes')
    value = fixture_value(spec, case['example'])
    validate(value, media['schema'], spec, validator_type, checker, str(key))
    validated.add(case['example'])
    fixture_codes = set()
    if allowed is not None:
        require(value['error']['code'] in allowed, f'response_examples: {key} fixture code {value["error"]["code"]} is not in x-error-codes {allowed}')
        fixture_codes.add(value['error']['code'])
    envelope = value.get('error') if isinstance(value.get('error'), dict) else {}
    for name, header in response.get('headers', {}).items():
        required_codes = header.get('x-required-for-error-codes', [])
        if envelope.get('code') in required_codes:
            require(name in headers, f'response_examples: missing conditional {name} for {key}')
    # Deliberately replace a required field with a boolean. Every response
    # must reject this type change, including nested error envelopes.
    corrupt = deepcopy(value)
    first = next(iter(dereference(spec, media['schema'])['required']))
    corrupt[first] = False
    require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: wrong field type accepted for {key}')
    negative = 1
    # Alternative outcomes can share a status and envelope. Check every
    # declared variant, not just the inventory's primary case.
    for example_label, example_ref in media['examples'].items():
        alternative = example_ref['$ref'].rsplit('/', 1)[1]
        if alternative == case['example']:
            continue
        value = fixture_value(spec, alternative)
        validate(value, media['schema'], spec, validator_type, checker, f'{key} {example_label}')
        validated.add(alternative)
        variant = next((variant for variant in case.get('alternatives', []) if variant['example'] == alternative), None)
        require(variant is not None, f'response_examples: alternative fixture inventory missing for {key} {alternative}')
        if allowed is not None:
            require(value['error']['code'] in allowed, f'response_examples: {key} {example_label} code {value["error"]["code"]} is not in x-error-codes {allowed}')
            fixture_codes.add(value['error']['code'])
        corrupt = deepcopy(value)
        corrupt[first] = False
        require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: alternative wrong field type accepted for {key}')
        negative += 1
    if allowed is not None:
        unbound = sorted(code for code in allowed if code in V12_ERROR_CODES and code not in fixture_codes)
        require(not unbound, f'response_examples: {key} declares v1.2 error codes without a fixture: {unbound}')
    return negative


def query_examples(spec, validator_type, checker, validated, override=None):
    """Validate x-query-examples (for example the A8 following feed) against the operation's query parameters."""
    count = 0
    for key, operation in operations(spec).items():
        params = {p['name']: p for p in [dereference(spec, p) for p in operation.get('parameters', [])] if p['in'] == 'query'}
        for label, example_ref in operation.get('x-query-examples', {}).items():
            name = example_ref['$ref'].rsplit('/', 1)[1]
            value = override if override is not None else fixture_value(spec, name)
            require(isinstance(value, dict), f'query_examples: {name} must be an object of query parameters')
            unknown = sorted(set(value) - set(params))
            require(not unknown, f'query_examples: {name} uses undeclared query parameters {unknown} for {key}')
            for field, param in params.items():
                conditions = param.get('x-required-when', {})
                needed = param.get('required') or (conditions and all(value.get(k) == v for k, v in conditions.items()))
                require(not needed or field in value, f'query_examples: {name} misses required query parameter {field} for {key}')
                if field in value:
                    validate(value[field], param['schema'], spec, validator_type, checker, f'{key} {label} {field}')
            validated.add(name)
            count += 1
    require(count > 0 or override is not None, 'query_examples: the following-feed query fixture is missing')
    return count


def component_examples(spec, validator_type, checker, validated):
    """Validate examples that no operation response references through their declared x-schema (for example the legacy metadata)."""
    count = 0
    for name, example in spec['components']['examples'].items():
        if 'x-schema' in example:
            validate(fixture_value(spec, name), {'$ref': '#/components/schemas/' + example['x-schema']}, spec, validator_type, checker, f'example {name}')
            validated.add(name)
            count += 1
    return count


def example_inventory(spec, validated, files=None):
    """Every api/examples payload (top level and v1.2/) is a declared component example, and every component example was validated."""
    declared = {}
    for name, example in spec['components']['examples'].items():
        external = example.get('externalValue', '')
        relative = external[len('examples/'):]
        require(external.startswith('examples/') and (relative.count('/') == 0 or (relative.startswith('v1.2/') and relative.count('/') == 1)),
                f'example_inventory: {name} must live directly in api/examples or api/examples/v1.2')
        require(relative.startswith('v1.2/') == name.startswith('v1.2-'), f'example_inventory: {name} and its file {relative} disagree on v1.2')
        declared[relative] = name
    if files is None:
        files = {str(p.relative_to(API / 'examples')) for p in (API / 'examples').rglob('*') if p.is_file()}
    payloads = set(files) - INVENTORY_FILES
    require(payloads == set(declared), f'example_inventory: undeclared files {sorted(payloads - set(declared))}, missing files {sorted(set(declared) - payloads)}')
    unvalidated = sorted(set(declared.values()) - validated)
    require(not unvalidated, f'example_inventory: examples never validated against a component schema: {unvalidated}')
    return len(payloads)


def schema_cases(spec, validator_type, checker):
    cases = load_json(API / 'examples/schema-cases.json')
    names = set()
    accepted = rejected = 0
    for case in cases:
        require(case['name'] not in names, 'schema_cases: duplicate regression name ' + case['name'])
        names.add(case['name'])
        require(case['schema'] in spec['components']['schemas'], f'schema_cases: {case["name"]} names unknown schema {case["schema"]}')
        schema = {'$ref': '#/components/schemas/' + case['schema']}
        errors = list(schema_validator(spec, schema, validator_type, checker).iter_errors(case['value']))
        require(not bool(errors) == case['valid'], f'schema_cases: {case["name"]} expected valid={case["valid"]}; errors={[e.message for e in errors]}')
        accepted += case['valid']
        rejected += not case['valid']
    require(accepted > 0 and rejected > 0, 'schema_cases: positive and negative coverage required')
    v12 = [case for case in cases if case['name'].startswith('v12_')]
    require(any(c['valid'] for c in v12) and any(not c['valid'] for c in v12), 'schema_cases: v1.2 positive and negative coverage required')
    return accepted, rejected


LEXICON_TYPES = {'string', 'integer', 'boolean', 'array'}
LEXICON_STRING_FORMATS = {'datetime', 'did', 'at-uri', 'handle', 'nsid', 'cid', 'uri', 'language', 'tid', 'record-key', 'at-identifier'}
# The four required v1 scrobble fields and the frozen v1 property definitions (ADR 0005 §6.1, §6.2, B13).
SCROBBLE_REQUIRED = ['artist', 'track', 'listenedAt', 'createdAt']
SCROBBLE_V1_PROPERTIES = {
    'artist': {'type': 'string', 'minLength': 1, 'maxLength': 1024},
    'track': {'type': 'string', 'minLength': 1, 'maxLength': 1024},
    'album': {'type': 'string', 'minLength': 1, 'maxLength': 1024},
    'listenedAt': {'type': 'string', 'format': 'datetime'},
    'createdAt': {'type': 'string', 'format': 'datetime'},
    'durationSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 86400},
    'recordingMbid': {'type': 'string'},
}
SCROBBLE_V12_OPTIONAL = {'albumArtist', 'trackNumber', 'artistMbids', 'releaseMbid', 'releaseGroupMbid', 'isrc', 'submissionClient', 'musicService'}
CONSTRAINTS = ('type', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'items')


def check_lexicon(document, label):
    """Structural check of a schema-v1 record lexicon, strict enough to reject a wrong key or field type."""
    require(isinstance(document, dict) and document.get('lexicon') == 1, f'{label}: lexicon must be 1')
    require(set(document) <= {'lexicon', 'id', 'description', 'defs', 'revision'}, f'{label}: unknown top-level fields')
    require(isinstance(document.get('id'), str) and valid_nsid(document['id']), f'{label}: id must be an NSID')
    main = document.get('defs', {}).get('main', {})
    require(main.get('type') == 'record', f'{label}: defs.main must be a record')
    key = main.get('key')
    require(key in ('tid', 'any', 'nsid') or (isinstance(key, str) and re.fullmatch(r'literal:[A-Za-z0-9._~:-]{1,512}', key) and key[8:] not in ('.', '..')),
            f'{label}: invalid record key type {key!r}')
    record = main.get('record', {})
    require(record.get('type') == 'object' and isinstance(record.get('properties'), dict), f'{label}: record must be an object with properties')
    required = record.get('required', [])
    require(len(set(required)) == len(required) and set(required) <= set(record['properties']), f'{label}: required fields must be declared once')
    for name, field in record['properties'].items():
        require(field.get('type') in LEXICON_TYPES, f'{label}: {name} has unsupported type {field.get("type")!r}')
        if field['type'] == 'array':
            items = field.get('items', {})
            require(isinstance(items, dict) and items.get('type') in LEXICON_TYPES - {'array'},
                    f'{label}: {name} must be an array of scalars')
            require(isinstance(field.get('maxLength'), int), f'{label}: {name} must bound its length')
        if 'format' in field:
            require(field['type'] == 'string' and field['format'] in LEXICON_STRING_FORMATS, f'{label}: {name} has invalid format')
        if 'enum' in field:
            values = field['enum']
            require(isinstance(values, list) and values and len(set(values)) == len(values) and
                    all(isinstance(v, str if field['type'] == 'string' else int) for v in values), f'{label}: {name} has an invalid enum')
    return main


def validate_record(main, value):
    """Return the first problem with a record against a checked lexicon main def, or None."""
    record = main['record']
    for name in record.get('required', []):
        if name not in value:
            return f'missing {name}'
    for name, field in record['properties'].items():
        if name not in value:
            continue
        item = value[name]
        if field['type'] == 'string' and not isinstance(item, str):
            return f'{name} is not a string'
        if field['type'] == 'integer' and not (isinstance(item, int) and not isinstance(item, bool)):
            return f'{name} is not an integer'
        if field['type'] == 'integer' and not (field.get('minimum', item) <= item <= field.get('maximum', item)):
            return f'{name} is out of range'
        if field['type'] == 'array':
            if not isinstance(item, list) or not all(isinstance(v, str) for v in item):
                return f'{name} is not an array of strings'
            if len(item) > field['maxLength']:
                return f'{name} has more than {field["maxLength"]} items'
        if field['type'] == 'string' and len(item.encode('utf-8')) > field.get('maxLength', len(item.encode('utf-8'))):
            return f'{name} is too long'
        if 'enum' in field and item not in field['enum']:
            return f'{name} is not one of {field["enum"]}'
        if field.get('format') == 'datetime':
            try:
                parse_timestamp(item)
            except ValueError:
                return f'{name} is not a datetime'
        if field.get('format') == 'did' and not valid_did(item):
            return f'{name} is not a DID'
    return None


def additive_lexicon(published, current, label):
    """B13 after the freeze point: same id and key, same required set, and every published field kept with no tighter constraint."""
    require(current['id'] == published['id'], f'{label}: id changed from the published {published["id"]}')
    old, new = published['defs']['main'], current['defs']['main']
    require(new['key'] == old['key'], f'{label}: record key changed from the published {old["key"]}')
    require(sorted(new['record'].get('required', [])) == sorted(old['record'].get('required', [])),
            f'{label}: required fields changed from the published {sorted(old["record"].get("required", []))}')
    for name, field in old['record']['properties'].items():
        require(name in new['record']['properties'], f'{label}: published field {name} was removed')
        now = new['record']['properties'][name]
        for constraint in ('type', 'format', 'enum', 'const', 'items'):
            require(now.get(constraint) == field.get(constraint), f'{label}: {name}.{constraint} changed from the published value')
        for constraint in ('maxLength', 'maximum'):
            if constraint in field:
                require(now.get(constraint, float('inf')) >= field[constraint], f'{label}: {name}.{constraint} tightened')
        for constraint in ('minLength', 'minimum'):
            if constraint in field:
                require(now.get(constraint, float('-inf')) <= field[constraint], f'{label}: {name}.{constraint} tightened')
            else:
                require(constraint not in now, f'{label}: {name}.{constraint} added')


def lexicons(override=None, published=None):
    """All lexicons share the fixture prefix: settings (literal:self), love (tid) and an additive-only scrobble."""
    documents = override or {path.stem: load_json(path) for path in sorted((ROOT / 'lexicons').glob('*.json'))}
    require(set(documents) == LEXICON_COLLECTIONS, f'lexicons: expected {sorted(LEXICON_COLLECTIONS)}, found {sorted(documents)}')
    mains = {}
    for name, document in documents.items():
        mains[name] = check_lexicon(document, f'lexicons/{name}.json')
        require(document['id'] == f'{LEXICON_PREFIX}.{name}', f'lexicons/{name}.json: id must be {LEXICON_PREFIX}.{name} (fixture prefix)')
    settings = mains['settings']
    require(settings['key'] == 'literal:self', 'lexicons/settings.json: key must be literal:self')
    record = settings['record']
    require(sorted(record.get('required', [])) == ['createdAt', 'indexing'] and set(record['properties']) == {'createdAt', 'indexing'},
            'lexicons/settings.json: exactly indexing and createdAt, both required')
    require(record['properties']['indexing'].get('type') == 'string' and record['properties']['indexing'].get('enum') == ['enabled', 'disabled'],
            'lexicons/settings.json: indexing must be the enum enabled/disabled')
    require(record['properties']['createdAt'] == {**record['properties']['createdAt'], 'type': 'string', 'format': 'datetime'},
            'lexicons/settings.json: createdAt must be a datetime string')
    # scrobble: the four v1 fields stay the only required ones, v1 definitions are frozen, the §6.2 fields are optional.
    scrobble = mains['scrobble']['record']
    require(mains['scrobble']['key'] == 'tid', 'lexicons/scrobble.json: key must be tid')
    require(scrobble.get('required') == SCROBBLE_REQUIRED,
            f'lexicons/scrobble.json: required must stay exactly {SCROBBLE_REQUIRED}; every other field is optional (B13)')
    for name, frozen in SCROBBLE_V1_PROPERTIES.items():
        field = scrobble['properties'].get(name, {})
        require({k: field[k] for k in CONSTRAINTS if k in field} == frozen, f'lexicons/scrobble.json: v1 field {name} changed (B13)')
    require(set(scrobble['properties']) == set(SCROBBLE_V1_PROPERTIES) | SCROBBLE_V12_OPTIONAL,
            f'lexicons/scrobble.json: properties must be the v1 fields plus {sorted(SCROBBLE_V12_OPTIONAL)}')
    # love (§6.3): key tid; artist, track and createdAt required; album and recordingMbid optional; scrobble limits.
    love = mains['love']
    require(love['key'] == 'tid', 'lexicons/love.json: key must be tid')
    require(sorted(love['record'].get('required', [])) == ['artist', 'createdAt', 'track'] and
            set(love['record']['properties']) == {'artist', 'track', 'album', 'recordingMbid', 'createdAt'},
            'lexicons/love.json: artist, track and createdAt required; album and recordingMbid optional; nothing else')
    for name in ('artist', 'track', 'album', 'recordingMbid', 'createdAt'):
        field = love['record']['properties'][name]
        require({k: field[k] for k in CONSTRAINTS if k in field} == SCROBBLE_V1_PROPERTIES[name],
                f'lexicons/love.json: {name} must use the scrobble limits')
    # After the freeze point (first production record) the last published copies bind (B13).
    published_dir = ROOT / 'lexicons/published'
    published = published if published is not None else (
        {path.stem: load_json(path) for path in sorted(published_dir.glob('*.json'))} if published_dir.is_dir() else {})
    for name, document in published.items():
        require(name in documents, f'lexicons: published lexicon {name} was removed')
        additive_lexicon(document, documents[name], f'lexicons/{name}.json')
    count = 0
    t = '2026-01-15T12:00:00Z'
    for main, value, valid in [
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'disabled', 'createdAt': t}, True),
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'enabled', 'createdAt': '2026-01-15T12:00:00.123Z'}, True),
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'paused', 'createdAt': t}, False),
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'disabled'}, False),
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'createdAt': t}, False),
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'disabled', 'createdAt': '2026-01-15 12:00:00'}, False),
        (settings, {'$type': f'{LEXICON_PREFIX}.settings', 'indexing': False, 'createdAt': t}, False),
        (love, {'$type': f'{LEXICON_PREFIX}.love', 'artist': 'Björk', 'track': 'Jóga', 'createdAt': t}, True),
        (love, {'$type': f'{LEXICON_PREFIX}.love', 'artist': 'Björk', 'track': 'Jóga', 'album': 'Homogenic',
                'recordingMbid': '13f12616-51d7-4023-a70b-a288ced4693a', 'createdAt': t}, True),
        (love, {'$type': f'{LEXICON_PREFIX}.love', 'track': 'Jóga', 'createdAt': t}, False),
        (love, {'$type': f'{LEXICON_PREFIX}.love', 'artist': 'Björk', 'track': 'Jóga'}, False),
        (mains['scrobble'], {'artist': 'Björk', 'track': 'Jóga', 'listenedAt': t, 'createdAt': t}, True),
        (mains['scrobble'], {'artist': 'Björk', 'track': 'Jóga', 'listenedAt': t, 'createdAt': t, 'albumArtist': 'Björk',
                             'trackNumber': 4, 'artistMbids': ['13f12616-51d7-4023-a70b-a288ced4693a'], 'isrc': 'GBAYE9700245'}, True),
        (mains['scrobble'], {'artist': 'Björk', 'track': 'Jóga', 'listenedAt': t, 'createdAt': t, 'trackNumber': 10000}, False),
        (mains['scrobble'], {'artist': 'Björk', 'track': 'Jóga', 'listenedAt': t, 'createdAt': t, 'artistMbids': ['x'] * 11}, False),
        (mains['scrobble'], {'artist': 'Björk', 'track': 'Jóga', 'listenedAt': t}, False),
    ]:
        problem = validate_record(main, value)
        require((problem is None) == valid, f'lexicons: record {value} expected valid={valid}, got {problem}')
        count += 1
    return len(documents), count, len(published)


def _lexicon_documents():
    return {p.stem: load_json(p) for p in (ROOT / 'lexicons').glob('*.json')}


def compatibility_controls(spec):
    """A lexicon that adds a required scrobble field, or a v1.1 response schema that loses a property, is rejected."""
    documents = _lexicon_documents()

    def scrobble_with(mutate):
        mutated = deepcopy(documents)
        mutate(mutated['scrobble']['defs']['main']['record'])
        return mutated

    def spec_with(mutate):
        mutated = deepcopy(spec)
        mutate(mutated['components']['schemas'])
        return mutated

    published_scrobble = deepcopy(documents['scrobble'])
    controls = [
        ('scrobble lexicon requires albumArtist', lambda: lexicons(scrobble_with(lambda r: r['required'].append('albumArtist'))),
         "lexicons/scrobble.json: required must stay exactly ['artist', 'track', 'listenedAt', 'createdAt']"),
        ('scrobble lexicon requires a new field isrc2', lambda: lexicons(scrobble_with(
            lambda r: (r['properties'].update(isrc2={'type': 'string'}), r['required'].append('isrc2')))),
         "lexicons/scrobble.json: required must stay exactly"),
        ('scrobble lexicon tightens artist', lambda: lexicons(scrobble_with(lambda r: r['properties']['artist'].update(maxLength=512))),
         'lexicons/scrobble.json: v1 field artist changed (B13)'),
        ('published scrobble gains a required field',
         lambda: additive_lexicon(published_scrobble, scrobble_with(lambda r: r['required'].append('albumArtist'))['scrobble'],
                                  'lexicons/scrobble.json'),
         'lexicons/scrobble.json: required fields changed from the published'),
        ('published scrobble tightens trackNumber',
         lambda: additive_lexicon(published_scrobble, scrobble_with(lambda r: r['properties']['trackNumber'].update(maximum=999))['scrobble'],
                                  'lexicons/scrobble.json'),
         'lexicons/scrobble.json: trackNumber.maximum tightened'),
        ('love lexicon with optional artist', lambda: lexicons({**documents, 'love': _mutated_love()}),
         'lexicons/love.json: artist, track and createdAt required'),
        ('Scrobble loses album', lambda: v11_compatibility(spec_with(lambda s: s['Scrobble']['properties'].pop('album'))),
         "v1.1 compatibility: Scrobble lost properties ['album']"),
        ('Profile loses followerCount', lambda: v11_compatibility(spec_with(
            lambda s: (s['Profile']['properties'].pop('followerCount'), s['Profile']['required'].remove('followerCount')))),
         "v1.1 compatibility: Profile lost properties ['followerCount']"),
        ('Statistics.topAlbums loses album', lambda: v11_compatibility(spec_with(
            lambda s: s['Statistics']['properties']['topAlbums']['items']['properties'].pop('album'))),
         "v1.1 compatibility: Statistics.topAlbums[] lost properties ['album']"),
        ('Scrobble makes albumArtist required', lambda: v11_compatibility(spec_with(lambda s: s['Scrobble']['required'].append('albumArtist'))),
         'v1.1 compatibility: Scrobble changed its required set'),
        ('Error envelope loses requestId', lambda: v11_compatibility(spec_with(
            lambda s: (s['Error']['properties']['error']['properties'].pop('requestId'),
                       s['Error']['properties']['error']['required'].remove('requestId')))),
         "v1.1 compatibility: Error.error lost properties ['requestId']"),
    ]
    for label, run, expected in controls:
        try:
            run()
        except ContractError as error:
            require(expected in str(error), f'compatibility control {label} was rejected without reporting {expected!r}: {error}')
            continue
        raise ContractError('compatibility control did not reject ' + label)
    return [label for label, _, _ in controls]


def prove_failure_detection(spec, validator_type, checker):
    """Each check must reject a deliberately broken copy; repository files are never altered."""
    missing_route = deepcopy(spec)
    del missing_route['paths']['/health/live']
    readded_export = deepcopy(spec)
    readded_export['paths']['/api/v1/account/export'] = {'get': deepcopy(spec['paths']['/api/v1/users/{did}/export']['get'])}
    readded_schema = deepcopy(spec)
    readded_schema['components']['schemas']['AccountExport'] = {'type': 'object'}
    session_feed = deepcopy(spec)
    session_feed['paths']['/api/v1/feed']['get']['security'] = [{}, {'SessionCookie': []}]
    legacy_callback = deepcopy(spec)
    legacy_callback['components']['schemas']['ConfidentialClientMetadata']['properties']['redirect_uris']['items']['pattern'] = '^https://'
    public_metadata = deepcopy(spec)
    public_metadata['components']['schemas']['ConfidentialClientMetadata']['properties']['token_endpoint_auth_method'] = {'const': 'none'}
    private_jwk = deepcopy(spec)
    private_jwk['components']['schemas']['Jwk']['properties']['d'] = {'type': 'string'}
    no_csrf = deepcopy(spec)
    no_csrf['paths']['/api/v1/loves']['put']['security'] = [{'SessionCookie': []}]
    no_key = deepcopy(spec)
    no_key['paths']['/api/v1/scrobbles']['post']['parameters'] = [p for p in no_key['paths']['/api/v1/scrobbles']['post']['parameters']
                                                                  if p != {'$ref': '#/components/parameters/IdempotencyKey'}]
    ungated = deepcopy(spec)
    ungated['paths']['/api/v1/follows/{did}']['put']['responses']['503']['x-error-codes'] = ['not_ready']
    no_cancelled = deepcopy(spec)
    no_cancelled['components']['schemas']['Operation']['properties']['state']['enum'].remove('cancelled')
    for label, mutated, check in [
            ('removed route', missing_route, route_inventory),
            ('re-added /api/v1/account/export', readded_export, not_restored),
            ('re-added AccountExport schema', readded_schema, not_restored),
            ('session-protected following feed', session_feed, public_access),
            ('non-callback OAuth redirect', legacy_callback, public_access),
            ('public-client metadata', public_metadata, public_access),
            ('JWK with a private member', private_jwk, public_access),
            ('PUT /api/v1/loves without CSRF', no_csrf, session_access),
            ('POST /api/v1/scrobbles without Idempotency-Key', no_key, session_access),
            ('ungated follow write', ungated, session_access),
            ('Operation without cancelled', no_cancelled, session_access)]:
        try:
            check(mutated)
        except ContractError:
            continue
        raise ContractError('Failure detection did not reject ' + label)
    cases = load_cases()
    for label, run in [
            ('following feed without viewer', lambda: query_examples(spec, validator_type, checker, set(), override={'scope': 'following', 'limit': 20})),
            ('stale top-level example file', lambda: example_inventory(spec, set(spec['components']['examples']),
                                                                     files={str(p.relative_to(API / 'examples')) for p in (API / 'examples').rglob('*') if p.is_file()} | {'stale.json'})),
            ('stale v1.2 example file', lambda: example_inventory(spec, set(spec['components']['examples']),
                                                                files={str(p.relative_to(API / 'examples')) for p in (API / 'examples').rglob('*') if p.is_file()} | {'v1.2/stale.json'})),
            ('v1.2 case moved into the v1.1 inventory', lambda: response_examples(spec, validator_type, checker, set(), cases={
                V11_CASES: cases[V11_CASES] + [cases[V12_CASES][-1]], V12_CASES: cases[V12_CASES][:-1]})),
            ('missing v1.2 case', lambda: response_examples(spec, validator_type, checker, set(), cases={
                V11_CASES: cases[V11_CASES], V12_CASES: [c for c in cases[V12_CASES] if (c['method'], c['path'], c['status']) != ('POST', '/api/v1/imports/upload', 507)]})),
            ('signin_not_allowed fixture dropped', lambda: response_examples(spec_without_alternative(spec, '/api/v1/auth/start', 'post', '403', 'signin'),
                                                                             validator_type, checker, set(), cases=cases)),
            ('settings lexicon with tid key', lambda: lexicons({**_lexicon_documents(), 'settings': _mutated_settings('key', 'tid')})),
            ('settings lexicon with open indexing value', lambda: lexicons({**_lexicon_documents(), 'settings': _mutated_settings('enum', None)}))]:
        try:
            run()
        except ContractError:
            continue
        raise ContractError('Failure detection did not reject ' + label)


def spec_without_alternative(spec, path, method, status, label):
    mutated = deepcopy(spec)
    mutated['paths'][path][method]['responses'][status]['content']['application/json']['examples'].pop(label)
    return mutated


def _mutated_settings(field, value):
    document = load_json(ROOT / 'lexicons/settings.json')
    if field == 'key':
        document['defs']['main']['key'] = value
    else:
        del document['defs']['main']['record']['properties']['indexing']['enum']
    return document


def _mutated_love():
    document = load_json(ROOT / 'lexicons/love.json')
    document['defs']['main']['record']['required'].remove('artist')
    return document


def main():
    check_dependencies()
    from jsonschema import Draft202012Validator, FormatChecker

    validator_type, checker = build_validator()
    spec = load_json(API / 'openapi.yaml')
    schema_path = API / 'schemas/openapi-3.1.schema.json'
    require(hashlib.sha256(schema_path.read_bytes()).hexdigest() == OPENAPI_SCHEMA_SHA256, 'Vendored OpenAPI structural schema differs from pinned revision.')
    structural_schema = load_json(schema_path)
    errors = list(Draft202012Validator(structural_schema, format_checker=FormatChecker()).iter_errors(spec))
    require(not errors, f'OpenAPI structural schema: {[e.message for e in errors[:3]]}')
    require(spec['info']['version'] == CONTRACT_VERSION, f'openapi info.version must be {CONTRACT_VERSION}')
    walk_refs(spec, spec)
    for name, schema in spec['components']['schemas'].items():
        Draft202012Validator.check_schema(schema)
    print(f'PASS openapi_schema: OpenAPI 3.1.0, info.version {CONTRACT_VERSION}, {len(spec["components"]["schemas"])} Draft 2020-12 schemas; pinned offline dependencies')
    count = route_inventory(spec)
    rejected = route_inventory_controls(spec)
    print(f'PASS route_inventory: exact MVP/API route and status matrices ({count} methods on {len(spec["paths"])} paths: '
          f'{len(V11_STATUSES)} v1.1 in MVP.md, API.md and openapi.yaml, {len(V12_STATUSES)} v1.2 in API.md and openapi.yaml; '
          f'{len(rejected)} mutations rejected: {"; ".join(rejected)})')
    count = not_restored(spec)
    print(f'PASS not_restored: the {count} v1.0 account export and local-data routes and the AccountExport schema stay absent (ADR 0005 §5.7)')
    count = public_access(spec)
    print(f'PASS public_access: {count} v1.1 routes declare no security and never answer 401/403; client metadata is the dynamic '
          'private_key_jwt document with /oauth/callback and /oauth/jwks.json, and published JWKs never carry d')
    modes = session_access(spec)
    print(f'PASS session_access: {sum(modes.values())} v1.2 routes ({", ".join(f"{n} {m}" for m, n in sorted(modes.items()))}); '
          f'{len(WRITE_ROUTES)} writes answer 202 Accepted and 503 publication_disabled; {len(REQUIRED_ERROR_CODES)} named error responses declared')
    count = query_bounds(spec, validator_type, checker)
    print(f'PASS query_bounds: {count} limit/viewer/body/Idempotency-Key boundaries; defaults, cursor, window, scope, viewer, record URI, '
          '2 KiB notify body, 64 KiB v1.2 bodies and the 64 MiB raw upload')
    validated = set()
    count, negative, requests = response_examples(spec, validator_type, checker, validated)
    queries = query_examples(spec, validator_type, checker, validated)
    components = component_examples(spec, validator_type, checker, validated)
    files = example_inventory(spec, validated)
    print(f'PASS all api/examples validate against openapi {CONTRACT_VERSION} components: {files} fixtures; {count} response/status cases '
          f'({V11_CASES} and {V12_CASES}), {negative} rejected wrong-type responses, {requests} request, {queries} query and {components} component fixtures')
    accepted, rejected_cases = schema_cases(spec, validator_type, checker)
    print(f'PASS schema_cases: {accepted} accepted and {rejected_cases} rejected UTF-8/scalar, timestamp, identifier, notify, record-status, export, '
          'client-metadata and v1.2 (optional scrobble fields, operations, sessions, accounts, credentials, links, imports, JWKS) cases')
    used, defined, pending = error_codes(spec)
    controls = error_code_controls(spec)
    print(f'PASS error_codes: the {used} codes of api/examples error envelopes are defined in packages/core/src/errors.ts or the v1.2 '
          f'vocabulary with the status each is served with ({defined} codes in errors.ts; {len(pending)} v1.2 codes pending there: '
          f'{", ".join(pending) or "none"}; {controls} mutations rejected)')
    documents, records, published = lexicons()
    print(f'PASS lexicons: {documents} lexicons share {LEXICON_PREFIX}; settings literal:self, love tid with artist, track and createdAt '
          f'required, scrobble requires exactly the four v1 fields with the §6.2 fields optional; {records} record cases; '
          f'{published or "no"} published copies (freeze point {"reached" if published else "not reached"})')
    shapes, statuses = v11_compatibility(spec)
    print(f'PASS v1.1 compatibility: {shapes} v1.1 schemas keep every property and required set; {statuses} v1.1 route statuses keep their response schemas')
    prove_failure_detection(spec, validator_type, checker)
    print('PASS failure_detection: removed route, re-added v1.0 export, session feed, non-callback redirect, public-client metadata, private JWK, '
          'CSRF-less write, keyless scrobble POST, ungated write, missing cancelled state, viewerless following query, stale example files, '
          'misfiled or missing v1.2 cases, unbound error code and broken settings lexicon rejected without changing repository files')
    labels = compatibility_controls(spec)
    print(f'PASS fails when a lexicon adds a required scrobble field or a v1.1 response schema loses a property: {len(labels)} mutations rejected: '
          f'{"; ".join(labels)}')
    print(f'PASS passes with openapi {CONTRACT_VERSION}, the new examples and lexicons/love.json: every check above passed')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ContractError, KeyError, OSError, ValueError) as error:
        print(f'FAIL contracts: {error}', file=sys.stderr)
        sys.exit(1)
