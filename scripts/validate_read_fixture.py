#!/usr/bin/env python3
"""Independently validate the frozen M5 read-model fixture and its reference values."""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
import unicodedata
from unittest.mock import patch

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc
DIDS = {name: 'did:plc:' + letter * 24 for name, letter in [('Alice', 'a'), ('Bob', 'b'), ('Carol', 'c')]}


class FixtureError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise FixtureError(message)


def unique_keys(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, f'duplicate JSON object key: {key}')
        value[key] = item
    return value


def object_schema(properties, required=None):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties,
            'required': list(properties) if required is None else required}


def schema():
    text = {'type': 'string', 'minLength': 1, 'maxLength': 256, 'pattern': r'\S'}
    date = {'type': 'string', 'format': 'date-time', 'pattern': r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$'}
    did = {'type': 'string', 'pattern': r'^did:plc:[a-z2-7]{24}$'}
    record = object_schema({
        '$type': {'const': 'com.example.atmusic.scrobble'}, 'artist': text, 'track': text,
        'album': text, 'listenedAt': date, 'createdAt': date,
        'durationSeconds': {'type': 'integer', 'minimum': 0, 'maximum': 86400},
        'recordingMbid': {'type': 'string', 'format': 'uuid'},
    }, ['$type', 'artist', 'track', 'listenedAt', 'createdAt'])
    row = object_schema({
        'rkey': {'type': 'string', 'pattern': r'^r(?:0[1-9]|10)$'}, 'owner': did,
        'uri': {'type': 'string', 'pattern': r'^at://did:plc:[a-z2-7]{24}/com\.example\.atmusic\.scrobble/r(?:0[1-9]|10)$'},
        'state': {'enum': ['confirmed', 'deleted']}, 'source': {'enum': ['local', 'external']},
        'record': record,
    })
    count = {'type': 'integer', 'minimum': 0}
    totals = object_schema({name: count for name in ['totalScrobbles', 'distinctArtists', 'distinctTracks']})
    rkeys = {'type': 'array', 'uniqueItems': True, 'items': {'type': 'string', 'pattern': r'^r(?:0[1-9]|10)$'}}
    result = object_schema({
        'schemaVersion': {'const': 1}, 'asOf': {'const': '2026-01-15T12:00:00Z'},
        'users': object_schema({name: object_schema({'did': {'const': did_value}, 'handle': {'const': name.lower() + '.test'}})
                                for name, did_value in DIDS.items()}),
        'scrobbles': {'type': 'array', 'minItems': 10, 'maxItems': 10, 'items': row},
        'follows': {'type': 'array', 'minItems': 1, 'maxItems': 1, 'items': object_schema({
            'actor': {'const': DIDS['Alice']}, 'subject': {'const': DIDS['Bob']}, 'state': {'const': 'confirmed'},
        })},
        'expected': object_schema({
            'aliceHistory': rkeys, 'globalFeed': rkeys, 'aliceFollowingFeed': rkeys,
            'aliceStats': object_schema({window: totals for window in ['all', '7d', '30d', '365d']}),
        }),
    })
    result['$schema'] = 'https://json-schema.org/draft/2020-12/schema'
    return result


def fixture_integrity(fixture):
    checker = FormatChecker()
    # jsonschema's optional RFC3339 package is not in the pinned dependency set.
    # Register a local calendar check so invalid dates cannot silently pass.
    @checker.checks('date-time', raises=(ValueError, TypeError))
    def valid_date(value):
        return isinstance(value, str) and at(value) is not None
    validator = Draft202012Validator(schema(), format_checker=checker)
    errors = list(validator.iter_errors(fixture))
    require(not errors, 'fixture schema violation: ' + '; '.join(error.message for error in errors[:3]))
    rows = fixture['scrobbles']
    require(len({row['uri'] for row in rows}) == 10, 'fixture must contain ten unique AT URIs')
    require({row['rkey'] for row in rows} == {f'r{i:02}' for i in range(1, 11)}, 'fixture must contain r01 through r10 exactly once')
    require(Counter(row['owner'] for row in rows) == Counter({DIDS['Alice']: 8, DIDS['Bob']: 1, DIDS['Carol']: 1}),
            'fixture must have nine Alice/Bob rows and one Carol row')
    for row in rows:
        require(row['uri'] == f"at://{row['owner']}/com.example.atmusic.scrobble/{row['rkey']}", 'URI owner/rkey binding differs')
        require(row['state'] == ('deleted' if row['rkey'] == 'r08' else 'confirmed'), 'only r08 is the deleted fixture row')
        require(row['source'] == ('external' if row['rkey'] == 'r10' else 'local'), 'only Carol r10 is externally authored')
        require(row['owner'] == DIDS['Carol'] if row['rkey'] == 'r10' else row['owner'] != DIDS['Carol'], 'Carol ownership differs')


def at(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(UTC)


def normalized(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def order(row):
    return at(row['record']['listenedAt']), row['uri']


def rankings(rows, fields):
    groups = defaultdict(list)
    for row in rows:
        if all(field in row['record'] for field in fields):
            key = tuple(normalized(row['record'][field]) for field in fields)
            groups[key].append(row)
    result = []
    for key, group in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
        newest = max(group, key=order)['record']
        display = tuple(newest[field] for field in fields)
        result.append((key, len(group), display))
    return result


def reference(fixture):
    """No production query/normalizer or host clock contributes to this calculator."""
    as_of = at(fixture['asOf'])
    active = [row for row in fixture['scrobbles'] if row['state'] == 'confirmed']
    history = sorted([row for row in active if row['owner'] == DIDS['Alice']], key=order, reverse=True)
    targets = {edge['subject'] for edge in fixture['follows'] if edge['actor'] == DIDS['Alice'] and edge['state'] == 'confirmed'}
    result = {
        'aliceHistory': [row['rkey'] for row in history],
        'globalFeed': [row['rkey'] for row in sorted(active, key=order, reverse=True)],
        'aliceFollowingFeed': [row['rkey'] for row in sorted(active, key=order, reverse=True) if row['owner'] in targets],
        'stats': {},
    }
    for window, days in [('all', None), ('7d', 7), ('30d', 30), ('365d', 365)]:
        selected = [row for row in history if at(row['record']['listenedAt']) <= as_of
                    and (days is None or at(row['record']['listenedAt']) >= as_of - timedelta(days=days))]
        artists, tracks = rankings(selected, ['artist']), rankings(selected, ['artist', 'track'])
        result['stats'][window] = {
            'totals': {'totalScrobbles': len(selected), 'distinctArtists': len(artists), 'distinctTracks': len(tracks)},
            'artists': artists, 'tracks': tracks, 'albums': rankings(selected, ['artist', 'album']),
        }
    return result


# Independent hardcoded TESTING.md table: keys and display spelling are explicit.
ARTISTS = {
    'all': [(('radiohead',), 3, ('Radiohead',)), (('björk',), 2, ('Björk',)), (('kate bush',), 2, ('Kate Bush',))],
    '7d': [(('björk',), 2, ('Björk',)), (('radiohead',), 2, ('Radiohead',))],
    '30d': [(('radiohead',), 3, ('Radiohead',)), (('björk',), 2, ('Björk',))],
    '365d': [(('radiohead',), 3, ('Radiohead',)), (('björk',), 2, ('Björk',)), (('kate bush',), 1, ('Kate Bush',))],
}
TRACKS = {
    'all': [(('björk','jóga'),2,('Björk','Jóga')), (('kate bush','cloudbusting'),1,('Kate Bush','Cloudbusting')),
            (('kate bush','running up that hill'),1,('Kate Bush','Running Up That Hill')), (('radiohead','karma police'),1,('Radiohead','Karma Police')),
            (('radiohead','no surprises'),1,('Radiohead','No Surprises')), (('radiohead','weird fishes'),1,('Radiohead','Weird Fishes'))],
    '7d': [(('björk','jóga'),2,('Björk','Jóga')), (('radiohead','no surprises'),1,('Radiohead','No Surprises')), (('radiohead','weird fishes'),1,('Radiohead','Weird Fishes'))],
    '30d': [(('björk','jóga'),2,('Björk','Jóga')), (('radiohead','karma police'),1,('Radiohead','Karma Police')), (('radiohead','no surprises'),1,('Radiohead','No Surprises')), (('radiohead','weird fishes'),1,('Radiohead','Weird Fishes'))],
    '365d': [(('björk','jóga'),2,('Björk','Jóga')), (('kate bush','running up that hill'),1,('Kate Bush','Running Up That Hill')), (('radiohead','karma police'),1,('Radiohead','Karma Police')), (('radiohead','no surprises'),1,('Radiohead','No Surprises')), (('radiohead','weird fishes'),1,('Radiohead','Weird Fishes'))],
}
ALBUMS = {
    'all': [(('björk','homogenic'),2,('Björk','Homogenic')), (('radiohead','ok computer'),2,('Radiohead','OK Computer')), (('kate bush','hounds of love'),1,('Kate Bush','Hounds of Love')), (('radiohead','in rainbows'),1,('Radiohead','In Rainbows'))],
    '7d': [(('björk','homogenic'),2,('Björk','Homogenic')), (('radiohead','in rainbows'),1,('Radiohead','In Rainbows')), (('radiohead','ok computer'),1,('Radiohead','OK Computer'))],
    '30d': [(('björk','homogenic'),2,('Björk','Homogenic')), (('radiohead','ok computer'),2,('Radiohead','OK Computer')), (('radiohead','in rainbows'),1,('Radiohead','In Rainbows'))],
    '365d': [(('björk','homogenic'),2,('Björk','Homogenic')), (('radiohead','ok computer'),2,('Radiohead','OK Computer')), (('radiohead','in rainbows'),1,('Radiohead','In Rainbows'))],
}
TOTALS = {'all': (7,3,6), '7d': (4,2,3), '30d': (5,2,4), '365d': (6,3,5)}


def manual_expectations(fixture):
    actual = reference(fixture)
    for name, expected in [('aliceHistory',['r07','r01','r02','r03','r04','r05','r06']),
                           ('globalFeed',['r09','r10','r07','r01','r02','r03','r04','r05','r06']),
                           ('aliceFollowingFeed',['r09'])]:
        require(actual[name] == expected == fixture['expected'][name], f'exact {name} differs')
    for window, counts in TOTALS.items():
        expected_totals = dict(zip(['totalScrobbles','distinctArtists','distinctTracks'], counts))
        require(actual['stats'][window]['totals'] == expected_totals == fixture['expected']['aliceStats'][window], f'{window} totals differ')
        for name, expected in [('artists', ARTISTS), ('tracks', TRACKS), ('albums', ALBUMS)]:
            require(actual['stats'][window][name] == expected[window], f'{window} exact {name} counts/order/newest spelling differ')
    return actual


def rejected(function, fixture, description):
    try:
        function(fixture)
    except FixtureError:
        return
    raise FixtureError(f'corrupted fixture was accepted: {description}')


def time_reproducibility(fixture, expected):
    require(hasattr(time, 'tzset'), 'timezone matrix requires Linux tzset')
    real_datetime = datetime
    previous_tz = os.environ.get('TZ')
    count = 0
    try:
        for day in ['2024-03-10T09:30:00+00:00', '2026-10-06T00:00:00+00:00', '2030-12-31T23:59:59+00:00']:
            host_day = real_datetime.fromisoformat(day)
            class HostClock(real_datetime):
                @classmethod
                def now(cls, tz=None):
                    return host_day.astimezone(tz)
                @classmethod
                def today(cls):
                    return cls.now().replace(tzinfo=None)
            for zone in ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']:
                os.environ['TZ'] = zone
                time.tzset()
                with patch.object(sys.modules[__name__], 'datetime', HostClock):
                    require(manual_expectations(fixture) == expected, f'reference depends on host day/timezone: {day}/{zone}')
                count += 1
    finally:
        if previous_tz is None:
            os.environ.pop('TZ', None)
        else:
            os.environ['TZ'] = previous_tz
        time.tzset()
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, default=ROOT/'tests/fixtures/read_models.json')
    args = parser.parse_args()
    try:
        fixture = json.loads(args.fixture.read_text(), object_pairs_hook=unique_keys)
        fixture_integrity(fixture)
        for description, mutate in [
            ('duplicate URI', lambda value: value['scrobbles'][1].update(uri=value['scrobbles'][0]['uri'])),
            ('lost deleted marker', lambda value: value['scrobbles'][7].update(state='confirmed')),
            ('wrong owner', lambda value: value['scrobbles'][8].update(owner=DIDS['Alice'])),
            ('wrong external source', lambda value: value['scrobbles'][9].update(source='local')),
            ('unknown private field', lambda value: value['scrobbles'][0]['record'].update(accessToken='fixture-only')),
            ('malformed timestamp', lambda value: value['scrobbles'][0]['record'].update(listenedAt='2026-02-30T11:00:00Z')),
        ]:
            damaged = deepcopy(fixture)
            mutate(damaged)
            rejected(fixture_integrity, damaged, description)
        print('PASS fixture_integrity: schema, ten unique bound URIs, nine local Alice/Bob rows, external Carol r10, deleted r08; six corruption controls rejected')
        expected = manual_expectations(fixture)
        for description, mutate in [
            ('incorrect expected total', lambda value: value['expected']['aliceStats']['all'].update(totalScrobbles=8)),
            ('boundary one second early', lambda value: value['scrobbles'][2]['record'].update(listenedAt='2026-01-08T11:59:59Z')),
            ('newest display spelling', lambda value: value['scrobbles'][0]['record'].update(artist='BJÖRK')),
        ]:
            damaged = deepcopy(fixture)
            mutate(damaged)
            rejected(manual_expectations, damaged, description)
        print('PASS manual_expectations: independent four-window totals and complete artist/track/album rankings, ties and newest spelling; three expectation controls rejected')
        count = time_reproducibility(fixture, expected)
        print(f'PASS time_reproducibility: injected host clock across {count} day/timezone combinations preserves fixed fixture results')
    except (FixtureError, OSError, json.JSONDecodeError) as error:
        parser.exit(1, f'FAIL read fixture: {error}\n')


if __name__ == '__main__':
    main()
