import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';

// Run the actual report assembler and real growth rules. All database reads are
// fixture snapshots; writes, devices, storage and provider calls fail this test.
const growth = await tsImport('../apps/web/src/lib/learning-growth.ts', import.meta.url);
const analysis = await tsImport('../apps/web/src/lib/speech-analysis.ts', import.meta.url);
const navigation = await tsImport('../apps/web/src/lib/learning-navigation.ts', import.meta.url);
const silence = await tsImport('../apps/web/src/lib/speech-silence.ts', import.meta.url);
const targetScope = await tsImport('../apps/web/src/lib/learning-target-scope.ts', import.meta.url);
const {buildSpeechTelemetry} = await tsImport('../apps/web/src/lib/speech-telemetry.ts', import.meta.url);
const user = { id: 'owned-student', role: 'student' };
const target = { university: '서울시립대학교', department: '환경공학부', admission_year: 2027, campus:'본교',admission_type:'학생부종합' };
const base = {
  question_id: 'owned-question', question: '본인 역할과 측정 근거를 말해 주세요.',
  target_id: 'owned-target', target_snapshot: target, content_version: 6,
  source_type: 'personal', practice_kind: 'personal', required_meanings: ['본인 역할', '근거·수치'],
  assistance_recorded: true, response_mode: 'audio', revision_kind: 'interview_answer',
};
const cleanup = { cleanupStatus: 'completed', cleanupModel: 'gpt-6-luna', rawHash: 'fixture-raw-hash', studentEdited: true };
let versions = [];
let mediaRecordings = [], quizRecordings = [];
const reads = [];
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const forbidden = () => { throw new Error('No writes, providers, storage or device access in provenance regression.'); };
async function query(sql, params) {
  assert.match(sql, /^select /i, 'report assembler performs read-only queries');
  reads.push({ sql, params });
  if(sql.startsWith('select id,data from support_targets'))return [{id:'owned-target',data:target}];
  if (sql.startsWith('select session_id,created_at,data from interview_reports')) {
    assert.deepEqual(Array.from(params), ['owned-report', user.id]);
    return [{ session_id: 'after-session', created_at: '2026-10-15T11:00:00Z', data: { sections: [{ questionId: base.question_id }] } }];
  }
  if (sql.startsWith('select id from interview_sessions')) {
    assert.deepEqual(Array.from(params), ['after-session', user.id]);
    return [{ id: 'after-session' }];
  }
  assert.ok(
    sql.startsWith('select m.id,m.session_id') || sql.startsWith('select r.id,r.session_id') ||
    sql.startsWith('select r.id,r.content,r.created_at') || sql.startsWith('select t.id,t.session_id'),
    'only expected owned report reads are mocked',
  );
  assert.equal(params[0], user.id);
  if(sql.startsWith('select m.id,m.session_id'))return mediaRecordings;
  if(sql.startsWith('select r.id,r.session_id'))return quizRecordings;
  return [];
}
const module = { exports: {} };
const source = fs.readFileSync(new URL('../apps/web/src/lib/speech-growth-store.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, Date, Map, Set,
  require(name) {
    if (name === 'server-only') return {};
    if (name === 'node:crypto') return { createHash: forbidden };
    if (name === './auth') return { supabaseServer: forbidden };
    if (name === './ai') return { FeatureError: forbidden };
    if (name === './db') return { query, ApiError, transaction: forbidden };
    if (name === './learning-workflows') return { getLearningWorkflows: async owned => { assert.equal(owned, user); return { versions }; } };
    if (name === './learning-navigation') return navigation;
    if (name === './learning-target-scope') return targetScope;
    if (name === './speech-analysis') return analysis;
    if (name === './speech-silence') return silence;
    if (name === './learning-growth') return growth;
    if (name === './recording-transcription') return {transcriptionResponse:(metadata,text)=>({rawTranscript:text,transcript:metadata.displayTranscript||null,transcriptionStatus:metadata.transcriptionStatus,transcriptionError:metadata.transcriptionError})};
    if (name === './speech-transcription') return new Proxy({}, { get: () => forbidden });
    throw new Error('Unexpected dependency: ' + name);
  },
});
const readReport = async scope => JSON.parse(JSON.stringify(await module.exports.getGrowthPayload(user, scope)));
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const previous = { ...base, id: 'before', session_id: 'before-session', created_at: '2026-10-15T09:00:00Z', script: '결과를 봤습니다.', raw_script: '음 결과를 봤습니다.', transcript_formatting: { ...cleanup, studentEdited: false } };
const edited = { ...base, id: 'after', session_id: 'after-session', created_at: '2026-10-15T10:00:00Z', script: '제가 시료 준비를 맡았습니다. 조건을 3회 반복했습니다.', raw_script: previous.raw_script, transcript_formatting: cleanup };
versions = [previous, edited];
const originalSnapshots = JSON.stringify(versions);
let report = await readReport();
let compared = report.content.comparisons[0];
check(compared.before.raw_script === previous.raw_script && compared.after.raw_script === edited.raw_script, 'actual report serialization retains both raw utterances');
assert.deepEqual(compared.after.transcript_formatting, cleanup); checks++;
check(compared.after.script === edited.script && compared.before.script === previous.script, 'readable submitted answers are preserved separately');
check(compared.addedDetails.length === 0 && compared.addedElements.length === 0, 'student edits and cleaned text cannot manufacture spoken development');
check(compared.elements.every(element => element.afterEvidence.length === 0), 'a typed role and number absent from raw speech are not quoted as spoken evidence');
check(compared.missingElements.includes('본인 역할') && compared.missingElements.includes('근거·수치'), 'next practice observes unresolved spoken criteria');
check(report.next.questionId === base.question_id && report.next.reason.includes('본인 역할'), 'next practice follows the actual missing spoken role');
check(JSON.stringify(versions) === originalSnapshots, 'report assembly never edits the original answer snapshots');

