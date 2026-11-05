import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { analysisDomainFixtureCases } from '../tests/fixtures/analysis-domain';
import { createQuestionDomainFixtureCases } from '../tests/fixtures/question-domain-contracts';
import { createDomainEnvelope, decodeDomainEnvelope, domainSchemas, emptyDomainScope, inspectDomainEnvelope, transportDigest,
  verifyUtf16Span, type DomainEnvelope, type DomainKind, type DomainScope, type DomainDecodeContext } from '../server/contracts/domain-envelope';
import { exportDomainSchemas, writeOrVerifyDomainSchemas } from './export-domain-schemas';

interface ShapeCase { id: string; kind: DomainKind; payload: unknown; expected: boolean; semanticExpected: boolean; context: DomainDecodeContext }
function scopeFor(payload: unknown, context: DomainDecodeContext): DomainScope {
  const scope = { ...emptyDomainScope(), ownerId: 'explicit-synthetic-owner', sourceRevision: context.source?.revision ?? null,
    studentId: context.source?.studentId ?? null, recordRevision: context.source?.recordRevision ?? null, sourceContentSha256: context.source?.contentSha256 ?? null };
  const row = payload as Record<string, unknown>;
  for (const key of ['studentId', 'supportTargetId', 'recordRevision', 'sourceContentSha256', 'profileRevision'] as const) if (typeof row[key] === 'string') scope[key] = row[key];
  if (typeof row.analysisRevision === 'string') scope.analysisRevision = row.analysisRevision;
  else if (typeof row.revision === 'string' && Array.isArray(row.activities)) scope.analysisRevision = row.revision;
  const targets = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('supportTargetId' in value && typeof value.supportTargetId === 'string') scope.supportTargetId = value.supportTargetId;
    Object.values(value).forEach(targets);
  };
  targets(payload); return scope;
}
const accepted = (fn: () => unknown) => { try { fn(); return true; } catch { return false; } };
async function main() {
  await writeOrVerifyDomainSchemas(true);
  const schemas = exportDomainSchemas(), ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
  const validators = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema as object)]));
  const fixtures: ShapeCase[] = [
    ...analysisDomainFixtureCases().map(row => ({ id: row.name, kind: row.contract, payload: row.input, expected: row.expectedValid, semanticExpected: row.expectedSemanticValid, context: { source: row.source } })),
    ...(await createQuestionDomainFixtureCases()).map(row => ({ id: row.id, kind: row.kind, payload: row.payload, expected: row.schemaExpected, semanticExpected: row.expected, context: { draft: row.draft } })),
  ];
  const candidate = fixtures.find(row => row.kind === 'prepared-main-candidate' && row.expected)!;
  fixtures.push({ ...candidate, id: 'candidate-hex-final-newline-rejected', payload: { ...(candidate.payload as object), id: 'a'.repeat(64) + '\n' }, expected: false, semanticExpected: false });
  const shapes = fixtures.map(row => {
    const payload = JSON.parse(JSON.stringify(row.payload));
    const zod = domainSchemas[row.kind].safeParse(payload).success, jsSchema = Boolean(validators[row.kind](payload));
    assert.equal(zod, row.expected, row.id + ':Zod'); assert.equal(jsSchema, row.expected, row.id + ':Ajv');
    return { id: row.id, kind: row.kind, payload, expected: row.expected };
  });
  const roundtrips = [];
  const envelopes: { id: string; input: DomainEnvelope; expected: boolean; expectedScope?: Partial<DomainScope> }[] = [];
  for (const row of fixtures) {
    let envelope: DomainEnvelope | undefined;
    const valid = accepted(() => { envelope = createDomainEnvelope(row.kind, row.payload, scopeFor(row.payload, row.context), row.context); });
    assert.equal(valid, row.semanticExpected, row.id + ':existing TS domain adapter');
    if (!envelope) continue;
    assert.equal(JSON.stringify(decodeDomainEnvelope(envelope, row.context)), JSON.stringify(row.payload), row.id + ':roundtrip');
    roundtrips.push({ id: row.id, payloadSha256: envelope.payloadSha256, unchanged: true });
    envelopes.push({ id: row.id + ':transport', input: envelope, expected: true });
  }
  const base = envelopes.find(row => row.input.kind === 'student-objective-candidate')!.input;
  const add = (id: string, input: DomainEnvelope, expected = false) => envelopes.push({ id, input, expected });
  add('transport-byte-tamper', { ...base, payloadJson: base.payloadJson + ' ' });
  add('transport-future-envelope', { ...base, envelopeVersion: 'future' } as unknown as DomainEnvelope);
  add('transport-future-payload', { ...base, payloadVersion: 'future' });
  add('transport-owner-empty-not-unknown', { ...base, scope: { ...base.scope, ownerId: '' } });
  add('transport-owner-unknown-is-explicit-null', { ...base, scope: { ...base.scope, ownerId: null } }, true);
  const raw = base.payloadJson.slice(0, -1) + ',"id":"ambiguous"}';
  add('transport-duplicate-key', { ...base, payloadJson: raw, payloadSha256: transportDigest(raw) });
  const surrogate = base.payloadJson.replace('OBJ-synthetic-current-role', '\\ud800');
  add('transport-unpaired-surrogate', { ...base, payloadJson: surrogate, payloadSha256: transportDigest(surrogate) });
  const common = envelopes.find(row => row.id === 'objective-common-empty-no-fake-record:transport')!.input;
  add('transport-nested-target-mismatch', { ...common, scope: { ...common.scope, supportTargetId: 'wrong-target' } });
  const full = envelopes.find(row => row.input.kind === 'full-student-analysis')!.input;
  add('transport-student-mismatch', { ...full, scope: { ...full.scope, studentId: 'wrong-student' } });
  add('transport-source-content-mismatch', { ...full, scope: { ...full.scope, sourceContentSha256: 'f'.repeat(64) } });
  const wire = envelopes.find(row => row.input.kind === 'student-analysis-codec-v2')!.input;
  for (const key of ['studentId', 'sourceRevision', 'recordRevision', 'sourceContentSha256'] as const) {
    envelopes.push({ id: 'transport-expected-source-' + key, input: { ...wire, scope: { ...wire.scope, [key]: key === 'sourceContentSha256' ? 'f'.repeat(64) : 'wrong-pin' } }, expected: false, expectedScope: wire.scope });
  }
  const spans = [
    { id: 'astral-exact', source: '가🙂나', start: 1, end: 3, quote: '🙂', expected: true },
    { id: 'astral-split', source: '가🙂나', start: 1, end: 2, quote: '\ud83d', expected: false },
    { id: 'codepoint-confused-with-UTF16', source: '가🙂나', start: 2, end: 3, quote: '나', expected: false },
    { id: 'after-astral', source: '가🙂나', start: 3, end: 4, quote: '나', expected: true },
    { id: 'empty-span', source: 'abc', start: 1, end: 1, quote: '', expected: false },
    { id: 'fractional-offset', source: 'abc', start: 0.5, end: 2, quote: 'ab', expected: false },
    { id: 'no-Unicode-normalization', source: 'e\u0301', start: 0, end: 2, quote: 'é', expected: false },
    { id: 'decomposed-exact', source: 'e\u0301', start: 0, end: 2, quote: 'e\u0301', expected: true },
  ];
  const tsEnvelopes = envelopes.map(row => {
    const valid = accepted(() => inspectDomainEnvelope(row.input, row.expectedScope)); assert.equal(valid, row.expected, row.id);
    return { id: row.id, valid, ...(valid ? { payloadJson: row.input.payloadJson } : {}) };
  });
  const tsSpans = spans.map(row => { const valid = verifyUtf16Span(row.source, row.start, row.end, row.quote); assert.equal(valid, row.expected, row.id); return { id: row.id, valid }; });
  let python;
  const env = { ...process.env, PYTHONPATH: [path.resolve('artifacts/contracts-validation-deps'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  for (const [command, prefix] of [['py', ['-3.11']], ['python', []], ['python3', []]] as const) {
    const run = spawnSync(command, [...prefix, '-X', 'utf8', 'scripts/validate-domain-contracts.py'], { encoding: 'utf8', windowsHide: true, env,
      input: JSON.stringify({ schemas, shapes, envelopes, spans }), maxBuffer: 8_000_000, timeout: 60_000 });
    if (run.error?.message.includes('ENOENT') || run.status !== 0 && /No module named 'jsonschema'|No suitable Python runtime/.test(run.stderr ?? '')) continue;
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(run.stderr); python = JSON.parse(run.stdout); break;
  }
  if (!python) throw new Error('Install pinned packages/contracts/requirements-validation.txt before parity validation');
  assert.equal(python.validator_version, '4.26.0');
  assert.deepEqual(python.shapes, shapes.map(row => ({ id: row.id, valid: row.expected })));
  assert.deepEqual(python.envelopes, tsEnvelopes); assert.deepEqual(python.spans, tsSpans);
  const report = { status: 'passed', generatedAt: new Date().toISOString(), schemaCount: 6, shapeCases: shapes.length,
    transportCases: envelopes.length, sourceSpanCases: spans.length, roundtripCases: roundtrips.length,
    validators: { ts: 'existing Zod 4.6.7 + current domain adapters', javascript: 'Ajv 6.15.0 native generated Draft-07', python: 'jsonschema 4.26.0 Draft7Validator' },
    sharedScope: 'shape + carried scope consistency + exact payloadJson SHA256 + portable JSON + explicit UTF16 span checks',
    differences: { contextualSourceQaAndLegacyHashRecomputation: 'TS authoritative only; Python preserves exact legacy bytes, does not claim authorization/source QA',
      shapeValidButTsDomainRejected: fixtures.filter(row => row.expected && !row.semanticExpected).map(row => row.id),
      ordinaryStringLengths: 'Unicode code points in installed Zod and JSON Schema; source offsets separately UTF16 code units',
      regexEndAnchors: 'current hex pattern exported with strict end lookahead to prevent Python trailing-newline acceptance; unknown patterns fail export',
      unpairedSurrogatesDuplicateKeysUnsafeNumbers: 'rejected at transport only; no rewriting of legacy domain files' },
    sourceSchemasChanged: false, evaluationApprovalGranted: false, originalArtifactsWritten: false, providerCalls: 0,
    shapes: shapes.map(row => ({ id: row.id, valid: row.expected })), envelopes: tsEnvelopes.map(({ id, valid }) => ({ id, valid })), spans: tsSpans, roundtrips };
  await mkdir('artifacts/pr05', { recursive: true }); await writeFile('artifacts/pr05/domain-contracts-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, shapes: undefined, envelopes: undefined, spans: undefined, roundtrips: undefined }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
