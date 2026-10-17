import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import {z} from 'zod';
import {tsImport} from 'tsx/esm/api';

// Execute the real catalogue, target enrichment, route and setup effects with
// in-memory boundaries. Never touch the application DB or external services.
const directory=await tsImport('../apps/web/src/lib/school-directory.ts',import.meta.url);
const workflows=await tsImport('../packages/content-contracts/src/workflows.ts',import.meta.url);
const scopeModel=await tsImport('../apps/web/src/lib/learning-target-scope.ts',import.meta.url);
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
function compile(file,require,globals={}){
  const module={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,Date,Set,Map,URL,URLSearchParams,Response,Request,AbortController,console,require,...globals});
  return module.exports;
}
class ApiError extends Error{constructor(status,message){super(message);this.status=status;}}
const [a,b]=directory.schoolDirectory.filter(school=>school.departments.length).slice(0,2);
function target(id,school){const department=school.departments[0];return{id,data:{university:school.university,school_reference_id:school.id,campus:department.campus,department:department.name,department_catalog_id:department.id,admission_year:2027,admission_type:'검사 전형'}};}
const rows=[target('owned-a',a),target('owned-b',b)],foreign=target('foreign-target',directory.schoolDirectory[2]);
const state={user:{id:'owner',role:'student'},targets:rows,reviewed:[],queries:[]};
async function query(sql,args=[]){
  state.queries.push({sql,args});
  if(sql.includes('from support_targets')){
    const scoped=args.length>1?args[1]:args[0];
    if(scoped!=='owner')return [];
    return args.length>1?state.targets.filter(row=>row.id===args[0]):state.targets;
  }
  if(sql.includes('from school_profiles'))return args[0]==='owner'?state.reviewed:[];
  if(sql.includes('from school_reference_catalog'))return directory.schoolDirectory.filter(school=>!args.length||args[0].includes(school.id)).map(school=>({id:school.id,university:school.university,revision:2,status:'historical_reference',source:{url:'https://example.edu/source'},data:{overview:['검수한 개요']}}));
  if(sql.includes('from common_interview_questions'))return [{id:'common',revision:3,prompt:'본인의 역할은 무엇인가요?',source_type:'general_practice',data:{},source:{}}];
  throw new Error('Unexpected DB read: '+sql);
}
const learning=compile('../apps/web/src/lib/school-learning.ts',name=>{
  if(name==='server-only')return {};
  if(name==='node:crypto')return {randomUUID(){throw new Error('no writes');}};
  if(name==='zod')return {z};
  if(name==='@gakja/content-contracts')return workflows;
  if(name==='@/lib/db')return {ApiError,query,transaction(){throw new Error('no writes');}};
  if(name==='@/lib/school-directory')return directory;
  if(name==='@/lib/official-school-profiles')return {officialProfileForTarget:()=>null};
  if(name==='@/lib/school-talent-model')return {schoolTalentSummary:school=>({id:school.id}),schoolTalentForTarget:target=>({referenceId:target.school_reference_id}),talentQuestionMatchesTarget:()=>true};
  if(name==='@/lib/school-quiz'||name==='@/lib/school-onboarding-calendar'||name==='@/lib/school-onboarding-calendar-model')return {};
  throw new Error(name);
});
const route=compile('../apps/web/src/app/api/schools/route.ts',name=>{
  if(name==='@/lib/auth')return {requireUser:async()=>state.user,checkOrigin(){throw new Error('no writes');}};
  if(name==='@/lib/ai')return {requireStudent:user=>{if(user.role!=='student')throw new ApiError(403,'학생만 이용해요.');},featureError:error=>({status:error.status||500,error:error.message})};
  if(name==='@/lib/school-learning')return learning;
  throw new Error(name);
});
const get=async suffix=>{state.queries=[];const response=await route.GET(new Request('http://local/api/schools'+suffix));return{response,value:await response.json()};};
const catalogQueries=()=>state.queries.filter(item=>item.sql.includes('from school_reference_catalog'));
const full=await get('?targetId=owned-a');
check(full.response.status===200&&full.value.catalog.length===88,'default school management contract keeps all 88 schools');
check(catalogQueries().length===1,'full response builds the catalogue only once');
check(full.value.targets.length===2&&full.value.commonAvailable,'targets and common-question contract remains intact');
check(full.response.headers.get('Cache-Control')==='private, no-store','private school context is not placed in a public HTTP cache');
const compact=await get('?scope=learning&targetId=owned-a');
check(compact.response.status===200&&compact.value.catalog.length===2,'learning response returns only registered-school references');
check(catalogQueries().length===1&&catalogQueries()[0].sql.includes('id=any($1::text[])'),'learning catalogue uses a filtered database read');
check(catalogQueries()[0].args[0].length===2,'only owned target reference IDs reach the catalogue query');
check(JSON.stringify(compact.value.targets)===JSON.stringify(full.value.targets),'compact scope does not change target/profile/talent enrichment');
check(JSON.stringify(compact.value.commonQuestions)===JSON.stringify(full.value.commonQuestions),'compact scope preserves exact question IDs and revisions');
check(Buffer.byteLength(JSON.stringify(compact.value))<Buffer.byteLength(JSON.stringify(full.value))/3,'compact payload is substantially smaller than the complete catalogue');
state.targets=[...rows,{...rows[0],id:'same-school-another-track'}];await get('?scope=learning');
check(catalogQueries()[0].args[0].length===2,'multiple targets at the same school deduplicate catalogue IDs');
state.targets=[];const empty=await get('?scope=learning');
check(empty.value.catalog.length===0&&empty.value.targets.length===0&&catalogQueries().length===0,'new account does not load 88 references before school selection');
state.targets=rows;state.user={id:'another-student',role:'student'};const other=await get('?scope=learning');
check(other.value.targets.length===0&&other.value.catalog.length===0,'another account cannot receive the owner’s selected catalogue');
state.user={id:'owner',role:'student'};const forbidden=await get('?scope=learning&targetId='+foreign.id);
check(forbidden.response.status===404,'a foreign target still fails ownership validation');
state.user={id:'owner',role:'admin'};const admin=await get('?scope=learning');
check(admin.response.status===403&&state.queries.length===0,'student authorization runs before catalogue reads');
state.user={id:'owner',role:'student'};const unknown=await get('?scope=typo');
check(unknown.value.catalog.length===88,'unrecognized scope preserves the default full contract');
state.reviewed=[{target_id:rows[0].id,id:'review',revision:7,status:'official_confirmed',data:{...rows[0].data,department:'변경 전 학과'},provenance:{url:'https://example.edu/review'}}];
const stale=await get('?scope=learning');
check(stale.value.targets[0].profile.stale&&stale.value.targets[0].profile.status==='needs_confirmation','profile identity/version guards remain active under compact scope');
state.queries=[];await learning.schoolCatalog([]);check(catalogQueries().length===0,'explicit empty catalogue performs no database read');
state.queries=[];const selected=await learning.studentSchoolTargets('owner');
check(selected.length===2&&catalogQueries().length===1&&catalogQueries()[0].args[0].length===2,'standalone target lookup no longer reads the complete catalogue');