// A scoped, frozen report uses the same raw evidence and excludes later speech.
versions = [...versions, { ...edited, id: 'future', created_at: '2026-10-16T10:00:00Z', raw_script: '제 담당은 측정표 작성이었습니다. 9회 측정했습니다.' }];
report = await readReport({ reportId: 'owned-report' });
compared = report.content.comparisons[0];
check(compared.after.id === edited.id && compared.after.raw_script === edited.raw_script, 'frozen report cutoff retains original raw speech and excludes future attempts');
check(compared.addedElements.length === 0 && report.scope.reportId === 'owned-report', 'historical report does not inherit later role or numeric evidence');

// A genuinely new utterance is still compared, including its original filler.
const spoken = { ...edited, raw_script: '음 제 담당은 측정표 작성이었습니다. 조건을 3회 반복했습니다.', script: '제 담당은 측정표 작성이었습니다. 조건을 3회 반복했습니다.', transcript_formatting: { ...cleanup, studentEdited: false } };
versions = [previous, spoken];
report = await readReport();
compared = report.content.comparisons[0];
check(compared.addedElements.includes('본인 역할') && compared.addedElements.includes('근거·수치'), 'new role and numeric evidence in actual speech remain observable');
check(compared.elements.find(element => element.key === 'role').afterEvidence[0] === '음 제 담당은 측정표 작성이었습니다.', 'report evidence quotes original speech instead of its cleaned display');
check(compared.after.script === spoken.script && compared.after.transcript_formatting.studentEdited === false, 'formatted view and speech provenance remain distinct');

// Legacy text-only records continue to use the text the student actually saved.
versions = [previous, { ...spoken, raw_script: null, transcript_formatting: undefined, response_mode: 'text' }];
report = await readReport();
compared = report.content.comparisons[0];
check(compared.elements.find(element => element.key === 'role').afterEvidence[0] === '제 담당은 측정표 작성이었습니다.', 'text-only and legacy records retain their existing submitted-text fallback');
check(reads.length > 0, 'tests executed actual report assembly through mocked owned reads');

