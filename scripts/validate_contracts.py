#!/usr/bin/env python3
"""Offline, dependency-pinned OpenAPI/schema and frozen contract regression checks."""

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


# This status matrix is independent of the document and its fixture inventory.
# The success/async entries and route-specific ownership rules are frozen in API.md.
EXPECTED_STATUSES = {
    ('GET', '/health/live'): {200},
    ('GET', '/health/ready'): {200, 503},
    ('GET', '/api/v1/meta'): {200, 429},
    ('GET', '/oauth/client-metadata.json'): {200, 429},
    ('POST', '/api/v1/auth/start'): {200, 400, 403, 404, 413, 422, 429, 502},
    ('GET', '/api/v1/auth/callback'): {303, 400, 401},
    ('GET', '/api/v1/auth/session'): {200, 401, 429},
    ('POST', '/api/v1/auth/logout'): {204, 401, 403, 429},
    ('GET', '/api/v1/resolve'): {200, 404, 422, 429, 502},
    ('POST', '/api/v1/scrobbles'): {201, 202, 400, 401, 403, 409, 413, 422, 429, 502},
    ('GET', '/api/v1/scrobbles/{id}'): {200, 404, 422, 429},
    ('DELETE', '/api/v1/scrobbles/{id}'): {202, 204, 401, 403, 422, 429, 502},
    ('GET', '/api/v1/operations/{id}'): {200, 401, 403, 404, 429},
    ('GET', '/api/v1/users/{did}/scrobbles'): {200, 400, 422, 429},
    ('GET', '/api/v1/feed'): {200, 400, 401, 422, 429},
    ('GET', '/api/v1/users/{did}/profile'): {200, 404, 422, 429},
    ('GET', '/api/v1/users/{did}/stats'): {200, 422, 429},
    ('PUT', '/api/v1/follows/{did}'): {200, 201, 202, 401, 403, 422, 429, 502},
    ('DELETE', '/api/v1/follows/{did}'): {202, 204, 401, 403, 422, 429, 502},
    ('GET', '/api/v1/users/{did}/following'): {200, 400, 422, 429},
    ('GET', '/api/v1/users/{did}/followers'): {200, 400, 422, 429},
    ('GET', '/api/v1/account/export'): {200, 401, 429},
    ('DELETE', '/api/v1/account/local-data'): {204, 401, 403, 429},
}

MUTATIONS = {
    ('POST', '/api/v1/auth/logout'), ('POST', '/api/v1/scrobbles'),
    ('DELETE', '/api/v1/scrobbles/{id}'), ('PUT', '/api/v1/follows/{did}'),
    ('DELETE', '/api/v1/follows/{did}'), ('DELETE', '/api/v1/account/local-data'),
}
PRIVATE_READS = {
    ('GET', '/api/v1/auth/session'), ('GET', '/api/v1/operations/{id}'), ('GET', '/api/v1/account/export'),
}
LIST_ROUTES = {
    ('GET', '/api/v1/users/{did}/scrobbles'), ('GET', '/api/v1/feed'),
    ('GET', '/api/v1/users/{did}/following'), ('GET', '/api/v1/users/{did}/followers'),
}


