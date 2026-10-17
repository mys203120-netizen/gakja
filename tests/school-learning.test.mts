import assert from 'node:assert/strict';
import { test,after } from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve,join } from 'node:path';
import { readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { extractSchoolBible } from '../scripts/extract-school-bible.mjs';
import { learningTargetIdentityMatches, schoolProfileIdentityMatches } from '../packages/content-contracts/src/workflows.ts';
import {schoolDirectory} from '../apps/web/src/lib/school-directory.ts';
import {schoolQuizTargetIdentity} from '../apps/web/src/lib/school-quiz.ts';
const state={package:null as any,queries:[] as any[],targets:[] as any[],turns:[] as any[],attempts:[] as any[],common:[{id:'common_one',revision:1,prompt:'지원 동기를 설명해 주세요.',source_type:'general_practice',data:{activity_ids:[],source_ref_ids:[]},source:{kind:'training'}}]};
(globalThis as any).__schoolTest=state;
const modules:Record<string,string>={
  'server-only':'module.exports={};',
  '@gakja/content-contracts':`exports.schoolProfileIdentityMatches=${schoolProfileIdentityMatches.toString()};exports.learningTargetIdentityMatches=${learningTargetIdentityMatches.toString()};`,
  '@/lib/data':`exports.emptyLearning={activities:[],questions:[],memory_items:[],source_refs:[],answer_scripts:[],student_context:{}};exports.getLearning=async(id,version)=>{const s=globalThis.__schoolTest;s.queries.push({student:id,version});return s.package||{package:null,learning:exports.emptyLearning};};`,
  '@/lib/db':`exports.ApiError=class ApiError extends Error {constructor(status,message){super(message);this.status=status;}};exports.query=async(sql,args)=>{const s=globalThis.__schoolTest;s.queries.push({sql,args});if(sql.includes('common_interview_questions'))return s.common;if(sql.includes('support_targets'))return sql.includes("nullif(data->>'archived_at','') is null")?s.targets.filter(target=>!target.data.archived_at):s.targets;if(sql.includes('interview_turns'))return s.turns;if(sql.includes('memory_attempts'))return s.attempts;return [];};exports.transaction=async fn=>fn({query:async()=>({rows:[]})});`,
};
const folder=mkdtempSync(join(tmpdir(),'school-learning-'));const keys=Object.keys(modules);const files=keys.map((key,index)=>{const file=join(folder,`${index}.cjs`);writeFileSync(file,modules[key]);return file;});
registerHooks({resolve(specifier,context,next){if(modules[specifier])return {url:pathToFileURL(files[keys.indexOf(specifier)]).href,shortCircuit:true};if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve('apps/web/src',`${specifier.slice(2)}.ts`)).href,shortCircuit:true};return next(specifier,context);}});
after(()=>{files.forEach(unlinkSync);rmdirSync(folder);delete (globalThis as any).__schoolTest;});
const {getLearningContext,rankInterviewCandidates,interviewQuestions,planRootQuestions}=await import('../apps/web/src/lib/ai.ts');
const {schoolRegistrationSchema,reviewedSchoolView,interviewLearningHistory,commonInterviewQuestions}=await import('../apps/web/src/lib/school-learning.ts');
const context={packageId:'p',contentVersion:'1',targetId:null,activityId:null,questionId:null,target:null,studentContext:{},activities:[],questions:[],answerScripts:[],sources:[]} as any;
test('all 88 overview records keep exact local source identity and never invent topic percentages',()=>{const source=readFileSync('2027_면접바이블_대학별정리_v1.0.md');const hash=createHash('sha256').update(source).digest('hex');const schools=extractSchoolBible(source.toString('utf8'),hash);assert.equal(schools.length,88);assert.equal(new Set(schools.map(s=>s.id)).size,88);const lines=source.toString('utf8').split(/\r?\n/);for(const school of schools){assert.equal(school.status,'historical_reference');assert.equal(school.officialConfirmed,false);assert.equal(school.questionDistribution,null);assert.equal(school.evaluationWeights,null);assert.equal(school.source.sha256,hash);assert.ok(school.overview.length);for(const question of school.commonQuestions)assert.ok(lines[question.line-1].includes(question.prompt));}});
test('registration cannot elevate information status or submit profile verification',()=>{const value=schoolRegistrationSchema.parse({referenceId:'school',admissionYear:2027,status:'official_confirmed',evaluation_weights:[90],checkedAt:'today'});assert.equal((value as any).status,undefined);assert.equal((value as any).evaluation_weights,undefined);assert.equal(value.campus,'미정');assert.throws(()=>schoolRegistrationSchema.parse({admissionYear:2027.5}));});
test('changed campus year track or unit downgrades a formerly official overview to stale reference',()=>{const identity={admission_year:2027,university:'합성대학교',campus:'서울',department:'환경공학',admission_type:'일반전형',interview_stage:'1단계'};const review={id:'profile',revision:1,status:'official_confirmed',data:identity,provenance:{}};assert.equal(reviewedSchoolView(review,identity).status,'official_confirmed');for(const key of ['admission_year','university','campus','department','admission_type','interview_stage']){const value=reviewedSchoolView(review,{...identity,[key]:key==='admission_year'?2028:'다른 값'});assert.equal(value.status,'needs_confirmation');assert.equal(value.stale,true);assert.equal(value.declared_status,'official_confirmed');}});
test('book common candidates exclude specific majors and missing personal placeholders',()=>{const source=readFileSync('2027_면접바이블_대학별정리_v1.0.md');for(const school of extractSchoolBible(source.toString('utf8'),'hash'))for(const question of school.commonQuestions)assert.doesNotMatch(question.prompt,/○|□|내용이 나오|계약학과|[가-힣]{2,}학과|생기부|학생부/);});
test('new students get public common practice without a personal package',async()=>{state.package=null;state.targets=[];const value=await getLearningContext('new-student',{allowCommon:true,questionId:'common_one'});assert.equal(value.sourceKind,'common');assert.equal(value.ownerStudentId,'new-student');assert.equal(value.packageId,'common-bank');assert.equal(value.questionId,'common_one');assert.deepEqual(value.activities,[]);});
test('common revision never resolves to another personal content version',async()=>{state.package=null;state.queries=[];const value=await getLearningContext('new-student',{allowCommon:true,sourceType:'common',sourceVersion:1,questionId:'common_one'});assert.equal(value.sourceKind,'common');assert.ok(state.queries.some(q=>q.student==='new-student'&&q.version===undefined));assert.ok(!state.queries.some(q=>q.student&&q.version!==undefined));assert.ok(state.queries.some(q=>q.sql?.includes('common_interview_questions')&&q.args[1]===1));});
test('private features still require a published package',async()=>{state.package=null;await assert.rejects(getLearningContext('new-student'),(error:any)=>error.code==='NO_PUBLISHED_CONTENT');});
test('historical private version is retrieved only for the owning student',async()=>{state.queries=[];state.package={package:{id:'owned',active_version:2},learning:{questions:[{id:'old',prompt:'과거 질문'}]}};const value=await getLearningContext('student-A',{questionId:'old',sourceVersion:2,sourceType:'personal'});assert.equal(value.contentVersion,'2');assert.ok(state.queries.some(q=>q.student==='student-A'&&q.version===2));});
test('historical retry retains original support identity rather than mixing the new school profile',async()=>{const old={id:'owned-target',university:'원래대학교',admission_year:2027,campus:'서울',department:'환경',admission_type:'일반'};state.targets=[{id:old.id,data:{...old,admission_year:2028}}];state.package={package:{id:'owned',active_version:1},learning:{support_targets:[old],questions:[{id:'old',prompt:'과거 질문'}]}};const value=await getLearningContext('student-A',{questionId:'old',targetId:old.id,sourceVersion:1,sourceType:'personal'});assert.equal(value.target?.admission_year,2027);assert.equal(value.targetSnapshotStale,true);});
test('a target owned by another student is excluded before model context',async()=>{state.package=null;state.targets=[];await assert.rejects(getLearningContext('student-A',{allowCommon:true,targetId:'other-target'}),(error:any)=>error.code==='CONTEXT_NOT_FOUND');});
test('removed schools cannot enter a new AI context while their published source snapshot remains intact',async()=>{
  const archived={id:'removed-target',university:'이전대학교',department:'환경공학부',admission_year:2027,archived_at:'2026-10-16T01:00:00.000Z'};
  const question={id:'removed-question',prompt:'이전 학교에 지원한 이유는 무엇인가요?',support_target_ids:[archived.id]};
  state.targets=[{id:archived.id,data:archived}];state.package={package:{id:'owned',active_version:2},learning:{support_targets:[archived],questions:[question,{id:'unscoped-question',prompt:'나의 경험을 설명해 주세요.'}]}};
  const before=JSON.stringify(state.package),context=await getLearningContext('student-A',{sourceType:'personal'});
  assert.equal(context.targetId,null);assert.deepEqual(context.questions.map(question=>question.id),['unscoped-question']);
  await assert.rejects(getLearningContext('student-A',{sourceType:'personal',targetId:archived.id}),(error:any)=>error.code==='CONTEXT_NOT_FOUND');
  await assert.rejects(getLearningContext('student-A',{sourceType:'personal',questionId:question.id}),(error:any)=>error.code==='CONTEXT_NOT_FOUND');
  assert.equal(JSON.stringify(state.package),before);state.package=null;state.targets=[];
});
test('editing the school or major under the same ID cannot relabel published private questions in a current AI context',async()=>{
  const original={id:'edited-target',university:'원래대학교',department:'환경공학부',campus:'본교',admission_year:2027,admission_type:'일반전형'};
  const other={...original,id:'unchanged-target',university:'다른대학교'};
  const privateQuestion={id:'old-school-question',prompt:'원래 학교에 지원한 이유는 무엇인가요?',support_target_ids:[original.id]};
  const otherQuestion={id:'unchanged-question',prompt:'다른 학교에 지원한 이유는 무엇인가요?',support_target_ids:[other.id]};
  state.package={package:{id:'owned',active_version:2},learning:{support_targets:[original,other],questions:[privateQuestion,otherQuestion,{id:'biography',prompt:'협업 경험을 설명해 주세요.'}],activities:[{id:'real-activity',title:'나의 실제 활동'}]}};
  for(const patch of [{university:'새대학교'},{department:'건축학부'}]){
    state.targets=[{id:original.id,data:{...original,...patch}},{id:other.id,data:other}];
    const current=await getLearningContext('student-A',{targetId:original.id,sourceType:'personal'});
    assert.deepEqual(current.questions.map(question=>question.id),['biography']);assert.equal(current.activities[0].id,'real-activity');
    await assert.rejects(getLearningContext('student-A',{targetId:original.id,sourceType:'personal',questionId:privateQuestion.id}),(error:any)=>error.code==='CONTEXT_NOT_FOUND');
    const unchanged=await getLearningContext('student-A',{targetId:other.id,sourceType:'personal'});
    assert.deepEqual(unchanged.questions.map(question=>question.id),['unchanged-question','biography']);
  }
  state.package=null;state.targets=[];
});
test('full candidate pool remains eligible beyond the old first-eight cutoff',()=>{const questions=Array.from({length:20},(_,index)=>({id:`q${index}`,prompt:`질문${index}`}));const result=interviewQuestions({...context,questions},'basic');assert.equal(result.length,20);assert.equal(interviewQuestions({...context,questions},'basic','q19')[0].id,'q19');});
test('due unresolved weakness and untried questions precede recently answered questions',()=>{const now=Date.now();const result=rankInterviewCandidates([{id:'recent'},{id:'new'},{id:'due'}],{answers:[{question_id:'recent',last_at:new Date(now),count:5},{question_id:'due',last_at:new Date(now-60000),count:1}],attempts:[{question_id:'due',rating:'again',due_at:new Date(now-1000),created_at:new Date(now-30000)}]},now);assert.deepEqual(result.map(q=>q.id),['due','new','recent']);});
test('latest successful retry does not retain a historical wrong answer as current weakness',()=>{const now=Date.now();const result=rankInterviewCandidates([{id:'resolved'},{id:'new'}],{answers:[{question_id:'resolved',last_at:new Date(now),count:2}],attempts:[{question_id:'resolved',rating:'again',created_at:new Date(now-2000),due_at:new Date(now-1000)},{question_id:'resolved',rating:'good',created_at:new Date(now-500),due_at:new Date(now+86400000)}]},now);assert.equal(result[0].id,'new');});
test('distribution preserves adaptive ordering within buckets instead of sorting IDs',()=>{const candidates=[{id:'z_due',allocation_bucket:'a'},{id:'a_recent',allocation_bucket:'a'},{id:'b_new',allocation_bucket:'b'}];const result=planRootQuestions(candidates,2,{basis:'training',unit:'root_question_count',includes_followups:false,buckets:[{id:'a',weight:50},{id:'b',weight:50}]});assert.deepEqual(result.questions.map(q=>q.id),['z_due','b_new']);});
test('a requested first question consumes its bucket quota and is not appended as an extra',()=>{const candidates=[{id:'a1',allocation_bucket:'a'},{id:'a2',allocation_bucket:'a'},{id:'b1',allocation_bucket:'b'},{id:'b2',allocation_bucket:'b'}];const result=planRootQuestions(candidates,2,{basis:'training',unit:'root_question_count',includes_followups:false,buckets:[{id:'a',weight:50},{id:'b',weight:50}]},'b2');assert.deepEqual(result.questions.map(q=>q.id),['b2','a1']);assert.deepEqual(result.plan.actual,[{id:'a',count:1},{id:'b',count:1}]);});
test('ordinary multi-question practice mixes a sourced talent question with activities rather than selecting only activities',()=>{const candidates=[{id:'a1',question_types:['activity']},{id:'a2',question_types:['activity']},{id:'a3',question_types:['activity']},{id:'a4',question_types:['activity']},{id:'generic',question_types:['talent']},{id:'official',question_types:['talent'],talent_profile:{id:'official'}}];const result=planRootQuestions(candidates,4,null);assert.deepEqual(result.questions.map(q=>q.id),['a1','a2','a3','official']);assert.equal(result.plan.basis,'training');assert.equal(result.plan.talentPracticeCount,1);});
test('a common bank starting with school talent still mixes motivation and learning questions',()=>{const candidates=[{id:'talent1',question_types:['talent'],talent_profile:{id:'official'}},{id:'talent2',question_types:['talent'],talent_profile:{id:'official'}},{id:'motivation',question_types:['general']},{id:'learning',question_types:['academic']},{id:'community',question_types:['community']}];assert.deepEqual(planRootQuestions(candidates,4,null).questions.map(q=>q.id),['motivation','learning','community','talent1']);assert.deepEqual(planRootQuestions(candidates,3,null,'talent2').questions.map(q=>q.id),['talent2','motivation','learning']);assert.deepEqual(planRootQuestions(candidates,1,null,'learning').questions.map(q=>q.id),['learning']);});
test('official question distributions are not broadened with an inferred talent percentage',()=>{const candidates=[{id:'activity',allocation_bucket:'activity',question_types:['activity']},{id:'officialTalent',allocation_bucket:'talent',question_types:['talent'],talent_profile:{id:'official'}}];const result=planRootQuestions(candidates,1,{basis:'official',unit:'root_question_count',includes_followups:false,buckets:[{id:'activity',label:'활동',weight:100}]});assert.deepEqual(result.questions.map(q=>q.id),['activity']);assert.equal(result.plan.basis,'official');});
test('adaptive common recall excludes another school scope changed department and old source revisions',async()=>{
  const selected={university:'합성대학교',campus:'본교',department:'환경공학부',admission_year:2027,admission_type:'합성전형'};
  state.targets=[{id:'owned-current',data:selected}];state.common=[{...state.common[0],revision:2}];
  state.turns=[{question_id:'common_one',data:{commonRevision:2},target_snapshot:selected,last_at:new Date(1000)},
    {question_id:'common_one',data:{commonRevision:2},target_snapshot:{...selected,department:'건축학과'},last_at:new Date(2000)},
    {question_id:'common_one',data:{commonRevision:1},target_snapshot:selected,last_at:new Date(3000)}];
  state.attempts=[{memory_item_id:'old-source',rating:'again',data:{question_id:'common_one',common_revision:1,target_id:'owned-current',target_snapshot:selected}},
    {memory_item_id:'other-target',rating:'again',data:{question_id:'common_one',common_revision:2,target_id:'other-target',target_snapshot:selected}},
    {memory_item_id:'changed-department',rating:'again',data:{question_id:'common_one',common_revision:2,target_id:'owned-current',target_snapshot:{...selected,department:'건축학과'}}},
    {memory_item_id:'current',rating:'again',data:{question_id:'common_one',common_revision:2,target_id:'owned-current',target_snapshot:selected}}];
  const history=await interviewLearningHistory('student-A','owned-current');
  assert.deepEqual(history.answers,[{question_id:'common_one',count:1,last_at:new Date(1000)}]);assert.equal(history.attempts.length,1);assert.equal(history.attempts[0].question_id,'common_one');
  state.targets=[];state.turns=[];state.attempts=[];state.common=[{...state.common[0],revision:1}];
  await assert.rejects(interviewLearningHistory('student-A','foreign-target'),(error:any)=>error.status===404);
});
test('canonical campus names keep the correct current-stage recall while another interview stage remains separate',async()=>{
  const campusSchool=schoolDirectory.find(school=>school.canonicalName==='가톨릭대학교')!;
  const selected={university:campusSchool.university,school_reference_id:campusSchool.id,campus:campusSchool.campusLabel,department:campusSchool.departments[0].name,admission_year:2027,admission_type:'합성전형',interview_stage:'2단계'};
  const snapshot=schoolQuizTargetIdentity({...selected,id:'owned-campus'})!;
  state.targets=[{id:'owned-campus',data:selected}];
  state.turns=[{question_id:'common_one',data:{commonRevision:1},target_snapshot:snapshot,last_at:new Date(1000)},
    {question_id:'common_one',data:{commonRevision:1},target_snapshot:{...snapshot,interview_stage:'1단계'},last_at:new Date(2000)}];
  state.attempts=[{memory_item_id:'current-campus',rating:'again',data:{question_id:'common_one',common_revision:1,target_id:'owned-campus',target_snapshot:snapshot}},
    {memory_item_id:'other-stage',rating:'again',data:{question_id:'common_one',common_revision:1,target_id:'owned-campus',target_snapshot:{...snapshot,interview_stage:'1단계'}}}];
  const history=await interviewLearningHistory('student-A','owned-campus');
  assert.equal(history.answers[0].count,1);assert.equal(history.attempts.length,1);assert.equal(history.attempts[0].memory_item_id,'current-campus');
  state.targets=[];state.turns=[];state.attempts=[];
});
test('an owned archived school keeps its learning history without becoming a new-practice target',async()=>{
  const selected={university:'합성대학교',campus:'본교',department:'환경공학부',admission_year:2027,admission_type:'합성전형'};
  state.targets=[{id:'archived-owned',data:{...selected,archived_at:'2026-10-16T01:00:00.000Z'}}];
  state.common=[{...state.common[0],revision:2}];
  state.turns=[{question_id:'common_one',data:{commonRevision:2},target_snapshot:selected,last_at:new Date(1000)},{question_id:'common_one',data:{commonRevision:1},target_snapshot:selected,last_at:new Date(2000)}];
  state.attempts=[{memory_item_id:'saved-review',rating:'again',data:{question_id:'common_one',common_revision:2,target_id:'archived-owned',target_snapshot:selected}}];
  await assert.rejects(commonInterviewQuestions('student-A','archived-owned'),(error:any)=>error.status===404);
  const history=await interviewLearningHistory('student-A','archived-owned');
  assert.equal(history.answers.length,1);assert.equal(history.answers[0].count,1);assert.equal(history.attempts[0].memory_item_id,'saved-review');
  state.targets=[];await assert.rejects(interviewLearningHistory('student-A','archived-owned'),(error:any)=>error.status===404);
  state.turns=[];state.attempts=[];state.common=[{...state.common[0],revision:1}];
});