// Explicit silence diagnostics stay available as files but cannot manufacture a
// "fewer pauses" improvement or displace an actual utterance as the default.
versions=[];
const microphone=(silent=false)=>buildSpeechTelemetry(Array.from({length:20},(_,index)=>({atMs:index*100,rms:silent?0:index>2&&index<18?.05:.001})),2000);
const recording=(id,date,metadata={})=>({id,session_id:'session-'+id,mime:'audio/wav',question_id:base.question_id,prompt:base.question,target_id:base.target_id,target_snapshot:target,content_version:6,created_at:date,metadata:{speechTelemetry:microphone(),transcriptionStatus:'completed',transcript:'제가 관찰했습니다.',...metadata}});
mediaRecordings=[recording('silence-latest','2026-10-15T13:00:00Z',{speechTelemetry:microphone(true),transcriptionStatus:'failed',transcript:null,transcriptionError:silence.NO_SPEECH_MESSAGE}),recording('spoken-before','2026-10-15T09:00:00Z')];
quizRecordings=[recording('spoken-after','2026-10-15T12:00:00Z')];
const originalRecordingSnapshots=JSON.stringify([mediaRecordings,quizRecordings]);
report=await readReport();
check(report.speech.recordings.length===3&&report.speech.recordings[0].id==='silence-latest','diagnosed file and failure remain in the original chronological recording archive');
check(report.speech.recordings[0].growthEligible===false&&report.speech.defaultRecordingId==='spoken-after','legacy explicit no-speech diagnosis cannot become default growth observation');
check(report.speech.trend.before.id==='spoken-before'&&report.speech.trend.after.id==='spoken-after','same-question trend compares actual utterances while excluding silent diagnostic');
check(JSON.stringify([mediaRecordings,quizRecordings])===originalRecordingSnapshots,'growth exclusion never rewrites saved recording or failure metadata');
mediaRecordings[0].metadata.transcriptionError='오류 문구 변경';mediaRecordings[0].metadata.transcriptionErrorCode='NO_SPEECH_DETECTED';
report=await readReport();
check(report.speech.recordings[0].growthEligible===false,'durable no-speech code remains explicit even if its localized message changes');
quizRecordings.push(recording('temporary-stt-outage','2026-10-15T14:00:00Z',{transcriptionStatus:'failed',transcript:null,transcriptionErrorCode:'TRANSCRIPTION_FAILED',transcriptionError:'일시적인 전사 연결 오류'}));
report=await readReport();
check(report.speech.defaultRecordingId==='temporary-stt-outage'&&report.speech.recordings[0].growthEligible===true,'temporary STT failure retains actual microphone observation and remains eligible');
check(report.speech.trend.after.id==='temporary-stt-outage','a provider outage alone does not discard a valid measured utterance');
mediaRecordings[0].metadata.transcript='보존된 이전 정상 발화';
report=await readReport();
check(report.speech.recordings.find(row=>row.id==='silence-latest').growthEligible===true,'existing normal raw evidence is never excluded due to a stale failure flag');
mediaRecordings[0].metadata.transcript=null;quizRecordings=[];mediaRecordings=mediaRecordings.slice(0,1);
report=await readReport();
check(report.speech.defaultRecordingId===null&&report.speech.trend===null&&report.speech.status==='not_measured','only diagnosed silence produces no default growth measurement or trend');
check(report.speech.recordings.length===1,'silence-only archive still preserves the owned original playback file');
versions=[previous,edited,{...edited,id:'removed-answer',target_id:'removed-school',target_snapshot:{...target,university:'국민대학교'},question:'국민대학교 인재상 질문',created_at:'2026-10-16T10:00:00Z'}];
report=await readReport({targetId:'owned-target'});
check(!JSON.stringify(report).includes('국민대학교'),'deleted school never enters current comparison or next recommendation');
check(report.next.href.includes('targetId=owned-target'),'next recommendation remains bound to active selected school');
await assert.rejects(()=>readReport({targetId:'removed-school'}),error=>error.status===404);checks++;
versions=[{...previous,target_id:'removed-school'},{...edited,target_id:'removed-school'}];
report=await readReport({reportId:'owned-report'});
check(report.content.comparisons.length===1,'frozen historical report remains readable after the target is removed');
console.log(`Speech growth provenance: ${checks} checks passed; database writes and provider/device requests: 0.`);