def route_inventory(spec):
    found = operations(spec)
    mvp = (ROOT / 'docs/planning/MVP.md').read_text()
    section = mvp.split('## API contract to freeze in M1', 1)[1].split('## Completion and execution rules', 1)[0]
    documented = {(method, path.split('?', 1)[0]) for method, path in
                  re.findall(r'\b(GET|POST|PUT|DELETE)\s+(/[^\s;|]+)', section)}
    fixed = {(method, path) for method, path in re.findall(r'\| (GET|POST|PUT|DELETE) `([^`]+)`', (ROOT / 'docs/planning/API.md').read_text())}
    require(documented == fixed == set(found) == set(EXPECTED_STATUSES),
            f'route_inventory: route sets differ; missing={sorted(documented - set(found))}, extra={sorted(set(found) - documented)}')
    ids = [operation.get('operationId') for operation in found.values()]
    require(all(ids) and len(set(ids)) == len(ids), 'route_inventory: duplicate or missing operationId')
    for key, operation in found.items():
        require({int(status) for status in operation['responses']} == EXPECTED_STATUSES[key], f'route_inventory: incorrect status matrix for {key}')
        params = [dereference(spec, p) for p in operation.get('parameters', [])]
        expected_path_fields = set(re.findall(r'\{([^}]+)\}', key[1]))
        actual_path_fields = {p['name'] for p in params if p['in'] == 'path' and p.get('required')}
        require(expected_path_fields == actual_path_fields, f'route_inventory: missing required path field for {key}')
    replay = found[('POST', '/api/v1/scrobbles')]['responses']['409']
    location = replay.get('headers', {}).get('Location', {})
    require(location.get('x-required-for-error-codes') == ['idempotency_result_unavailable'], 'route_inventory: terminal replay must declare required operation Location header')
    require(location.get('schema') == {'type': 'string', 'pattern': r'^/api/v1/operations/[^/?#\s]+$'}, 'route_inventory: terminal operation Location schema changed')
    require(replay['content']['application/json']['examples'].get('terminalUnavailable') == {'$ref': '#/components/examples/idempotency-result-unavailable'}, 'route_inventory: terminal replay fixture missing')
    for path in ['/api/v1/scrobbles/{id}', '/api/v1/follows/{did}']:
        deletion = found[('DELETE', path)]['responses']['502']
        header = deletion.get('headers', {}).get('Location', {})
        require(header.get('x-required-for-error-codes') == ['deletion_failed'], f'route_inventory: terminal deletion must link original operation for {path}')
        require(header.get('schema') == location['schema'], f'route_inventory: invalid terminal deletion Location for {path}')
        require(deletion['content']['application/json']['examples'].get('terminalDeletionFailed') == {'$ref': '#/components/examples/deletion-failed'}, f'route_inventory: terminal deletion fixture missing for {path}')
    return len(found)


def required_auth(spec):
    found = operations(spec)
    for key, operation in found.items():
        params = {(p['in'], p['name']): p for p in [dereference(spec, p) for p in operation.get('parameters', [])]}
        if key in MUTATIONS:
            require(operation.get('security') == [{'SessionCookie': [], 'CsrfToken': []}], f'required_auth: session+CSRF must be jointly required for {key}')
            require(operation.get('x-csrf-required') is True, f'required_auth: missing CSRF declaration for {key}')
            require(params.get(('header', 'Origin'), {}).get('required') is True, f'required_auth: missing Origin for {key}')
            require({401, 403} <= EXPECTED_STATUSES[key], f'required_auth: missing rejection statuses for {key}')
        elif key in PRIVATE_READS:
            require(operation.get('security') == [{'SessionCookie': []}], f'required_auth: private read must require session for {key}')
        elif key == ('POST', '/api/v1/auth/start'):
            require(operation.get('security') == [] and operation.get('x-csrf-required') is False, 'required_auth: auth/start must allow Origin-based OAuth initiation')
            require(params.get(('header', 'Origin'), {}).get('required') is True, 'required_auth: auth/start must require Origin')
        elif key == ('GET', '/api/v1/auth/callback'):
            require(operation.get('security') == [] and operation.get('x-oauth-state-required') is True, 'required_auth: callback must use OAuth state')
            require(params.get(('query', 'state'), {}).get('required') is True, 'required_auth: callback state missing')
        elif key == ('GET', '/api/v1/feed'):
            require(operation.get('security') == [{}, {'SessionCookie': []}] and operation.get('x-session-required-when') == {'scope': 'following'}, 'required_auth: following feed session condition missing')
        else:
            require(operation.get('security') == [], f'required_auth: public route unexpectedly requires auth for {key}')
    schemes = spec['components']['securitySchemes']
    require(schemes['SessionCookie']['in'] == 'cookie' and schemes['SessionCookie']['name'] == 'atmusic_session', 'required_auth: incorrect session cookie')
    require(schemes['CsrfToken']['in'] == 'header' and schemes['CsrfToken']['name'] == 'X-CSRF-Token', 'required_auth: incorrect CSRF header')
    return len(found)


