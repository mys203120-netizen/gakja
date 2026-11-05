"""Shared transport validation, NOT TS source QA, authorization or approval.

Forward payloadJson unchanged. Never use json.dumps(payload) to recompute a
legacy TS JSON.stringify hash. No files, pointers or results are written here.
"""
import hashlib
import importlib.metadata
import json
import math
import sys
from jsonschema import Draft7Validator, ValidationError


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('DOMAIN_TRANSPORT_DUPLICATE_KEY')
        result[key] = value
    return result


def portable_json(value):
    if isinstance(value, str):
        value.encode('utf-8', errors='strict')
    elif type(value) in (int, float):
        if not math.isfinite(value) or value == int(value) and abs(value) > 9007199254740991:
            raise ValueError('DOMAIN_TRANSPORT_NUMBER_RANGE')
    elif isinstance(value, list):
        for item in value:
            portable_json(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            portable_json(key)
            portable_json(item)


def inspect_envelope(envelope, checks, expected_scope=None):
    checks['envelope'].validate(envelope)
    portable_json(envelope['scope'])
    for key, value in (expected_scope or {}).items():
        if envelope['scope'].get(key) != value:
            raise ValueError('DOMAIN_EXPECTED_SCOPE_MISMATCH:' + key)
    raw = envelope['payloadJson']
    if hashlib.sha256(raw.encode('utf-8')).hexdigest() != envelope['payloadSha256']:
        raise ValueError('DOMAIN_TRANSPORT_HASH_CHANGED')
    payload = json.loads(raw, object_pairs_hook=no_duplicates)
    portable_json(payload)
    kind = envelope['kind']
    checks[kind].validate(payload)
    version = (payload['schemaVersion'] if kind in ('full-student-analysis', 'target-student-analysis')
               else payload['version'] if kind == 'approved-question-contract'
               else kind if kind == 'student-analysis-codec-v2' else 'unversioned')
    if envelope['payloadVersion'] != version:
        raise ValueError('DOMAIN_PAYLOAD_VERSION_MISMATCH')
    for key in ('studentId', 'supportTargetId', 'recordRevision', 'sourceContentSha256', 'profileRevision'):
        if isinstance(payload.get(key), str) and envelope['scope'][key] != payload[key]:
            raise ValueError('DOMAIN_SCOPE_MISMATCH:' + key)
    revision = payload.get('revision') if kind == 'full-student-analysis' else payload.get('analysisRevision')
    if isinstance(revision, str) and envelope['scope']['analysisRevision'] != revision:
        raise ValueError('DOMAIN_SCOPE_MISMATCH:analysisRevision')
    def target_pins(item):
        if isinstance(item, list):
            for child in item:
                target_pins(child)
        elif isinstance(item, dict):
            if isinstance(item.get('supportTargetId'), str) and item['supportTargetId'] != envelope['scope']['supportTargetId']:
                raise ValueError('DOMAIN_SCOPE_MISMATCH:supportTargetId')
            for child in item.values():
                target_pins(child)
    target_pins(payload)
    return raw


def utf16_span(row):
    source, start, end, quote = row['source'], row['start'], row['end'], row['quote']
    if type(start) is not int or type(end) is not int:
        return False
    try:
        raw = source.encode('utf-16-le', errors='strict')
        if not 0 <= start < end <= len(raw) // 2:
            return False
        return raw[start * 2:end * 2].decode('utf-16-le', errors='strict') == quote
    except UnicodeError:
        return False


def main():
    request = json.load(sys.stdin)
    checks = {}
    for kind, schema in request['schemas'].items():
        Draft7Validator.check_schema(schema)
        checks[kind] = Draft7Validator(schema)
    shapes = [{'id': row['id'], 'valid': checks[row['kind']].is_valid(row['payload'])} for row in request['shapes']]
    envelopes = []
    for row in request['envelopes']:
        try:
            raw = inspect_envelope(row['input'], checks, row.get('expectedScope'))
            envelopes.append({'id': row['id'], 'valid': True, 'payloadJson': raw})
        except (ValueError, UnicodeError, ValidationError, KeyError, TypeError, OverflowError):
            envelopes.append({'id': row['id'], 'valid': False})
    spans = [{'id': row['id'], 'valid': utf16_span(row)} for row in request['spans']]
    print(json.dumps({'validator_version': importlib.metadata.version('jsonschema'),
                     'contextual_domain_validated': False, 'shapes': shapes, 'envelopes': envelopes, 'spans': spans}, ensure_ascii=True))


if __name__ == '__main__':
    main()
