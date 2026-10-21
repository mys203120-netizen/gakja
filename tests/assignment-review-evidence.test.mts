import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as evidence from '../apps/web/src/lib/training-review-evidence';
import * as targetScope from '../apps/web/src/lib/learning-target-scope';
import {applyReviewReflection,reconcileTrainingReviews,type ReviewQuestion} from '../apps/web/src/lib/training-review';

const target={id:'school-a',university:'시험대학교',admission_year:2027,campus:'본교',department:'환경공학부',admission_type:'학생부종합',interview_stage:'2단계'};
const question={id:'q1',sourceType:'personal' as const,sourceVersion:2};
const item={id:'memory-1',question_id:'q1',practice_question_id:'q1',practice_kind:'concept',prompt:'검수한 개념',kind:'choice',verification_status:'approved',evaluation_method:'reviewed_correct_answer',category:'concept',activity_ids:[],source_ref_ids:[],memory_keywords:[],required_meaning_elements:[],options:['a','b','c','d'].map(id=>({id,text:id})),correct_option_id:'b'};
const sourceId='31554dbb-703f-4c1b-b0ce-49ac9b24bc2a',assignmentId='af048628-5976-46a7-bf31-7eb5152cf95c',memoryId='520d28d0-6fd0-4a6b-81f7-e859e9de57cb';
const row=(extra:any={})=>({id:sourceId,assignment_id:assignmentId,student_id:'student-a',assignment_student_id:'student-a',memory_item_id:item.id,item,assignment_state:'completed',content_version:2,source_kind:'personal',target_id:target.id,target_snapshot:target,submitted_at:'2026-10-21T02:00:00Z',response:{memoryItemId:item.id,question_id:'q1',response:'b',selectedOptionId:'b',rating:'easy',assistance_recorded:true,assisted:false},result:{correct:true,evaluation_method:'reviewed_correct_answer'},help_events:[],...extra});
const event=(kind='assignment_submission',source=sourceId)=>({id:'event-'+source,kind,source_id:source,data:{outcome:true,assisted:false},created_at:'2026-10-21T02:00:00Z'});
const attempts=(source=evidence.assignmentReviewSource(row()),events=[event()])=>evidence.reviewQuestionAttempts(question,target,events,[source]);
const reviewQuestion=(source?:ReturnType<typeof evidence.assignmentReviewSource>):ReviewQuestion=>({...question,targetId:target.id,targetKey:'frozen-school',activityIds:[],category:'major',attempts:source?attempts(source):[]});
const diagnostic={sessionId:'diagnostic',reviewSchemaVersion:1,targetKey:'frozen-school',targetSnapshot:target,sourceType:'personal',sourceVersion:2};
const initial=()=>applyReviewReflection({questions:[reviewQuestion()],targetId:target.id,diagnostic,needsReviewQuestionIds:['q1'],focusCategories:[],now:'2026-10-21T01:00:00Z'});
const reconcile=(source:ReturnType<typeof evidence.assignmentReviewSource>|undefined,state=initial())=>reconcileTrainingReviews({state,questions:[reviewQuestion(source)],diagnostics:{[target.id]:diagnostic},now:'2026-10-21T03:00:00Z'});

test('assignment success requires the frozen reviewed answer and original result to agree; the receipt keeps its own kind',()=>{
 const source=evidence.assignmentReviewSource(row()),attempt=attempts(source)[0];
 assert.equal(attempt.id,'assignment_submission:'+sourceId);assert.equal(attempt.kind,'assignment_submission');assert.equal(attempt.valid,true);assert.equal(attempt.outcome,true);assert.equal(attempt.assistanceKnown,true);assert.equal(attempt.assisted,false);
 for(const changed of [row({response:{...row().response,selectedOptionId:'a'}}),row({result:{correct:false,evaluation_method:'reviewed_correct_answer'}})])assert.equal(attempts(evidence.assignmentReviewSource(changed))[0].outcome,false);
 for(const changed of [row({item:{...item,verification_status:'needs_confirmation'}}),row({result:{correct:true,evaluation_method:'self_check'}}),row({item:{...item,kind:'short_speech',evaluation_method:'self_check',category:'experiential'},response:{...row().response,response:'혼자 설명했어요.'}})]){
  const source=evidence.assignmentReviewSource(changed);assert.equal(attempts(source)[0].outcome,undefined);assert.equal(reconcile(source).questions[0].status,'active');
 }
});