def query_bounds(spec, validator_type, checker):
    count = 0
    for key, operation in operations(spec).items():
        query = {p['name']: p for p in [dereference(spec, p) for p in operation.get('parameters', [])] if p['in'] == 'query'}
        if key in LIST_ROUTES or key == ('GET', '/api/v1/users/{did}/stats'):
            schema = query['limit']['schema']
            require(schema == {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 10 if key[1].endswith('/stats') else 20}, f'query_bounds: incorrect limit for {key}')
            for value, valid in [(1, True), (100, True), (0, False), (-1, False), (101, False), (1.5, False), ('20', False), (True, False)]:
                errors = list(schema_validator(spec, schema, validator_type, checker).iter_errors(value))
                require(not bool(errors) == valid, f'query_bounds: wrong limit acceptance {value!r} for {key}')
                count += 1
            require(('cursor' in query) == (key in LIST_ROUTES), f'query_bounds: incorrect cursor availability for {key}')
    stats = operations(spec)[('GET', '/api/v1/users/{did}/stats')]
    window = next(dereference(spec, p)['schema'] for p in stats['parameters'] if dereference(spec, p)['name'] == 'window')
    require(window == {'enum': ['all', '7d', '30d', '365d'], 'default': 'all'}, 'query_bounds: incorrect statistics window')
    key_schema = spec['components']['parameters']['IdempotencyKey']['schema']
    for value, valid in [('x', True), (' ' * 128, True), ('', False), ('x' * 129, False), ('é', False), ('x\n', False), ('\x7f', False)]:
        errors = list(schema_validator(spec, key_schema, validator_type, checker).iter_errors(value))
        require(not bool(errors) == valid, f'query_bounds: incorrect Idempotency-Key acceptance {value!r}')
        count += 1
    return count


def fixture_value(spec, name):
    example = dereference(spec, {'$ref': '#/components/examples/' + name})
    require('externalValue' in example and 'value' not in example, f'response_examples: missing external fixture {name}')
    path = (API / example['externalValue']).resolve()
    require(path.is_relative_to(API / 'examples'), f'response_examples: fixture escapes examples directory: {name}')
    return load_json(path)


def response_examples(spec, validator_type, checker):
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
        # Alternative error outcomes can share a status and envelope (for
        # example conflict versus unavailable terminal idempotency result).
        # Check every declared variant, not just the inventory's primary case.
        for example_label, example_ref in media['examples'].items():
            alternative = example_ref['$ref'].rsplit('/', 1)[1]
            if alternative == case['example']:
                continue
            value = fixture_value(spec, alternative)
            validate(value, media['schema'], spec, validator_type, checker, f'{key} {example_label}')
            variant = next((variant for variant in case.get('alternatives', []) if variant['example'] == alternative), None)
            require(variant is not None, f'response_examples: alternative fixture inventory missing for {key} {alternative}')
            variant_headers = variant.get('headers', {})
            for name, header in response.get('headers', {}).items():
                header = dereference(spec, header)
                required = header.get('required') or value.get('error', {}).get('code') in header.get('x-required-for-error-codes', [])
                require(not required or name in variant_headers, f'response_examples: missing {name} for {key} {alternative}')
                if name in variant_headers:
                    validate(variant_headers[name], header['schema'], spec, validator_type, checker, f'{key} {alternative} {name}')
            corrupt = deepcopy(value)
            corrupt[first] = False
            require(bool(list(schema_validator(spec, media['schema'], validator_type, checker).iter_errors(corrupt))), f'response_examples: alternative wrong field type accepted for {key}')
            negative_count += 1
    require(seen == expected, f'response_examples: missing statuses {sorted(expected - seen)}')
    # Also validate the declared request examples, rather than assuming success
    # response coverage makes POST bodies valid.
    request_count = 0
    for key, operation in found.items():
        if 'requestBody' in operation:
            media = operation['requestBody']['content']['application/json']
            name = media['examples']['fixture']['$ref'].rsplit('/', 1)[1]
            validate(fixture_value(spec, name), media['schema'], spec, validator_type, checker, f'{key} request')
            request_count += 1
    return len(cases), negative_count, request_count


