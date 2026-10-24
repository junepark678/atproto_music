#!/usr/bin/env python3
"""Offline, dependency-pinned OpenAPI 1.1.0/schema, lexicon and frozen contract regression checks (ADR 0004 §9)."""

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

    return validators.extend(Draft202012Validator, {'x-maxFutureSeconds': maximum_future, 'x-jsonIntegerRepresentation': json_integer_representation}), checker


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


CONTRACT_VERSION = '1.1.0'

# This status matrix is independent of the document and its fixture inventory.
# The success entries and route-specific rules are frozen in API.md as amended
# by ADR 0004 §9 (A3, A8, A9, A10, N1–N3).
EXPECTED_STATUSES = {
    ('GET', '/health/live'): {200},
    ('GET', '/health/ready'): {200, 503},
    ('GET', '/api/v1/meta'): {200, 429},
    # A3: a build-time Workers Static Asset; the Worker never runs for it.
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

# ADR 0004 §9.3. None of these may reappear in the document.
DROPPED_ROUTES = {
    ('POST', '/api/v1/auth/start'), ('GET', '/api/v1/auth/callback'), ('GET', '/api/v1/auth/session'),
    ('POST', '/api/v1/auth/logout'), ('POST', '/api/v1/scrobbles'), ('DELETE', '/api/v1/scrobbles/{id}'),
    ('PUT', '/api/v1/follows/{did}'), ('DELETE', '/api/v1/follows/{did}'), ('GET', '/api/v1/operations/{id}'),
    ('GET', '/api/v1/account/export'), ('DELETE', '/api/v1/account/local-data'),
}
DROPPED_PREFIXES = ('/api/v1/auth/', '/api/v1/account/', '/api/v1/operations/', '/api/v1/follows/')
DROPPED_SCHEMAS = {'Accepted', 'Operation', 'Session', 'AuthStart', 'AuthStartInput', 'AccountExport', 'FollowResult'}
DROPPED_PARAMETERS = {'Origin', 'IdempotencyKey', 'OperationIdPath', 'OAuthState', 'OAuthCode', 'OAuthIssuer',
                      'OAuthError', 'OAuthErrorDescription'}
SESSION_EXTENSIONS = {'x-csrf-required', 'x-oauth-state-required', 'x-session-required-when'}
LIST_ROUTES = {
    ('GET', '/api/v1/users/{did}/scrobbles'), ('GET', '/api/v1/feed'),
    ('GET', '/api/v1/users/{did}/following'), ('GET', '/api/v1/users/{did}/followers'),
}
NO_STORE_ROUTES = {('GET', '/api/v1/users/{did}/export'), ('GET', '/api/v1/records/status')}
NOTIFY_MAX_BODY_BYTES = 2048
# Example files that are inventories rather than payload fixtures.
INVENTORY_FILES = {'response-cases.json', 'schema-cases.json'}
LEXICON_PREFIX = 'com.example.atmusic'
LEXICON_COLLECTIONS = {'scrobble', 'follow', 'settings'}


def section_routes(text):
    return {(method, path.split('?', 1)[0]) for method, path in re.findall(r'\b(GET|POST|PUT|DELETE)\s+(/[^\s;|`]+)', text)}


def route_inventory(spec):
    found = operations(spec)
    mvp = (ROOT / 'docs/planning/MVP.md').read_text()
    section = mvp.split('## API contract to freeze in M1', 1)[1].split('## Completion and execution rules', 1)[0]
    documented = section_routes(section)
    fixed = {(method, path) for method, path in re.findall(r'\| (GET|POST|PUT|DELETE) `([^`]+)`', (ROOT / 'docs/planning/API.md').read_text())}
    expected = set(EXPECTED_STATUSES)
    differences = {label: (sorted(routes - expected), sorted(expected - routes))
                   for label, routes in [('MVP.md', documented), ('API.md', fixed), ('openapi', set(found))] if routes != expected}
    require(not differences, 'route_inventory: route sets differ from the v1.1 inventory; ' +
            '; '.join(f'{label} extra={extra} missing={missing}' for label, (extra, missing) in differences.items()))
    ids = [operation.get('operationId') for operation in found.values()]
    require(all(ids) and len(set(ids)) == len(ids), 'route_inventory: duplicate or missing operationId')
    for key, operation in found.items():
        require({int(status) for status in operation['responses']} == EXPECTED_STATUSES[key], f'route_inventory: incorrect status matrix for {key}')
        params = [dereference(spec, p) for p in operation.get('parameters', [])]
        expected_path_fields = set(re.findall(r'\{([^}]+)\}', key[1]))
        actual_path_fields = {p['name'] for p in params if p['in'] == 'path' and p.get('required')}
        require(expected_path_fields == actual_path_fields, f'route_inventory: missing required path field for {key}')
    for key in NO_STORE_ROUTES:
        header = found[key]['responses']['200'].get('headers', {}).get('Cache-Control', {})
        require(header.get('required') is True and header.get('schema') == {'const': 'no-store'}, f'route_inventory: {key} must declare Cache-Control: no-store')
    disposition = found[('GET', '/api/v1/users/{did}/export')]['responses']['200']['headers'].get('Content-Disposition', {})
    require(disposition.get('required') is True and disposition.get('schema') == {'const': 'attachment; filename="music-export.json"'},
            'route_inventory: export must be the music-export.json attachment (A9)')
    retry = found[('POST', '/api/v1/notify')]['responses']['429'].get('headers', {}).get('Retry-After', {})
    require(retry.get('required') is True, 'route_inventory: notify 429 must declare Retry-After')
    return len(found)


def dropped_routes(spec):
    """ADR 0004 §9.3: the auth, server write, operation and account routes and their schemas are absent."""
    found = operations(spec)
    present = sorted(DROPPED_ROUTES & set(found))
    require(not present, f'dropped_routes: dropped routes present: {present}')
    stale = sorted(path for path in spec['paths'] if path.startswith(DROPPED_PREFIXES))
    require(not stale, f'dropped_routes: dropped path prefixes present: {stale}')
    writes = sorted(key for key in found if key[0] != 'GET' and key != ('POST', '/api/v1/notify'))
    require(not writes, f'dropped_routes: unexpected non-GET routes (the server receives no writes, A2): {writes}')
    schemas = sorted(DROPPED_SCHEMAS & set(spec['components']['schemas']))
    require(not schemas, f'dropped_routes: dropped schemas present: {schemas}')
    parameters = sorted(DROPPED_PARAMETERS & set(spec['components'].get('parameters', {})))
    require(not parameters, f'dropped_routes: dropped parameters present: {parameters}')
    require(not spec['components'].get('securitySchemes'), 'dropped_routes: session/CSRF security schemes must be removed')
    text = json.dumps(spec)
    for marker in ['#/components/schemas/Accepted"', '#/components/schemas/Operation"', 'atmusic_session', 'X-CSRF-Token', 'Idempotency-Key']:
        require(marker not in text, f'dropped_routes: stale reference {marker!r}')
    return len(DROPPED_ROUTES)


def public_access(spec):
    """Every v1.1 route is public; no route reads a session, cookie, CSRF token or Origin header."""
    found = operations(spec)
    for key, operation in found.items():
        require(operation.get('security') == [], f'public_access: {key} must declare security: []')
        require(operation.get('x-auth-mode') == 'public', f'public_access: {key} must be x-auth-mode public')
        stale = sorted(SESSION_EXTENSIONS & set(operation))
        require(not stale, f'public_access: {key} keeps session extensions {stale}')
        headers = [p['name'] for p in [dereference(spec, p) for p in operation.get('parameters', [])] if p['in'] in ('header', 'cookie')]
        require(not headers, f'public_access: {key} reads header/cookie parameters {headers}')
    metadata = found[('GET', '/oauth/client-metadata.json')]
    require(metadata.get('x-served-by') == 'static-assets', 'public_access: client metadata must be documented as a static asset (A3)')
    schema = spec['components']['schemas']['OAuthClientMetadata']
    require('application_type' in schema['required'] and schema['properties']['application_type'] == {'const': 'web'},
            'public_access: client metadata must require application_type web')
    require(schema['properties']['token_endpoint_auth_method'] == {'const': 'none'}, 'public_access: browser public client uses token_endpoint_auth_method none')
    require(schema['properties']['redirect_uris']['items'].get('pattern') == '^https://[^/?#]+/oauth/callback$',
            'public_access: the only redirect is https://<host>/oauth/callback')
    return len(found)


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
    return count


def fixture_value(spec, name):
    example = dereference(spec, {'$ref': '#/components/examples/' + name})
    require('externalValue' in example and 'value' not in example, f'response_examples: missing external fixture {name}')
    path = (API / example['externalValue']).resolve()
    require(path.is_relative_to(API / 'examples'), f'response_examples: fixture escapes examples directory: {name}')
    return load_json(path)


def response_examples(spec, validator_type, checker, validated):
    found = operations(spec)
    cases = load_json(API / 'examples/response-cases.json')
    expected = {(method, path, int(status)) for (method, path), operation in found.items() for status in operation['responses']}
    seen = set()
    negative_count = 0
    for case in cases:
        key = (case['method'], case['path'], case['status'])
        require(key not in seen, f'response_examples: duplicate case {key}')
        require(key in expected, f'response_examples: undocumented response case {key}')
        seen.add(key)
        response = dereference(spec, found[key[:2]]['responses'][str(key[2])])
        headers = case.get('headers', {})
        for name, header in response.get('headers', {}).items():
            header = dereference(spec, header)
            require(not header.get('required') or name in headers, f'response_examples: missing {name} for {key}')
            if name in headers:
                validate(headers[name], header['schema'], spec, validator_type, checker, f'{key} {name}')
        if 'content' not in response:
            require(case.get('body', 'missing') is None and 'example' not in case, f'response_examples: {key} must have no response body')
            continue
        media = response['content']['application/json']
        declared_example = media['examples']['fixture']['$ref'].rsplit('/', 1)[1]
        require(case.get('example') == declared_example, f'response_examples: fixture not bound to OpenAPI example for {key}')
        value = fixture_value(spec, case['example'])
        validate(value, media['schema'], spec, validator_type, checker, str(key))
        validated.add(case['example'])
        for name, header in response.get('headers', {}).items():
            required_codes = header.get('x-required-for-error-codes', [])
            if value.get('error', {}).get('code') in required_codes:
                require(name in headers, f'response_examples: missing conditional {name} for {key}')
        # Deliberately replace a required field with a boolean. Every response
        # must reject this type change, including nested error envelopes.
        corrupt = deepcopy(value)
        first = next(iter(dereference(spec, media['schema'])['required']))
        corrupt[first] = False
        require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: wrong field type accepted for {key}')
        negative_count += 1
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
            corrupt = deepcopy(value)
            corrupt[first] = False
            require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: alternative wrong field type accepted for {key}')
            negative_count += 1
    require(seen == expected, f'response_examples: missing statuses {sorted(expected - seen)}')
    # Also validate the declared request examples, rather than assuming success
    # response coverage makes POST bodies valid, and prove the request schema is closed.
    request_count = 0
    for key, operation in found.items():
        if 'requestBody' in operation:
            media = operation['requestBody']['content']['application/json']
            name = media['examples']['fixture']['$ref'].rsplit('/', 1)[1]
            value = fixture_value(spec, name)
            validate(value, media['schema'], spec, validator_type, checker, f'{key} request')
            validated.add(name)
            corrupt = {**value, 'unexpectedField': True}
            require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: unknown request field accepted for {key}')
            request_count += 1
    return len(cases), negative_count, request_count


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
    """Validate examples that no operation references through their declared x-schema (the SPA form input)."""
    count = 0
    for name, example in spec['components']['examples'].items():
        if 'x-schema' in example:
            validate(fixture_value(spec, name), {'$ref': '#/components/schemas/' + example['x-schema']}, spec, validator_type, checker, f'example {name}')
            validated.add(name)
            count += 1
    return count


def example_inventory(spec, validated, files=None):
    """Every api/examples payload is a declared component example, and every component example was validated."""
    declared = {}
    for name, example in spec['components']['examples'].items():
        external = example.get('externalValue', '')
        require(external.startswith('examples/') and '/' not in external[len('examples/'):], f'example_inventory: {name} must live directly in api/examples')
        declared[external[len('examples/'):]] = name
    files = set(files) if files is not None else {p.name for p in (API / 'examples').iterdir() if p.is_file()}
    payloads = files - INVENTORY_FILES
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
    return accepted, rejected


LEXICON_TYPES = {'string', 'integer', 'boolean'}
LEXICON_STRING_FORMATS = {'datetime', 'did', 'at-uri', 'handle', 'nsid', 'cid', 'uri', 'language', 'tid', 'record-key', 'at-identifier'}


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


def lexicons(override=None):
    """All lexicons share the fixture prefix; settings is `<prefix>.settings` with key literal:self (A10)."""
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
    count = 0
    for value, valid in [
        ({'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'disabled', 'createdAt': '2026-01-15T12:00:00Z'}, True),
        ({'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'enabled', 'createdAt': '2026-01-15T12:00:00.123Z'}, True),
        ({'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'paused', 'createdAt': '2026-01-15T12:00:00Z'}, False),
        ({'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'disabled'}, False),
        ({'$type': f'{LEXICON_PREFIX}.settings', 'createdAt': '2026-01-15T12:00:00Z'}, False),
        ({'$type': f'{LEXICON_PREFIX}.settings', 'indexing': 'disabled', 'createdAt': '2026-01-15 12:00:00'}, False),
        ({'$type': f'{LEXICON_PREFIX}.settings', 'indexing': False, 'createdAt': '2026-01-15T12:00:00Z'}, False),
    ]:
        problem = validate_record(settings, value)
        require((problem is None) == valid, f'lexicons/settings.json: record {value} expected valid={valid}, got {problem}')
        count += 1
    return len(documents), count


def prove_failure_detection(spec, validator_type, checker):
    """Each check must reject a deliberately broken copy; repository files are never altered."""
    missing_route = deepcopy(spec)
    del missing_route['paths']['/health/live']
    readded_auth = deepcopy(spec)
    readded_auth['paths']['/api/v1/auth/session'] = {'get': deepcopy(spec['paths']['/api/v1/meta']['get'])}
    readded_post = deepcopy(spec)
    readded_post['paths']['/api/v1/scrobbles'] = {'post': deepcopy(spec['paths']['/api/v1/notify']['post'])}
    readded_operation = deepcopy(spec)
    readded_operation['paths']['/api/v1/operations/{id}'] = {'get': deepcopy(spec['paths']['/api/v1/meta']['get'])}
    readded_account = deepcopy(spec)
    readded_account['paths']['/api/v1/account/export'] = {'get': deepcopy(spec['paths']['/api/v1/users/{did}/export']['get'])}
    readded_schema = deepcopy(spec)
    readded_schema['components']['schemas']['Accepted'] = {'type': 'object'}
    session_feed = deepcopy(spec)
    session_feed['paths']['/api/v1/feed']['get']['security'] = [{}, {'SessionCookie': []}]
    legacy_callback = deepcopy(spec)
    legacy_callback['components']['schemas']['OAuthClientMetadata']['properties']['redirect_uris']['items']['pattern'] = '^https://'
    for label, mutated, check in [
            ('removed route', missing_route, route_inventory),
            ('re-added /api/v1/auth/session', readded_auth, dropped_routes),
            ('re-added POST /api/v1/scrobbles', readded_post, dropped_routes),
            ('re-added /api/v1/operations/{id}', readded_operation, dropped_routes),
            ('re-added /api/v1/account/export', readded_account, dropped_routes),
            ('re-added Accepted schema', readded_schema, dropped_routes),
            ('session-protected following feed', session_feed, public_access),
            ('non-callback OAuth redirect', legacy_callback, public_access)]:
        try:
            check(mutated)
        except ContractError:
            continue
        raise ContractError('Failure detection did not reject ' + label)
    for label, run in [
            ('following feed without viewer', lambda: query_examples(spec, validator_type, checker, set(), override={'scope': 'following', 'limit': 20})),
            ('stale accepted.json example', lambda: example_inventory(spec, set(spec['components']['examples']),
                                                                    files={p.name for p in (API / 'examples').iterdir()} | {'accepted.json'})),
            ('settings lexicon with tid key', lambda: lexicons({**{p.stem: load_json(p) for p in (ROOT / 'lexicons').glob('*.json')},
                                                                'settings': _mutated_settings('key', 'tid')})),
            ('settings lexicon with open indexing value', lambda: lexicons({**{p.stem: load_json(p) for p in (ROOT / 'lexicons').glob('*.json')},
                                                                           'settings': _mutated_settings('enum', None)}))]:
        try:
            run()
        except ContractError:
            continue
        raise ContractError('Failure detection did not reject ' + label)


def _mutated_settings(field, value):
    document = load_json(ROOT / 'lexicons/settings.json')
    if field == 'key':
        document['defs']['main']['key'] = value
    else:
        del document['defs']['main']['record']['properties']['indexing']['enum']
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
    print(f'PASS route_inventory: {count} methods on {len(spec["paths"])} paths; exact MVP/API route and status matrices')
    count = dropped_routes(spec)
    print(f'PASS dropped paths (/api/v1/auth/*, POST /api/v1/scrobbles, /api/v1/operations/{{id}}, /api/v1/account/*) are absent: '
          f'{count} ADR 0004 §9.3 routes, their schemas, parameters and security schemes')
    count = public_access(spec)
    print(f'PASS public_access: {count} routes declare no security; client metadata is a static asset with application_type web and /oauth/callback')
    count = query_bounds(spec, validator_type, checker)
    print(f'PASS query_bounds: {count} limit/viewer boundaries; defaults, cursor, window, scope, viewer, record URI and 2 KiB notify body')
    validated = set()
    count, negative, requests = response_examples(spec, validator_type, checker, validated)
    queries = query_examples(spec, validator_type, checker, validated)
    components = component_examples(spec, validator_type, checker, validated)
    files = example_inventory(spec, validated)
    print(f'PASS all api/examples validate against openapi {CONTRACT_VERSION} components: {files} fixtures; {count} response/status cases, '
          f'{negative} rejected wrong-type responses, {requests} request, {queries} query and {components} component fixtures')
    accepted, rejected = schema_cases(spec, validator_type, checker)
    print(f'PASS schema_cases: {accepted} accepted and {rejected} rejected UTF-8/scalar, timestamp, identifier, notify, record-status, export and client-metadata cases')
    documents, records = lexicons()
    print(f'PASS lexicons/settings.json is a valid lexicon with literal:self key: {documents} lexicons share {LEXICON_PREFIX}; {records} settings record cases')
    prove_failure_detection(spec, validator_type, checker)
    print('PASS failure_detection: removed route, re-added dropped routes/schema, session feed, non-callback redirect, viewerless following query, '
          'stale example file and broken settings lexicon rejected without changing repository files')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ContractError, KeyError, OSError, ValueError) as error:
        print(f'FAIL contracts: {error}', file=sys.stderr)
        sys.exit(1)
