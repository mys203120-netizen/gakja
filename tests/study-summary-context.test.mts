// node --import tsx tests/study-summary-context.test.mts
// Pure fixtures: the database dependency is replaced with a throwing stub.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const marker=new URL('../node_modules/next/dist/compiled/server-only/empty.js',import.meta.url).href;
const fixtureDb=new URL('./fixtures/study-summary-db.cjs',import.meta.url).href;
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='server-only')return {url:marker,shortCircuit:true};
  if(specifier==='./db'&&context.parentURL?.endsWith('/study-sessions.ts'))return {url:fixtureDb,shortCircuit:true};
  return nextResolve(specifier,context);
}});
const {studySummary}=await import('../apps/web/src/lib/study-sessions.ts');
let checks=0;
const check=(value:unknown,label:string)=>{assert.ok(value,label);checks++;};
const school={university:'국민대학교',school_reference_id:'kookmin',department:'건설시스템공학부',campus:'서울',admission_year:2027,admission_type:'학생부종합',interview_stage:'1단계'};
const context={targetId:'owned-kookmin',targetSnapshot:school,sourceType:'book_reference',commonRevision:3,contentVersion:6};
const event=(outcome:boolean|null,at:number,extra:Record<string,unknown>={})=>({id:'event-'+at,kind:'quiz_response',source_id:'response-'+at,created_at:new Date(at*1000).toISOString(),data:{memoryItemId:'legacy-shared-memory',questionId:'shared-question',practiceKind:'personal',prompt:'지원 동기를 말해 주세요.',mode:'choice',outcome,assistance_recorded:true,...context,...extra}});
const wrong=event(false,1);
const otherSchool={targetId:'owned-pusan',targetSnapshot:{...school,university:'부산대학교',school_reference_id:'pusan',department:'체육교육과',campus:'부산'}};
let summary=studySummary([wrong,event(true,2,otherSchool)]);
check(summary.weakPoints.length===1&&summary.resolvedPoints.length===0,'another school cannot resolve a weakness sharing legacy memory and question IDs');
check(summary.weakPoints[0].targetId==='owned-kookmin'&&summary.independentlyVerified.count===1,'each result keeps its own saved school rather than the first row metadata');
summary=studySummary([wrong,event(false,2,otherSchool)]);
check(summary.weakPoints.length===2&&summary.weakPoints.every(point=>point.wrong===1),'failures for two schools stay separate without count inflation');
check(new Set(summary.weakPoints.map(point=>point.targetId)).size===2,'both school identities survive summary grouping');
summary=studySummary([wrong,event(true,2,{commonRevision:4})]);
check(summary.weakPoints.length===1&&summary.resolvedPoints.length===0,'another reviewed common revision cannot resolve an older weakness');
summary=studySummary([wrong,event(true,2,{contentVersion:20})]);
check(summary.weakPoints.length===0&&summary.resolvedPoints.length===1,'same common revision connects across unrelated personal guidebook publication changes');
const personalWrong=event(false,1,{sourceType:'personal',commonRevision:null});
summary=studySummary([personalWrong,event(true,2,{sourceType:'personal',commonRevision:null,contentVersion:7})]);
check(summary.weakPoints.length===1&&summary.resolvedPoints.length===0,'different personal publications never clear one another');
summary=studySummary([personalWrong,event(true,2,{sourceType:'personal',commonRevision:null})]);
check(summary.weakPoints.length===0&&summary.resolvedPoints.length===1,'same owned personal publication still resolves a verified independent answer');
for(const unknown of [{targetId:undefined,targetSnapshot:undefined},{commonRevision:undefined},{sourceType:'personal',commonRevision:null},{targetSnapshot:null}]){
  summary=studySummary([wrong,event(true,2,unknown)]);
  check(summary.weakPoints.length===1&&summary.resolvedPoints.length===0,'missing source or school metadata stays unknown instead of adopting known context');
}
for(const changed of [{department:'다른 학과'},{campus:'다른 캠퍼스'},{admission_year:2028},{admission_type:'다른 전형'},{interview_stage:'2단계'}]){
  summary=studySummary([wrong,event(true,2,{targetSnapshot:{...school,...changed}})]);
  check(summary.weakPoints.length===1&&summary.resolvedPoints.length===0,'reused target ID with changed admission context cannot erase the old weakness');
}
summary=studySummary([wrong,event(true,2,{targetId:undefined,target_id:context.targetId,targetSnapshot:undefined,target_snapshot:school,sourceType:undefined,source_type:'book_reference',commonRevision:undefined,common_revision:'3'})]);
check(summary.weakPoints.length===0&&summary.resolvedPoints.length===1,'persisted snake-case metadata and numeric revision aliases join their exact source');
const unknownStage=event(false,1,{targetSnapshot:{...school,interview_stage:null}});
summary=studySummary([unknownStage,event(true,2)]);
check(summary.weakPoints.length===0&&summary.resolvedPoints.length===1,'one unambiguous saved interview stage can resolve an omitted legacy stage');
summary=studySummary([unknownStage,event(true,2),event(true,3,{targetSnapshot:{...school,interview_stage:'2단계'}})]);
check(summary.weakPoints.length===1&&summary.resolvedPoints.length===0,'unknown stage cannot bridge two known interview stages');
summary=studySummary([wrong,{...wrong},event(true,2),event(true,2)]);
check(summary.resolvedPoints.length===1&&summary.resolvedPoints[0].wrong===1&&summary.independentlyVerified.count===1,'repeated source event cannot inflate weakness or independent verification counts');
summary=studySummary([wrong,event(true,2,{hintUsed:true}),event(true,3,{assisted:true})]);
check(summary.weakPoints.length===1&&summary.independentlyVerified.count===0,'hinted and assisted success cannot resolve weakness');
const applied={...event(null,2),kind:'interview_answer',data:{questionId:'shared-question',answer:'실제 적용 답변',...context}};
summary=studySummary([wrong,applied]);
check(summary.weakPoints.length===1&&summary.independentlyVerified.count===0&&summary.interviews.answered===1,'interview application stays recorded without becoming objective mastery');
const rows=[wrong,event(true,2),event(false,3,otherSchool)],before=JSON.stringify(rows);
studySummary(rows);
check(JSON.stringify(rows)===before,'summary leaves immutable saved event metadata untouched');
console.log(`PASS ${checks} study-summary context checks (owned school/source revisions, conservative legacy scope, independent resolution, duplicate source counts; database and external calls 0).`);
