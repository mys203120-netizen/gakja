import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const referenceRoot = path.join(projectRoot, 'packages/contracts/reference/proposed-v2-2026-11-06');
const hash = value => createHash('sha256').update(value).digest('hex');

// These received schemas use the intersection of 2020-12 and draft-7. Ajv 6
// cannot validate arbitrary 2020-12: reject additions outside this exact subset.
const sharedKeywords = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum']);
export function draft7ReferenceProjection(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Expected an object schema');
  const copy = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (!sharedKeywords.has(keyword)) throw new Error(`Unsupported 2020-12 keyword in reference adapter: ${keyword}`);
    if (keyword === '$schema') {
      if (value !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('Unexpected reference dialect');
      copy[keyword] = 'http://json-schema.org/draft-07/schema#';
    } else if (keyword === 'properties') copy[keyword] = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, draft7ReferenceProjection(child)]));
    else if (keyword === 'oneOf') copy[keyword] = value.map(draft7ReferenceProjection);
    else if (keyword === 'items') copy[keyword] = draft7ReferenceProjection(value);
    else copy[keyword] = value;
  }
  return copy;
}

// Matches the received Python checker's calendar/time range, including offsets.
// Date.parse alone normalizes some invalid dates (for example February 30).
export function referenceDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1] && (!match[7] || Number(match[8]) <= 23 && Number(match[9]) <= 59);
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function verifyReferenceSourceSpan(evidence, source) {
  const { start_utf16: start, end_utf16: end } = evidence;
  if (typeof source !== 'string' || !wellFormed(source) || evidence.offset_unit !== 'utf16_code_unit' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > source.length) return false;
  const quote = source.slice(start, end);
  return wellFormed(quote) && quote === evidence.quote && hash(source) === evidence.source_sha256 && hash(quote) === evidence.quote_sha256;
}

export async function loadProposedContractReference() {
  const metadata = JSON.parse(await readFile(path.join(projectRoot, 'packages/contracts/import-metadata.json'), 'utf8'));
  if (JSON.stringify((await readdir(referenceRoot)).sort()) !== JSON.stringify(metadata.files.map(file => file.path).sort())) throw new Error('Received artifact inventory changed');
  for (const file of metadata.files) {
    const bytes = await readFile(path.join(referenceRoot, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Received artifact changed: ${file.path}`);
  }
  const originalManifest = JSON.parse(await readFile(path.join(referenceRoot, 'package-manifest.json'), 'utf8'));
  for (const file of originalManifest.files) {
    const bytes = await readFile(path.join(referenceRoot, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Received manifest mismatch: ${file.path}`);
  }
  const ajv = new Ajv({ allErrors: true, unicode: true, schemaId: 'auto' });
  ajv.addFormat('date-time', referenceDateTime);
  const validators = new Map();
  for (const name of (await readdir(referenceRoot)).filter(name => name.endsWith('.schema.json')).sort()) {
    const schema = JSON.parse(await readFile(path.join(referenceRoot, name), 'utf8'));
    validators.set(name, ajv.compile(draft7ReferenceProjection(schema)));
  }
  const fixtures = JSON.parse(await readFile(path.join(referenceRoot, 'fixtures.json'), 'utf8')).cases;
  const sources = JSON.parse(await readFile(path.join(referenceRoot, 'runtime-source-fixtures.json'), 'utf8'));
  if (validators.size !== 5 || fixtures.length !== 52 || sources.cases.length !== 4) throw new Error('Unexpected reference corpus size');
  const additionalCases = [];
  const text = fixtures.find(row => row.name === 'text-valid').instance;
  for (const [name, count, expected_valid] of [['unicode-codepoint-limit', 20_000, true], ['unicode-codepoint-over-limit', 20_001, false]]) additionalCases.push({ name, schema: 'answer-submission.schema.json', instance: { ...text, text: '😀'.repeat(count) }, expected_valid });
  const playback = fixtures.find(row => row.name === 'started-playback').instance;
  additionalCases.push({ name: 'invalid-calendar-date', schema: 'playback-event.schema.json', instance: { ...playback, client_occurred_at: '2026-02-30T10:00:00+09:00' }, expected_valid: false });
  const academic = structuredClone(fixtures.find(row => row.name === 'academic-approved-shape-only').instance);
  academic.packet_refs.push(Object.fromEntries(Object.entries(academic.packet_refs[0]).reverse()));
  additionalCases.push({ name: 'duplicate-object-different-key-order', schema: 'evaluation-scope-approval.schema.json', instance: academic, expected_valid: false });
  const validate = fixture => {
    const validator = validators.get(fixture.schema);
    if (!validator) throw new Error(`Unknown reference schema: ${fixture.schema}`);
    const actual_valid = validator(fixture.instance);
    return { name: fixture.name, expected_valid: fixture.expected_valid, actual_valid, passed: actual_valid === fixture.expected_valid };
  };
  return {
    metadata, schemaCount: validators.size,
    validatorVersion: require('ajv/package.json').version,
    shapes: fixtures.map(validate),
    sources: sources.cases.map(fixture => { const actual_valid = verifyReferenceSourceSpan(fixture.evidence, sources.source_text); return { name: fixture.name, expected_valid: fixture.expected_valid, actual_valid, passed: actual_valid === fixture.expected_valid }; }),
    additionalCases, additional: additionalCases.map(validate),
  };
}