def schema_cases(spec, validator_type, checker):
    cases = load_json(API / 'examples/schema-cases.json')
    names = set()
    accepted = rejected = 0
    for case in cases:
        require(case['name'] not in names, 'schema_cases: duplicate regression name ' + case['name'])
        names.add(case['name'])
        schema = {'$ref': '#/components/schemas/' + case['schema']}
        errors = list(schema_validator(spec, schema, validator_type, checker).iter_errors(case['value']))
        require(not bool(errors) == case['valid'], f'schema_cases: {case["name"]} expected valid={case["valid"]}; errors={[e.message for e in errors]}')
        accepted += case['valid']
        rejected += not case['valid']
    require(accepted > 0 and rejected > 0, 'schema_cases: positive and negative coverage required')
    return accepted, rejected


def prove_failure_detection(spec):
    missing_route = deepcopy(spec)
    del missing_route['paths']['/health/live']
    missing_csrf = deepcopy(spec)
    missing_csrf['paths']['/api/v1/scrobbles']['post']['security'] = [{'SessionCookie': []}]
    missing_location = deepcopy(spec)
    del missing_location['paths']['/api/v1/scrobbles']['post']['responses']['409']['headers']['Location']
    missing_deletion_location = deepcopy(spec)
    del missing_deletion_location['paths']['/api/v1/follows/{did}']['delete']['responses']['502']['headers']['Location']
    for label, mutated, check in [('removed route', missing_route, route_inventory), ('removed CSRF', missing_csrf, required_auth), ('removed terminal operation Location', missing_location, route_inventory), ('removed terminal deletion Location', missing_deletion_location, route_inventory)]:
        try:
            check(mutated)
        except ContractError:
            continue
        raise ContractError('Failure detection did not reject ' + label)


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
    walk_refs(spec, spec)
    for name, schema in spec['components']['schemas'].items():
        Draft202012Validator.check_schema(schema)
    print(f'PASS openapi_schema: OpenAPI 3.1.0 and {len(spec["components"]["schemas"])} Draft 2020-12 schemas; pinned offline dependencies')
    count = route_inventory(spec)
    print(f'PASS route_inventory: {count} methods on {len(spec["paths"])} paths; exact MVP/API route and status matrices')
    count = required_auth(spec)
    print(f'PASS required_auth: {count} routes; session/CSRF/Origin, callback state and conditional following-feed session')
    count = query_bounds(spec, validator_type, checker)
    print(f'PASS query_bounds: {count} limit/idempotency boundaries; defaults, cursor and window contracts')
    count, negative, requests = response_examples(spec, validator_type, checker)
    print(f'PASS response_examples: {count} response/status fixtures, {negative} rejected wrong-type responses, {requests} request fixtures')
    accepted, rejected = schema_cases(spec, validator_type, checker)
    print(f'PASS schema_cases: {accepted} accepted and {rejected} rejected UTF-8/scalar, timestamp, identifier, ownership-field and payload cases')
    prove_failure_detection(spec)
    print('PASS failure_detection: removed route, missing CSRF and missing terminal replay/deletion Location rejected without changing repository files')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ContractError, KeyError, OSError, ValueError) as error:
        print(f'FAIL contracts: {error}', file=sys.stderr)
        sys.exit(1)
