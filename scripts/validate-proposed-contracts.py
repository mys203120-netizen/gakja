"""Read-only validation of the frozen reference; never run its generators."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import sys
from datetime import datetime
from jsonschema import Draft202012Validator, FormatChecker


def date_time(value):
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})', value):
        return False
    parsed = datetime.fromisoformat(value.upper().replace('Z', '+00:00'))
    return parsed.tzinfo is not None


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def source_span(evidence, source):
    start, end = evidence['start_utf16'], evidence['end_utf16']
    if evidence['offset_unit'] != 'utf16_code_unit' or type(start) is not int or type(end) is not int:
        return False
    try:
        raw = source.encode('utf-16-le')
        if not 0 <= start < end <= len(raw) // 2:
            return False
        quote = raw[start * 2:end * 2].decode('utf-16-le', errors='strict')
        return quote == evidence['quote'] and digest(source) == evidence['source_sha256'] and digest(quote) == evidence['quote_sha256']
    except UnicodeError:
        return False


def main():
    root = Path(sys.argv[1]).resolve()
    checker = FormatChecker()
    checker.checks('date-time', raises=(ValueError, TypeError))(date_time)
    validators = {}
    for path in sorted(root.glob('*.schema.json')):
        schema = json.loads(path.read_text(encoding='utf-8'))
        Draft202012Validator.check_schema(schema)
        validators[path.name] = Draft202012Validator(schema, format_checker=checker)
    fixtures = json.loads((root / 'fixtures.json').read_text(encoding='utf-8'))['cases']
    sources = json.loads((root / 'runtime-source-fixtures.json').read_text(encoding='utf-8'))
    additional = json.loads(sys.stdin.read())['additional_cases']

    def outcome(fixture, actual):
        return dict(name=fixture['name'], expected_valid=fixture['expected_valid'], actual_valid=actual, passed=actual == fixture['expected_valid'])

    def validate(fixture):
        return outcome(fixture, validators[fixture['schema']].is_valid(fixture['instance']))

    result = dict(validator='jsonschema', validator_version=importlib.metadata.version('jsonschema'), dialect='2020-12', schema_count=len(validators), shapes=list(map(validate, fixtures)), sources=[outcome(f, source_span(f['evidence'], sources['source_text'])) for f in sources['cases']], additional=list(map(validate, additional)))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if all(row['passed'] for group in ['shapes', 'sources', 'additional'] for row in result[group]) else 1


if __name__ == '__main__':
    sys.exit(main())