test('wrong ownership, non-submitted state, missing frozen item and invalid original responses cannot certify completion',()=>{
 for(const changed of [row({assignment_student_id:'another-student'}),row({assignment_state:'in_progress'}),row({item:{...item,id:'another-item'}}),row({response:{...row().response,response:'',selectedOptionId:'unlisted'}}),row({response:{...row().response,question_id:'another-question'}}),row({response:{...row().response,source_kind:'common'}}),row({response:{...row().response,content_version:3}})]){
  const source=evidence.assignmentReviewSource(changed);assert.equal(attempts(source)[0].valid,false);assert.equal(reconcile(source).questions[0].status,'active');
 }
 for(const changed of [row({content_version:3}),row({target_snapshot:{...target,department:'다른 학과'}}),row({target_id:'other-school'})])assert.equal(attempts(evidence.assignmentReviewSource(changed)).length,0);
 const common=evidence.assignmentReviewSource(row({source_kind:'common',item:{...item,common_revision:5},response:{...row().response,source_kind:'common',common_revision:5}}));
 assert.equal(evidence.reviewQuestionAttempts({...question,sourceType:'common',sourceVersion:5},target,[event()],[common]).length,1);
 assert.equal(evidence.reviewQuestionAttempts({...question,sourceType:'common',sourceVersion:6},target,[event()],[common]).length,0);
});

test('changing either invalidation flag, original help, live help receipt, or reviewed correctness reactivates the resolved request',()=>{
 const resolved=reconcile(evidence.assignmentReviewSource(row()));assert.equal(resolved.questions[0].status,'resolved');
 for(const changed of [row({response:{...row().response,invalidated:true}}),row({result:{...row().result,invalidated:true}}),row({response:{...row().response,assisted:true}}),row({help_events:[{kind:'help',help_kind:'ai'}]}),row({response:{...row().response,selectedOptionId:'a'}}),row({item:{...item,verification_status:'needs_confirmation'}})]){
  const active=reconcile(evidence.assignmentReviewSource(changed),resolved.state);assert.equal(active.questions[0].status,'active');assert.deepEqual(active.state.requests.find(request=>request.origin==='student')?.resolvedEvidenceIds,[]);
 }
 assert.equal(reconcile(undefined,resolved.state).questions[0].status,'active');
 const legacy=evidence.assignmentReviewSource(row({response:{...row().response,assistance_recorded:undefined}}));assert.equal(attempts(legacy)[0].assistanceKnown,false);assert.equal(reconcile(legacy).questions[0].status,'active');
});

test('duplicates and memory discovery aliases retain a single canonical assignment receipt',()=>{
 const source={...evidence.assignmentReviewSource(row()),discoveryIds:['memory_review:'+memoryId]};
 const actual=evidence.reviewQuestionAttempts(question,target,[event(),event(),event('memory_review',memoryId)],[source,source]);assert.equal(actual.length,1);assert.equal(actual[0].id,'assignment_submission:'+sourceId);
 const memoryOnly=attempts(source,[event('memory_review',memoryId)]);assert.equal(memoryOnly.length,1);assert.equal(memoryOnly[0].id,actual[0].id);
});

test('screen events use current submission validity, frozen scope, assistance and correctness instead of old event snapshots',()=>{
 const stale={...event(),created_at:'2026-10-22T10:00:00Z',data:{response:'for counts',questionId:'wrong-question',targetId:'wrong-school',targetSnapshot:{...target,department:'다른 학과'},sourceType:'common',contentVersion:99,commonRevision:42,outcome:true,assisted:true,hintUsed:true,hint_used:true,aiAssisted:true,ai_assisted:true,helpKinds:['ai'],helpEvents:[{kind:'help'}],recordingId:'old-audio'}};
 const source=evidence.assignmentReviewSource(row()),valid=evidence.sourceValidateTrainingEvents([stale],[source]);
 assert.equal(valid.length,1);assert.equal(valid[0].kind,'assignment_submission');assert.equal(valid[0].source_id,sourceId);assert.equal(valid[0].created_at,'2026-10-21T02:00:00.000Z');
 const data=valid[0].data;assert.equal(data.questionId,'q1');assert.equal(data.targetId,target.id);assert.deepEqual(data.targetSnapshot,target);assert.equal(data.contentVersion,2);assert.equal(data.commonRevision,undefined);assert.equal(data.sourceVersion,2);
 assert.equal(data.assisted,false);assert.equal(data.hintUsed,false);assert.equal(data.aiAssisted,false);assert.deepEqual(data.helpKinds,[]);assert.deepEqual(data.helpEvents,[]);assert.equal(data.recordingId,undefined);assert.equal(data.outcome,true);assert.equal(data.response,'for counts');
 const helped=evidence.sourceValidateTrainingEvents([event()],[evidence.assignmentReviewSource(row({response:{...row().response,assisted:true,selectedOptionId:'a'}}))])[0];assert.equal(helped.data.assisted,true);assert.equal(helped.data.outcome,false);
 for(const changed of [row({response:{...row().response,invalidated:true}}),row({result:{...row().result,invalidated:true}}),row({assignment_state:'assigned'})])assert.deepEqual(evidence.sourceValidateTrainingEvents([stale],[evidence.assignmentReviewSource(changed)]),[]);
 assert.deepEqual(evidence.sourceValidateTrainingEvents([stale],[]),[]);
});

