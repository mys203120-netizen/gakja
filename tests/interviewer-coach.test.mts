import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Exercise the actual coach adapter while replacing DB and the SDK transport in this process.
// No network, test accounts, or provider credentials are used.
const capture = { requests: [] as any[], output: {} as any };
(globalThis as any).__interviewerCoachTest = capture;
const modules: Record<string, string> = {
  'server-only': 'module.exports = {};',
  '@/lib/data': 'exports.getLearning = async()=>null;exports.emptyLearning={activities:[],questions:[],answer_scripts:[],source_refs:[],memory_items:[],student_context:{}};',
  '@/lib/school-learning': 'exports.assertCommonAccess=async()=>{};exports.commonInterviewQuestions=async()=>[];exports.interviewLearningHistory=async()=>({answers:[],attempts:[]});exports.schoolLearningIdentityMatches=()=>true;',
  '@/lib/db': `exports.ApiError = class ApiError extends Error {};
    exports.query = async()=>[];
    exports.transaction = async(fn)=>fn({query:async(sql)=>({rows:sql.includes('count(*)')?[{count:0}]:sql.includes('returning id')?[{id:'unit-usage'}]:[]})});`,
  'openai': `module.exports = class OpenAI {
    constructor(){this.responses={create:async(request)=>{const c=globalThis.__interviewerCoachTest;c.requests.push(request);const response={status:'completed',output_text:JSON.stringify(c.output),usage:{input_tokens:0,output_tokens:0}};return request.stream?(async function*(){yield {type:'response.output_text.delta',delta:response.output_text};yield {type:'response.completed',response};})():response;}};}
  }`,
};
const mockFolder = mkdtempSync(join(tmpdir(), 'gakja-reaction-coach-'));
const mockPaths = Object.values(modules).map((source, index) => { const path = join(mockFolder, `${index}.cjs`); writeFileSync(path, source); return path; });
const mockURLs = mockPaths.map(path => pathToFileURL(path).href);
const mockKeys = Object.keys(modules);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (modules[specifier]) return { url: mockURLs[mockKeys.indexOf(specifier)], shortCircuit: true };
  if (specifier.startsWith('@/')) return { url: pathToFileURL(resolve('apps/web/src', `${specifier.slice(2)}.ts`)).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
after(() => { for (const path of mockPaths) unlinkSync(path); rmdirSync(mockFolder); delete (globalThis as any).__interviewerCoachTest; });
process.env.OPENAI_API_KEY = 'unit-only-no-network';
process.env.OPENAI_MODEL = 'gpt-5.6-terra';
process.env.OPENAI_MODEL_INTERVIEW = 'gpt-5.6-terra';
const { coach,coachStream,PROMPT_VERSION } = await import('../apps/web/src/lib/ai.ts');
const {interviewAnswerEvidence}=await import('../apps/web/src/lib/interview-answer-evidence.ts');
const context = { packageId: 'unit-package', contentVersion: '3', targetId: null, activityId: null, questionId: null, target: null, studentContext: {}, activities: [], questions: [], answerScripts: [], sources: [] };
const reactionInput = { question: '대조군의 역할은 무엇인가요?', answer: '조건을 바꾸지 않은 대조군과 비교하여 다른 변수의 영향을 확인했습니다.' };
const grounded = { engagement: 77, signal: 'encouraging', confidence: 'high', evidence: '대조군과 비교하여 다른 변수의 영향을 확인했습니다.', reason: '질문의 역할에 직접 답하고 비교 근거를 연결했습니다.' };

test('both provider adapters separate the current denial and raw speech from approved answer scripts',async()=>{
  const scope={sessionId:'owned-session',turnId:'owned-turn',questionId:'q',targetId:null,contentVersion:'3',activityId:null,briefingId:null};
  const draft='반복 측정은 하지 않았습니다.',raw='음 반복 측정은 하지 않았습니다.';
  const evidence=interviewAnswerEvidence({id:scope.turnId,session_id:scope.sessionId,question_id:'q',data:{question:'역할과 한계는?',draft,mediaId:'recording',rawTranscriptMediaId:'recording',rawTranscript:raw,displayTranscript:draft,transcriptCleanup:{status:'completed'}}},scope)!;
  const approvedScript='도구 보정 후 반복 측정함';
  const currentContext={...context,questionId:'q',questions:[{id:'q',prompt:'역할과 한계는?'}],answerScripts:[{id:'approved-script',question_id:'q',script:approvedScript}],studentAnswerEvidence:evidence};
  const frozen=JSON.stringify(currentContext);capture.output={content:'자료와 현재 학생 진술이 달라 확인이 필요해요.',source_ids:[]};
  for(const stream of [false,true]){
    capture.requests.length=0;let shown='';
    if(stream)await coachStream('unit-student',currentContext,'답변 근거 확인',[{role:'user',content:'제가 반복 측정을 했다는 근거가 있나요?'}],'chat','unit-thread',delta=>{shown+=delta;});
    else await coach('unit-student',currentContext,'답변 근거 확인',[{role:'user',content:'제가 반복 측정을 했다는 근거가 있나요?'}],'chat','unit-thread');
    const request=capture.requests[0];assert.equal(capture.requests.length,1);
    const approved=JSON.parse(request.input[0].content.replace('승인 자료(JSON 데이터): ',''));
    assert.equal(approved.approved_answer_scripts[0].script,approvedScript);assert.equal(approved.student_answer_evidence,undefined);
    const student=JSON.parse(request.input[1].content.replace('현재 학생 답변(JSON 데이터·승인 사실 아님): ',''));
    assert.equal(student.student_answer_evidence.current_draft,draft);assert.equal(student.student_answer_evidence.recording.raw_stt,raw);assert.equal(student.student_answer_evidence.status,'student_statement_unverified');
    assert.match(request.instructions,/학생이 '하지 않았다', '기억나지 않는다'고 한 행동/);assert.match(request.instructions,/자료에는 X라고 되어 있지만/);assert.match(request.instructions,/이전 AI 응답/);assert.match(request.instructions,/후가공본으로 덮어쓰지 않는다/);
    if(stream)assert.equal(shown,capture.output.content);
  }
  assert.equal(JSON.stringify(currentContext),frozen);
});

test('current coaching requests grounded feedback without a facial-expression schema', async () => {
  capture.requests.length = 0; capture.output = { content: '대조군과 비교한 이유가 드러났어요.', source_ids: [], reaction: grounded };
  const result = await coach('unit-student', context, '질문별 피드백', [{ role: 'user', content: reactionInput.answer }], 'interview', 'unit-session');
  assert.equal(capture.requests.length, 1);
  const request = capture.requests[0];
  assert.equal(request.text.format.strict, true); assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(request.text.format.schema.required.includes('reaction'), false);
  assert.equal(request.text.format.schema.properties.reaction, undefined);
  assert.equal(request.model, 'gpt-5.6-terra'); assert.equal(request.store, false);
  assert.equal('reaction' in result, false);
  assert.doesNotMatch(request.instructions, /engagement|호응 표현/);
});

test('default coaching preserves the previous output contract without requesting reactions', async () => {
  capture.requests.length = 0; capture.output = { content: '기존 코칭 응답', source_ids: [] };
  const result = await coach('unit-student', context, '기존 질문별 피드백', [], 'interview');
  assert.equal(capture.requests.length, 1); assert.equal('reaction' in result, false); assert.equal(result.content, capture.output.content);
  assert.equal(capture.requests[0].text.format.schema.properties.reaction, undefined); assert.doesNotMatch(capture.requests[0].instructions, /reaction은/);
});
test('talent coaching receives only the pinned sourced values and permits future plans without inventing student experiences',async()=>{
  capture.requests.length=0;capture.output={content:'정직한 판단의 이유와 앞으로의 실천 방법이 드러났어요.',source_ids:['talent_source']};
  const talentContext={...context,questionId:'talent-question',targetId:'owned-target',target:{id:'owned-target',university:'서울시립대학교',major:'환경공학부'},questions:[{id:'talent-question',prompt:'공학윤리와 연결해 답해 주세요.',activity_ids:[],source_ref_ids:['talent_source'],talent_profile:{id:'uos_environment_talent',revision:1,scope:'department',point:{id:'ethics',label:'배려와 공학윤리'}},source_snapshot:{url:'https://admission.uos.ac.kr/admissionNew/html/susi/total2.do',questionBasis:'training'}}],sources:[{id:'talent_source',type:'school_talent',title:'환경공학부 인재상',quote:'배려와 공학윤리',source_url:'https://admission.uos.ac.kr/admissionNew/html/susi/total2.do'}]};
  const result=await coach('unit-student',talentContext,'인재상 질문 피드백',[],'interview');const request=capture.requests[0];
  assert.equal(capture.requests.length,1);assert.match(request.instructions,/실제 경험이 없는 학생에게 경험을 만들어 요구하지 않는다/);assert.match(request.instructions,/평가 배점을 인재상 정의로 바꾸지 않는다/);
  const input=JSON.parse(request.input[0].content.replace('승인 자료(JSON 데이터): ',''));assert.equal(input.school_talent[0].point.label,'배려와 공학윤리');assert.equal(input.school_talent[0].question_basis,'training');assert.equal(input.school_talent[0].official_past_question,false);assert.deepEqual(input.activities,[]);assert.equal(result.sources[0].source_url,'https://admission.uos.ac.kr/admissionNew/html/susi/total2.do');
});

test('actual feedback request distinguishes the record from a student claim and forbids invented laboratory procedures',async()=>{
  capture.requests.length=0;
  capture.output={content:'학생 답변에 “제 담당은 채취 지점과 비교 조건을 설계하는 일이었습니다.”라고 말했어요. 강우 전후를 구분할 때 무엇이 어려웠나요?',source_ids:['river-source']};
  const source='같은 하천의 세 지점에서 채취한 물의 pH와 탁도를 비교하고 강우 전후 조건을 구분했다. 채취 지점과 비교 조건을 설계하고 측정 기록을 정리했다.';
  const answer='제 담당은 채취 지점과 비교 조건을 설계하는 일이었습니다.';
  const recordedContext={...context,activityId:'river-activity',questionId:'river-question',activities:[{id:'river-activity',title:'하천 수질 탐구',source_ref_ids:['river-source']}],questions:[{id:'river-question',prompt:'맡은 역할과 어려웠던 점은?',activity_ids:['river-activity'],source_ref_ids:['river-source']}],sources:[{id:'river-source',title:'학생부 원문',quote:source}]};
  const preserved=JSON.stringify(recordedContext);
  const result=await coach('unit-student',recordedContext,'면접 리포트 피드백',[{role:'user',content:answer}],'interview','unit-session');
  assert.equal(capture.requests.length,1);
  const request=capture.requests[0],input=JSON.parse(request.input[0].content.replace('승인 자료(JSON 데이터): ',''));
  assert.equal(input.sources[0].quote,source);
  assert.equal(request.input[1].content,answer);
  assert.doesNotMatch(request.input[0].content,/같은 시간 채취|도구 보정|반복 측정/);
  assert.match(request.instructions,/학생의 개별 행동·역할까지 확인된 것은 아니다/);
  assert.match(request.instructions,/같은 시간 채취·도구 보정·반복 측정을 수행했다고 쓰지 않는다/);
  assert.match(request.instructions,/완성형 1인칭 모범답안·다듬은 답변 틀은 작성하지 않는다/);
  assert.match(request.instructions,/학생 진술임을 밝힌다/);
  assert.match(request.instructions,/질문에서 명시적으로 요구한 내용의 확인을 공통 답변 틀보다 우선/);
  assert.equal(result.promptVersion,PROMPT_VERSION);
  assert.equal(result.sources[0].quote,source);
  assert.equal(JSON.stringify(recordedContext),preserved);
});
