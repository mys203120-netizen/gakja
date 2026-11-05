import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ACTIVITIES_JSON_PATH, ACTIVITIES_MARKDOWN_PATH, activityFields, activitySourceSpans, buildPreparedActivities, loadPreparedActivities, materializeActivitySpanSelection, projectPreparedActivities, renderPreparedActivitiesMarkdown, savePreparedActivities } from '../server/data/prepared-activities';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { FullStudentAnalysis } from '../server/data/full-student-analysis';

// Explicit synthetic source fixture: no actual student, model call, or interview session is involved.
function fixtureContext(): InterviewContext {
  const text = '학생이 자료를 조사함. 모둠과 함께 표를 제작함. 비교 기준을 바꾸기 위해 방법을 선택함. 20개 표본을 정리함. 탐구 태도가 돋보임.';
  return { errors: [], target: { studentName: '합성 검증', university: '합성 학교' }, student: { evidence: [{ id: 'SYNTHETIC-S1', activityId: 'SYNTHETIC-A1', text, title: '합성 원문', grade: 1, page: 1, section: '합성 사례', confirmationStatus: 'confirmed_from_record', sourceRef: { file: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'synthetic-fixture', startOffset: 100, endOffset: 100 + text.length }, scientificTruthVerification: 'not_independently_verified' }] }, manifest: { schemaVersion: 'local-interview-source-manifest-v3', errors: [], files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: 'a'.repeat(64) }], guidelineSourceVersions: { operatingGuidelines: '2.0', questionGuidelines: '2.3', evaluationGuidelines: '2.3' }, sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 1 } } } as unknown as InterviewContext;
}
function extraction() { return { units: [{ sourceId: 'SYNTHETIC-S1', ...Object.fromEntries(activityFields.map(field => [field, []])), recordedContext: ['자료를 조사함.'], studentActions: ['학생이 자료를 조사함.'], teamActions: ['모둠과 함께 표를 제작함.'], numbers: ['20개 표본을 정리함.'], teacherObservations: ['탐구 태도가 돋보임.'] }] }; }
test('offline units preserve original excerpts and bind every fact to exact PDF offsets; absent reasons/outcomes remain unknown', () => {
  const context = fixtureContext(), cache = buildPreparedActivities(context, extraction(), { model: 'synthetic-model' });
  assert.equal(cache.coverage.independentActivityCount, null);
  assert.equal(cache.units[0].excerpt, context.student.evidence[0].text);
  assert.deepEqual(cache.units[0].unknownFields, ['choiceReasons', 'outcomes']);
  for (const field of activityFields) for (const quote of cache.units[0].facts[field]) {
    assert.equal(context.student.evidence[0].text.slice(quote.excerptStartOffset, quote.excerptEndOffset), quote.quote);
    assert.equal(quote.pdfStartOffset, quote.excerptStartOffset + 100);
    assert.equal(quote.pdfEndOffset, quote.excerptEndOffset + 100);
    assert.equal(quote.sourceId, 'SYNTHETIC-S1');
  }
});
test('missing/duplicated sources, invented facts, numeric changes, praise and collective-action upgrades fail closed', () => {
  const context = fixtureContext(), input = extraction();
  assert.throws(() => buildPreparedActivities(context, { units: [...input.units, ...input.units] }, { model: 'synthetic-model' }));
  for (const patch of [ { sourceId: 'not-in-source' }, { studentActions: ['없는 행동을 개발함.'] }, { studentActions: ['탐구 태도가 돋보임.'] }, { studentActions: ['모둠과 함께 표를 제작함.'] }, { numbers: ['30개 표본을 정리함.'] }, { numbers: ['학생이 자료를 조사함.'] } ]) assert.throws(() => buildPreparedActivities(context, { units: [{ ...input.units[0], ...patch }] }, { model: 'synthetic-model' }));
  context.manifest.sourceIntegrity.evidenceTextVerified = false;
  assert.throws(() => buildPreparedActivities(context, input, { model: 'synthetic-model' }));
});
test('fixed span selection copies exact original strings and cannot use an invented or teacher-praise span as an individual action', () => {
  const source = fixtureContext().student.evidence, spans = activitySourceSpans(source);
  const action = spans.find(span => span.quote === '학생이 자료를 조사함.')!;
  const praise = spans.find(span => span.quote === '탐구 태도가 돋보임.')!;
  const selected = { units: [{ sourceId: source[0].id, ...Object.fromEntries(activityFields.map(field => [field, []])), studentActions: [action.id] }] };
  assert.deepEqual(materializeActivitySpanSelection(source, selected).units[0].studentActions, [action.quote]);
  assert.throws(() => materializeActivitySpanSelection(source, { units: [{ ...selected.units[0], studentActions: [praise.id] }] }));
  assert.throws(() => materializeActivitySpanSelection(source, { units: [{ ...selected.units[0], studentActions: ['INVENTED-SPAN'] }] }));
  assert.throws(() => buildPreparedActivities(fixtureContext(), { units: [{ sourceId: source[0].id, ...Object.fromEntries(activityFields.map(field => [field, []])) }] }, { model: 'synthetic-model' }));
});
test('atomic cache roundtrip makes zero provider calls and rejects changed sources/model/rules/quotes or a partial Markdown pair', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'interview-activities-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('interview-activities-')); await rm(root, { recursive: true, force: true }); });
  const context = fixtureContext(), cache = buildPreparedActivities(context, extraction(), { model: 'synthetic-model' });
  await savePreparedActivities(cache, context, root);
  assert.deepEqual(await loadPreparedActivities(context, root, 'synthetic-model'), cache);
  assert.equal(await loadPreparedActivities(context, root, 'different-model'), null);
  const changed = structuredClone(context); changed.manifest.files[0].sha256 = 'b'.repeat(64);
  assert.equal(await loadPreparedActivities(changed, root, 'synthetic-model'), null);
  const json = await readFile(path.join(root, ACTIVITIES_JSON_PATH), 'utf8');
  for (const mutate of [ (value: typeof cache) => { value.rulesVersion = 'obsolete' as typeof cache.rulesVersion; }, (value: typeof cache) => { value.units[0].facts.studentActions[0].pdfEndOffset++; }, (value: typeof cache) => { value.units[0].excerpt += '원문 외 주장'; } ]) {
    const value = JSON.parse(json) as typeof cache; mutate(value); await writeFile(path.join(root, ACTIVITIES_JSON_PATH), JSON.stringify(value));
    assert.equal(await loadPreparedActivities(context, root, 'synthetic-model'), null);
  }
  await writeFile(path.join(root, ACTIVITIES_JSON_PATH), json);
  await writeFile(path.join(root, ACTIVITIES_MARKDOWN_PATH), '부분 기록');
  assert.equal(await loadPreparedActivities(context, root, 'synthetic-model'), null);
});