// Run actual InterviewSetup effects, including a late response after the target
// changes. The setup must neither display old common questions nor request 88 schools.
let cursor=0;const values=[],effects=[],queued=[],requests=[];
const app={data:{user:{id:'owner'},targets:rows.map(row=>({...row.data,id:row.id})),schoolProfiles:[],learning:{}},targetId:rows[0].id,setTargetId(){},openResource(){}};
const hooks={...React,useState(initial){const index=cursor++;if(!(index in values))values[index]=typeof initial==='function'?initial():initial;return[values[index],value=>{values[index]=typeof value==='function'?value(values[index]):value;}];},useEffect(effect,deps){const index=cursor++,old=effects[index];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index]))){queued.push(()=>{old?.cleanup?.();effects[index]={deps:[...deps],cleanup:effect()};});}}};
const actionButton=({pending=false,pendingLabel,disabled,children,type='button',...props})=>React.createElement('button',{...props,type,disabled:disabled||pending,'aria-busy':pending||undefined},pending?[React.createElement('span',{key:'spinner','aria-hidden':true}),pendingLabel??children]:children);
const setup=compile('../apps/web/src/components/interview-setup.tsx',name=>{
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;
  if(name==='next/link')return {__esModule:true,default:'a'};
  if(name==='next/navigation')return {useRouter:()=>({replace(){},push(){}}),useSearchParams:()=>new URLSearchParams()};
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
  if(name==='./app-shell')return {useApp:()=>app};
  if(name==='./learning-help')return {LearningHelp:()=>null};
  if(name==='./shared')return {ActionButton:actionButton,api:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),PageTitle:()=>null,Breadcrumb:()=>null,Alert:()=>null,targetName:target=>target.university};
  if(name==='@/lib/learning-target-scope')return scopeModel;
  if(name==='@/lib/interview-flow')return {hasInterviewSelection:()=>false,interviewPreviewHref:(_params,targetId)=>'/preview?targetId='+targetId,interviewSetupState:()=>({panelistCount:1,mode:'basic',count:1,timing:'end'}),interviewSetupHref:()=>'/interview/chat',sourceVersionInput:()=>undefined};
  throw new Error(name);
});
function render(){cursor=0;const tree=setup.InterviewSetup({kind:'chat'});queued.splice(0).forEach(effect=>effect());return tree;}
function text(tree){if(Array.isArray(tree))return tree.map(text).join(' ');if(tree&&typeof tree==='object')return text(tree.props?.children);return tree==null?'':String(tree);}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
render();
check(requests[0].url==='/api/schools?scope=learning&targetId='+rows[0].id,'setup loads compact questions for its actual selected target');
const oldRequest=requests[0];app.targetId=rows[1].id;render();
check(oldRequest.options.signal.aborted,'changing school aborts the old setup subscriber');
oldRequest.resolve({commonQuestions:[{id:'old',prompt:'늦게 도착한 이전 학교 질문'}]});await flush();
check(!text(render()).includes('늦게 도착한 이전 학교 질문'),'a late old-school response never enters the new-school setup');
const nextRequest=requests.find(request=>request.url.includes('/api/schools')&&request.url.includes(rows[1].id));
nextRequest.resolve({targets:[{id:rows[1].id,profile:{status:'official_confirmed',format:'document_individual',admission_year:2027,admission_type:'공식 전형',interview_stage:'2단계',interviewer_count:{min:2,max:2},source:{source_url:'https://example.edu/official'}}}],commonQuestions:[{id:'current',prompt:'현재 학교 질문'}]});await flush();
const current=render();
check(text(current).includes('현재 학교 질문')&&!text(current).includes('늦게 도착한 이전 학교 질문'),'new target questions render without data from the prior target');
check(text(current).includes('공식 전형')&&text(current).includes('2단계'),'flat enriched official profiles appear in setup school guidance');
const collect=tree=>Array.isArray(tree)?tree.flatMap(collect):tree&&typeof tree==='object'?[tree,...collect(tree.props?.children)]:[];
check(collect(current).some(node=>node.props?.href==='https://example.edu/official'),'official source link survives flat-profile fallback');
const before=requests.length;app.data.targets=app.data.targets.map(target=>target.id===app.targetId?{...target,department:'변경 학과'}:target);render();
check(requests.length===before+1,'changing department under the same target ID reloads the school context');
effects.forEach(effect=>effect?.cleanup?.());
console.log(`School payload scope passed: ${checks} checks; full88 compatibility, one catalogue query, compact ownership/filtering, identity guards and actual setup effects.`);