test('screen events canonicalize mirrored receipts and preserve unrelated event kinds without rewriting them',()=>{
 const source={...evidence.assignmentReviewSource(row()),discoveryIds:['memory_review:'+memoryId]},other={kind:'knowledge_progress',source_id:'article',data:{progress:3}},interview={kind:'interview_answer',source_id:'turn',data:{answer:'면접 답변'}};
 const valid=evidence.sourceValidateTrainingEvents([event('memory_review',memoryId),event(),event(),other,interview],[source]);
 assert.equal(valid.length,3);assert.equal(valid[0].kind,'assignment_submission');assert.equal(valid[0].source_id,sourceId);assert.equal(valid[1],other);assert.equal(valid[2],interview);
 const voice=evidence.sourceValidateTrainingEvents([event()],[{...source,inputMode:'voice'}])[0];assert.equal(voice.data.inputMode,'voice');assert.equal(voice.data.recordingId,undefined,'counts need no invented playable recording identifier');
});

test('saving another diagnostic reflection preserves an unresolved daily review request in the same question scope',()=>{
 const state=initial(),request=state.requests.find(request=>request.origin==='student')!;request.diagnosticKey='daily:lesson-1';
 const changed=applyReviewReflection({state,questions:[reviewQuestion()],targetId:target.id,diagnostic:{...diagnostic,sessionId:'another-diagnosis'},needsReviewQuestionIds:[],focusCategories:[],now:'2026-10-21T03:00:00Z'});
 assert.equal(changed.requests.find(saved=>saved.id===request.id)?.status,'active');
});

test('source loader filters both owners, loads frozen assignment items and canonicalizes mirrored memory rows',async()=>{
 const code=ts.transpileModule(readFileSync('apps/web/src/lib/training-review-evidence-store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,module={exports:{} as any};
 const queries:any[]=[],context:any={events:[event(),event('memory_review',memoryId)],sources:[],schoolTargets:[{id:target.id,data:target}]};
 vm.runInNewContext(code,{module,exports:module.exports,require(name:string){
  if(name==='server-only')return {};if(name==='./training-review-evidence')return evidence;if(name==='./learning-target-scope')return targetScope;
  if(name==='./db')return {query(){throw Error('All source reads must use the supplied connection');}};
  if(name==='./automatic-practice-store')return {automaticQuestionTargets:()=>new Map([['q1',{...question,title:'검수 질문',activityIds:[]}]])};
  if(name==='./planner-model')return {planTargetHref:()=>'/interview/new'};if(name==='./knowledge-flow-model')return {knowledgeTargetKey:()=> 'frozen-school'};
  throw Error(name);
 }});
 const db={async query(sql:string,params:any[]){queries.push({sql,params});if(sql.includes('from memory_attempts'))return {rows:[{id:memoryId,memory_item_id:item.id,data:{assignment_id:assignmentId,answer:'edited success-looking copy',assistance_recorded:true,content_version:2},created_at:'2026-10-21T02:00:00Z'}]};
  assert.ok(sql.includes('a.student_id=r.student_id')&&sql.includes('where r.student_id=$1'));assert.ok(sql.includes("item->>'id'=r.memory_item_id"));assert.equal(params[0],'student-a');return {rows:[row()]};}};
 const result=await module.exports.loadReviewQuestionFacts('student-a',context,db);assert.equal(result.questions[0].attempts.length,1);assert.equal(result.questions[0].attempts[0].id,'assignment_submission:'+sourceId);assert.equal(result.events.length,1);assert.equal(result.events[0].kind,'assignment_submission');
 assert.ok(queries.some(query=>query.sql.includes('r.assignment_id=any($2::uuid[])')));
 context.events=[event('memory_review',memoryId)];const onlyMirror=await module.exports.loadReviewQuestionFacts('student-a',context,db);assert.equal(onlyMirror.questions[0].attempts.length,1);
});