test('full-analysis compatibility splits long field proofs into exact bounded spans and preserves complete raw facts',()=>{
  const context=fixtureContext(),source=context.student.evidence[0];
  source.text=Array.from({length:7},(_,i)=>`단계${i}에서 입력값${i}을 기록하고 조건${i}의 처리 결과를 비교한 후 저장하는 절차를 설명했다.`).join(' ');
  source.sourceRef.endOffset=source.sourceRef.startOffset+source.text.length;source.originEntityId=source.activityId;
  const proof={sourceRefId:'actual-source-block',page:1,pageStart:100,pageEnd:100+source.text.length,quote:source.text,sourceTextSha256:'a'.repeat(64)};
  const facts=Object.fromEntries(['recordedContext','studentActions','teamActions','choiceReasons','outcomes','teacherObservations'].map(field=>[field,[proof]]));
  const analysis={revision:'verified-full-analysis',contentSha256:'b'.repeat(64),derivationVersion:'full-record-deep-v1',model:'source-authoring-model',codecVersion:'student-analysis-codec-v2',generatedAt:'2026-01-01T00:00:00.000Z',activities:[{id:source.activityId,facts}]}as unknown as FullStudentAnalysis;
  const before=JSON.stringify({analysis,evidence:context.student.evidence}),projected=projectPreparedActivities(context,analysis);
  assert.equal(JSON.stringify({analysis,evidence:context.student.evidence}),before,'canonical proof bytes and raw evidence never change');
  assert.equal(projected.units[0].excerpt,source.text);
  assert.equal(projected.provenance.actualProvider,false);
  assert.ok(projected.provenance.fullAnalysisProjection!.partialFieldCount>0);
  for(const field of activityFields){const selected=projected.units[0].facts[field];assert.ok(selected.length<=4);for(const span of selected){assert.ok(span.quote.length<=360);assert.equal(source.text.slice(span.excerptStartOffset,span.excerptEndOffset),span.quote);}}
  assert.equal(projected.units[0].facts.studentActions.length,4);
  assert.match(renderPreparedActivitiesMarkdown(projected),/원문 발췌 전체와 공통 분석의 사실·출처는 변경하지 않으며/u);
});
