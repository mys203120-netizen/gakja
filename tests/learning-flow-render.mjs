import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import React from 'react';
import * as runtime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as icons from 'lucide-react';
import {tsImport} from 'tsx/esm/api';
const targetScope=await tsImport('../apps/web/src/lib/learning-target-scope.ts',import.meta.url);
const workflow=await tsImport('../packages/content-contracts/src/workflows.ts',import.meta.url);

const modules=new Map();
function load(relative,mocks={}) {
 const url=new URL(relative,import.meta.url),key=url.href;
 if(modules.has(key)&&!Object.keys(mocks).length)return modules.get(key);
 const module={exports:{}};
 const output=ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(output,{module,exports:module.exports,URLSearchParams,Intl,Date,Set,Map,console,require(name){
  if(name in mocks)return mocks[name];
  if(name==='react/jsx-runtime')return runtime;
  if(name==='lucide-react')return icons;
  if(name==='react')return React;
  if(name==='@/lib/learning-target-scope'||name==='./learning-target-scope')return targetScope;
  if(name==='@gakja/content-contracts/workflows')return workflow;
  // Follow real library dependencies relative to their importer. Components keep
  // their explicit UI/network adapters, while new pure helper imports need no stubs.
  const libraryRoot=new URL('../apps/web/src/lib/',import.meta.url);
  const dependency=name.startsWith('@/lib/')?new URL(name.slice('@/lib/'.length),libraryRoot):name.startsWith('.')&&url.href.startsWith(libraryRoot.href)?new URL(name,url):null;
  if(dependency?.href.startsWith(libraryRoot.href)){
   for(const suffix of ['', '.ts', '.tsx']){
    const candidate=new URL(dependency.href+suffix);
    if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return load(candidate);
   }
  }
  throw new Error(name);
 }});
 if(!Object.keys(mocks).length)modules.set(key,module.exports);return module.exports;
}
const link=({href,children,...props})=>React.createElement('a',{href,...props},children);
const primitive=({children,...props})=>React.createElement('div',props,children);
const target={id:'target',university:'서울시립대학교',department:'환경공학부',admission_year:2027,campus:'본교',admission_type:'학생부종합Ⅰ'};
const originalQuestion={id:'q1',prompt:'원래 교재의 본인 역할은 무엇인가요?',activity_ids:['a1'],source_ref_ids:['s1'],support_target_ids:['target']};
const originalActivity={id:'a1',title:'원래 활동',activity_summary:'제 담당은 측정이었습니다.',source_ref_ids:['s1'],fact_confirmation:'confirmed_from_record'};
const current={...originalQuestion,prompt:'새 교재로 바뀐 질문'};
const bootstrap={user:{id:'student',name:'하린'},targets:[target],package:{active_version:7},learning:{questions:[current],activities:[{...originalActivity,title:'새 교재 활동'}],memory_items:[],source_refs:[]},interviews:[]};
const revision={id:'r1',question_id:'q1',script:'제 담당은 원래 기록의 측정이었습니다.',target_id:'target',content_version:6,revision_kind:'interview_answer',created_at:'2026-10-14T06:00:00Z',assistance_recorded:false};
const styles=new Proxy({},{get:(_,name)=>String(name)});
const actionButton=({pending=false,pendingLabel,disabled,children,type='button',...props})=>React.createElement('button',{...props,type,disabled:disabled||pending,'aria-busy':pending||undefined},pending?[React.createElement(icons.LoaderCircle,{key:'spinner',size:16,'aria-hidden':true}),pendingLabel??children]:children);
const shared={ActionButton:actionButton,api:()=>{throw new Error('render must not fetch');},post:()=>{throw new Error('render must not write');},Alert:primitive,Breadcrumb:()=>null,Spinner:()=>null,Empty:({title})=>React.createElement('p',null,title),PageTitle:({title})=>React.createElement('h1',null,title),dateLabel:()=> '10월 14일',targetName:t=>t?.university||'지원처 미등록',LinkedRow:({href,title})=>React.createElement(link,{href},title)};
function hooks(values){let at=0;return {...React,useEffect(){},useState(initial){return [at<values.length?values[at++]:(typeof initial==='function'?initial():initial),()=>{}];}};}
const mocks={
 'next/link':{default:link},'./app-shell':{useApp:()=>({data:bootstrap,target,targetId:target.id,toast(){}})},'./shared':shared,
 './learning-flow-ui.module.css':{default:styles},
 '@/lib/planner-model':{koreaToday:()=> '2026-10-14',shiftPlanDay:()=> '2026-10-17'},
 'next/navigation':{useRouter:()=>({push(){},replace(){}}),useSearchParams:()=>new URLSearchParams({questionId:'q1',targetId:'target',sourceType:'personal',sourceVersion:'6'})},
 './learning-help':{LearningHelp:({sourceVersion})=>React.createElement('span',null,'source:'+sourceVersion)},'./study-session-provider':{finishStudySession:()=>{throw new Error('render must not submit');}}
};
const content={quiz:{contentVersion:6,target,library:{answer:[{id:'m1',question_id:'q1',activity_ids:['a1']}]},recommendation:{items:[]}},learning:{answerRevisions:[revision],confirmations:[]},schools:{commonQuestions:[]},knowledge:{videos:[]},evidence:{learning:{questions:[originalQuestion],activities:[originalActivity],source_refs:[{id:'s1',area:'화학Ⅱ',quote:'원래 기록의 실제 근거'}]},documents:[]}};
const today=load('../apps/web/src/components/today-learning.tsx',{...mocks,react:hooks([content,'','',false,'2026-10-17'])}).TodayLearning;
const view=renderToStaticMarkup(React.createElement(today));
assert.ok(view.includes(originalQuestion.prompt)&&view.includes('원래 기록의 실제 근거'));
assert.ok(!view.includes('새 교재로 바뀐 질문')&&!view.includes('새 교재 활동'));
assert.ok(view.includes('sourceType=personal')&&view.includes('sourceVersion=6'));
assert.ok(view.includes('도움 여부 미기록')&&!view.includes('독립 수행 완료'));
assert.ok(view.includes('필요한 곳부터 이어가는 학습')&&view.includes('Chat으로 답하기')&&view.includes('Live로 말하기'));
assert.ok(view.includes('자료 덮고 떠올리기'));
assert.equal((view.match(/class="button primary"/g)||[]).length,1,'one primary next action leads the current question');
assert.ok(view.includes('aria-label="현재 학습 단계"')&&view.includes('aria-current="step"'));
assert.ok(view.includes('<details class="otherWays"><summary>다른 단계·연습 방식</summary>'),'alternate paths remain available in a closed disclosure');
assert.ok(view.includes('<details class="helpDisclosure"><summary>근거·힌트 도움</summary>'),'help does not compete with the next learning action');
const unavailable=load('../apps/web/src/components/today-learning.tsx',{...mocks,react:hooks([{...content,evidence:null},'자료 조회 실패','',false,'2026-10-17'])}).TodayLearning;
const fallback=renderToStaticMarkup(React.createElement(unavailable));
assert.ok(fallback.includes('저장 당시 자료를 확인하지 못했어요.'));
assert.ok(!fallback.includes(current.prompt));
// The same question must advance through actual saved answers, not remain on the
// recall button merely because a quiz item exists. Neither editing nor assistance
// history constitutes an independently recalled answer or an ability score.
function renderTodayFlow(answerRevisions,options={}) {
 const params={questionId:'q1',targetId:'target',sourceType:'personal',sourceVersion:'6',...options.params};
 const fixture={...content,...options.content,learning:{answerRevisions,confirmations:[]}};
 const app={...bootstrap,...options.bootstrap};
 const component=load('../apps/web/src/components/today-learning.tsx',{...mocks,
  './app-shell':{useApp:()=>({data:app,target,targetId:target.id,toast(){}})},
  'next/navigation':{useRouter:()=>({push(){},replace(){}}),useSearchParams:()=>new URLSearchParams(params)},
  react:hooks([fixture,'','',false,'2026-10-17',options.reviewedQuestion||''])}).TodayLearning;
 return renderToStaticMarkup(React.createElement(component));
}
function nextAction(markup) {
 const [,href,label]=markup.match(/<a href="([^"]+)" class="button primary">([^<]+)/)||[];
 assert.ok(href&&label,'the current question has one concrete next action');
 const step=markup.match(/<li aria-current="step"><span>\d+<\/span>([^<]+)/)?.[1];
 return {url:new URL(href.replaceAll('&amp;','&'),'http://test.local'),label,step};
}
const recall={...revision,id:'recall',revision_kind:'quiz_answer',target_snapshot:target,assistance_recorded:true};
const applied={...recall,id:'applied',revision_kind:'interview_answer',created_at:'2026-10-14T06:05:00Z'};
let flow=nextAction(renderTodayFlow([]));
assert.equal(flow.url.hash,'#today-record');assert.equal(flow.step,'기록에서 찾기');
flow=nextAction(renderTodayFlow([],{reviewedQuestion:'q1:target:personal:6'}));
assert.equal(flow.url.pathname,'/quiz');assert.equal(flow.step,'자료 덮고 떠올리기');
flow=nextAction(renderTodayFlow([recall]));
assert.equal(flow.url.pathname,'/interview/chat');assert.equal(flow.step,'내 말로 답하기');
assert.equal(flow.url.searchParams.get('questionId'),'q1');assert.equal(flow.url.searchParams.get('targetId'),'target');
assert.equal(flow.url.searchParams.get('sourceType'),'personal');assert.equal(flow.url.searchParams.get('sourceVersion'),'6');
for(const row of [{...recall,assisted:true},{...recall,hint_used:true},{...recall,ai_assisted:true},{...recall,assistance_recorded:false},{...recall,answer_attempt_kind:'content_edit'}]){
 const markup=renderTodayFlow([row]);flow=nextAction(markup);
 assert.equal(flow.url.pathname,'/quiz');assert.equal(flow.step,'자료 덮고 떠올리기');
 assert.ok(!markup.includes('독립 수행 완료')&&!markup.includes('숙달 완료'));
}
flow=nextAction(renderTodayFlow([recall,{...recall,id:'latest-helped',assisted:true,created_at:'2026-10-14T06:03:00Z'}]));
assert.equal(flow.url.pathname,'/quiz','an older unaided answer does not erase help used on the new attempt');
for(const revision_kind of ['answer_edit','transcript_correction']){
 flow=nextAction(renderTodayFlow([{...recall,revision_kind}]));
 assert.equal(flow.url.hash,'#today-record','editing one saved answer never completes the recall stage');
}
flow=nextAction(renderTodayFlow([recall,applied]));
assert.equal(flow.url.pathname,'/records/comparisons');assert.equal(flow.step,'보완하고 다시');
assert.equal(flow.url.searchParams.get('sourceVersion'),'6');assert.match(flow.label,/비교/);
flow=nextAction(renderTodayFlow([{...applied,assisted:true}]));
assert.equal(flow.url.pathname,'/records/comparisons','a saved assisted interview still gets feedback without claiming mastery');
assert.equal(flow.label,'답변과 피드백 확인');
flow=nextAction(renderTodayFlow([applied,{...recall,id:'new-recall',created_at:'2026-10-14T06:10:00Z'}]));
assert.equal(flow.url.pathname,'/interview/chat','a newer independent recall opens a fresh application attempt');
for(const row of [{...recall,content_version:7},{...applied,target_snapshot:{...target,department:'다른학과'}}]){
 flow=nextAction(renderTodayFlow([row]));assert.equal(flow.url.hash,'#today-record');
}
flow=nextAction(renderTodayFlow([revision]));
assert.equal(flow.url.pathname,'/quiz','owned legacy history remains readable but missing context cannot complete today’s interview');
const schoolQuestion={...originalQuestion,common_revision:3,source_type:'verified_past'};
const schoolContent={quiz:{...content.quiz,contentVersion:7},schools:{commonQuestions:[schoolQuestion]},evidence:{...content.evidence,learning:{...content.evidence.learning,questions:[schoolQuestion]}}};
flow=nextAction(renderTodayFlow([{...applied,common_revision:3,source_type:'common',content_version:6}],{params:{sourceType:'common',sourceVersion:'3'},content:schoolContent}));
assert.equal(flow.url.pathname,'/records/comparisons');assert.equal(flow.url.searchParams.get('sourceType'),'common');assert.equal(flow.url.searchParams.get('sourceVersion'),'3');
flow=nextAction(renderTodayFlow([{...applied,common_revision:2,source_type:'common'}],{params:{sourceType:'common',sourceVersion:'3'},content:schoolContent}));
assert.equal(flow.url.hash,'#today-record','a previous school question revision cannot finish the reviewed revision');
const concept={id:'mconcept',question_id:'concept:mconcept',activity_ids:['a1'],practice_prompt:'분리 원리를 설명해 보세요.'};
const conceptContent={quiz:{...content.quiz,library:{answer:[concept]}},evidence:content.evidence};
const conceptRecall={...recall,question_id:'concept:mconcept',practice_kind:'concept'};
flow=nextAction(renderTodayFlow([conceptRecall,applied],{params:{questionId:'concept:mconcept',memoryItemId:'mconcept'},content:conceptContent,bootstrap:{learning:{...bootstrap.learning,memory_items:[{...concept,question_id:'concept:mconcept'}]}}}));
assert.equal(flow.url.pathname,'/records/comparisons');assert.equal(flow.url.searchParams.get('questionId'),'q1','after concept application, feedback opens the actual interview question');
console.log('Today stage React render: record → recall → interview → comparison, new recall cycle, assistance/missing context/edit guards, personal/common revisions, and concept application passed.');
async function submitReviewPlan(options={}) {
 let submit;const created=[];
 const capture=(method)=>(type,props,key)=>{
  if(type==='form'&&props.className==='reviewPlan')submit=props.onSubmit;
  return runtime[method](type,props,key);
 };
 const params={questionId:'q1',targetId:'target',sourceType:'personal',sourceVersion:'6',...options.params};
 const fixture={...content,...options.content,learning:{answerRevisions:[],confirmations:[]}};
 const app={...bootstrap,...options.bootstrap};
 const component=load('../apps/web/src/components/today-learning.tsx',{...mocks,
  'react/jsx-runtime':{...runtime,jsx:capture('jsx'),jsxs:capture('jsxs')},
  './app-shell':{useApp:()=>({data:app,target,targetId:target.id,toast(){}})},
  './shared':{...shared,api:async path=>{assert.equal(path,'/api/planner');return {plans:options.existing||[]};},post:async(path,payload)=>{assert.equal(path,'/api/planner');created.push(JSON.parse(JSON.stringify(payload)));return {}; }},
  'next/navigation':{useRouter:()=>({push(){},replace(){}}),useSearchParams:()=>new URLSearchParams(params)},
  react:hooks([fixture,'','',true,'2026-10-17',''])}).TodayLearning;
 renderToStaticMarkup(React.createElement(component));assert.equal(typeof submit,'function','the visible review form is wired');
 submit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
 return created;
}
const regularPlan=(await submitReviewPlan())[0];
assert.equal(regularPlan.kind,'quiz');assert.equal(regularPlan.target.id,'q1');assert.equal(regularPlan.target.sourceVersion,6);
assert.equal(regularPlan.target.targetId,'target');assert.equal(regularPlan.title,originalQuestion.prompt);
const conceptOptions={params:{questionId:'concept:mconcept',memoryItemId:'mconcept'},content:conceptContent,bootstrap:{learning:{...bootstrap.learning,memory_items:[{...concept,question_id:'concept:mconcept'}]}}};
const conceptPlan=(await submitReviewPlan(conceptOptions))[0];
assert.equal(conceptPlan.kind,'interview','the application has an interview destination when its own quiz item does not exist');
assert.equal(conceptPlan.target.id,'q1');assert.equal(conceptPlan.title,originalQuestion.prompt,'the displayed plan describes the question actually opened');
assert.equal(conceptPlan.target.targetId,'target');assert.equal(conceptPlan.target.sourceType,'personal');assert.equal(conceptPlan.target.sourceVersion,6);
assert.equal((await submitReviewPlan({...conceptOptions,existing:[conceptPlan]})).length,0,'the exact planned task is not duplicated');
assert.equal((await submitReviewPlan({...conceptOptions,existing:[{...conceptPlan,kind:'quiz'}]})).length,1,'an old incorrect quiz plan does not block the corrected interview task');
assert.equal((await submitReviewPlan({...conceptOptions,existing:[{...conceptPlan,target:{...conceptPlan.target,sourceVersion:7}}]})).length,1,'the same ID in another source remains a separate review');
const commonPlan=(await submitReviewPlan({params:{sourceType:'common',sourceVersion:'3'},content:schoolContent}))[0];
assert.equal(commonPlan.target.sourceType,'common');assert.equal(commonPlan.target.sourceVersion,3);
console.log('Today review form payload: ordinary quiz, concept application interview, correct title/source/target, exact duplicate and wrong-kind/version guards passed.');
const dashboard=load('../apps/web/src/components/dashboard.tsx',{...mocks,react:hooks([{answerRevisions:[],assignments:[]},null,[],[],{recommendation:{count:1,items:[{question_id:'q1'}]}},{commonQuestions:[]},'',true,true,true,'briefing',[],undefined]),'./dashboard-planner':{DashboardPlanner:()=>React.createElement('section',null,'학교 면접 일정')},'./department-news':{DepartmentNews:()=>React.createElement('p',null,'학과 기사')}}).Dashboard;
const home=renderToStaticMarkup(React.createElement(dashboard));
assert.ok(home.includes('내 기록에서, 내 말로.')&&home.includes('이 답의 기록'));
assert.ok(home.includes('sourceVersion=7')&&home.includes('sourceType=personal'));
assert.ok(!home.includes('progressbar')&&!home.includes('준비 완료')&&!home.includes('자료 읽기 완료'));
assert.ok(home.includes('학교 면접 일정'));
const homeSections=['id="dashboard-next-title"','id="dashboard-agenda-title"','id="dashboard-answer-title"','id="dashboard-reading-title"','학교 면접 일정'];
for(const section of homeSections)assert.ok(home.includes(section),'the current question, work, answer, reading and calendar remain present');
for(let index=1;index<homeSections.length;index++)assert.ok(home.indexOf(homeSections[index-1])<home.indexOf(homeSections[index]),'mobile and assistive reading order prioritizes the current question, work and answer before supplemental reading and the full calendar');
const focusActionsOf=markup=>markup.match(/<div class="focusActions">([\s\S]*?)<\/div>/)?.[1]||'';
assert.match(focusActionsOf(home),/<a(?=[^>]*href="\/schools\/target")(?=[^>]*class="text-link")/,'school guidance remains available beside a different primary learning action');
for(const selectedTarget of [target,undefined]){
 const schoolApp={...bootstrap,targets:selectedTarget?[selectedTarget]:[],interviews:[]};
 const component=load('../apps/web/src/components/dashboard.tsx',{...mocks,
  './app-shell':{useApp:()=>({data:schoolApp,target:selectedTarget,targetId:selectedTarget?.id||'',toast(){}})},
  react:hooks([{answerRevisions:[],assignments:[]},null,[],[],{recommendation:{count:0,items:[]},sessions:[]},{commonQuestions:[]},'',true,true,true,'briefing',[],undefined]),
  './dashboard-planner':{DashboardPlanner:()=>null},'./department-news':{DepartmentNews:()=>null},
 }).Dashboard;
 const actions=focusActionsOf(renderToStaticMarkup(React.createElement(component)));
 const href=selectedTarget?'/schools/target':'/start';
 assert.equal((actions.match(new RegExp(`href="${href}"`,'g'))||[]).length,1,'school guidance or registration has only one CTA when it is the next action');
 assert.match(actions,new RegExp(`<a(?=[^>]*href="${href}")(?=[^>]*class="button primary")`),'the school destination keeps the primary action');
 assert.ok(selectedTarget?!actions.includes('class="text-link"'):actions.includes('href="/schools/new"'),'first question may offer optional school registration beside it');
}
console.log('Dashboard school CTA render: one primary guidance/registration link, distinct secondary guidance preserved.');
const deadlineTargets=[
 {...target,university:'고려대학교',schedule:{personal_date:'2026-10-24'}},
 {...target,id:'same-day',university:'고려대학교',department:'경영학과',schedule:{personal_date:'2026-10-24'}},
 {...target,id:'today',university:'오늘대학교',schedule:{personal_at:'2026-10-13T23:30:00-04:00'}},
 {...target,id:'past',university:'지난대학교',schedule:{personal_date:'2026-10-13'}},
 {...target,id:'period',university:'기간대학교',schedule:{period_start:'2026-10-24',period_end:'2026-10-26'},interview_date:'2026-10-24'},
 {...target,id:'public',university:'공개대학교'},
 {...target,id:'reference',university:'참고대학교'},
];
const deadlineApp={...bootstrap,targets:deadlineTargets};
const deadlineComponent=load('../apps/web/src/components/dashboard.tsx',{...mocks,
 './app-shell':{useApp:()=>({data:deadlineApp,target,targetId:target.id,toast(){}})},
 react:hooks([{answerRevisions:[],assignments:[]},null,[],[],{recommendation:{count:1,items:[{question_id:'q1'}]}},{commonQuestions:[]},'',true,true,true,'briefing',[
  {targetId:'public',startDate:'2026-10-22',endDate:'2026-10-22',applicability:'track_match'},
  {targetId:'reference',startDate:'2026-10-22',endDate:'2026-10-22',applicability:'school_reference'},
 ],undefined,[],{scope:JSON.stringify([bootstrap.user.id,target.id,targetScope.learningScopeIdentity(target),bootstrap.package.id,bootstrap.package.active_version]),learning:false,planner:false,study:false,knowledge:false,quiz:false,schools:false}]),
 './dashboard-planner':{DashboardPlanner:()=>null},'./department-news':{DepartmentNews:()=>null},
}).Dashboard;
const deadlineHome=renderToStaticMarkup(React.createElement(deadlineComponent));
const deadlineList=deadlineHome.match(/<section[^>]*aria-labelledby="dashboard-deadlines-title"[^>]*>([\s\S]*?)<\/section>/)?.[1]||'';
assert.equal((deadlineList.match(/<li>/g)||[]).length,deadlineTargets.length,'every registered target has its own row, including the same university and day');
assert.equal((deadlineList.match(/>D-10</g)||[]).length,2,'the same date must not merge two applications');
assert.match(deadlineList,/>D-day</);assert.match(deadlineList,/>면접일 지남</);assert.match(deadlineList,/>D-8</);
for(const id of ['period','reference']){
 const row=[...deadlineList.matchAll(/<li>([\s\S]*?)<\/li>/g)].find(match=>match[1].includes(`href="/schools/${id}"`))?.[1]||'';
 assert.ok(row.includes('면접일 등록')&&!row.includes('>D-'),'periods and unmatched school references cannot become individual countdowns');
}
assert.ok(deadlineList.includes('학교 공개일, 개별 일정 확인 필요'));
assert.ok(deadlineHome.indexOf('id="dashboard-next-title"')<deadlineHome.indexOf('id="dashboard-deadlines-title"'),'primary learning action precedes deadlines even with many schools');
assert.ok(deadlineList.includes('<details class="remainingDeadlines"><summary>다른 지원처 일정 6개</summary>'),'additional targets remain in a closed disclosure without merging duplicates');
console.log('Dashboard deadline rows: all targets, duplicate university/date, KST today, past date, matched public day, and unconfirmed-date registration passed.');
bootstrap.interviews=[{id:'other',state:'active',kind:'chat',target_id:'other',data:{context:{target:{...target,id:'other',university:'이전대학교'}},questionQueue:[{...originalQuestion,prompt:'다른 학교의 미완료 질문'}]}}];
const scopedDashboard=()=>load('../apps/web/src/components/dashboard.tsx',{...mocks,react:hooks([{answerRevisions:[],assignments:[]},null,[{id:'other-plan',date:'2026-10-14',title:'다른 학교의 계획',target:{targetId:'other'}},{id:'personal',date:'2026-10-14',title:'나의 공통 계획'}],[],{sessions:[{id:'foreign-quiz',state:'active',current_index:1,total:3,metadata:{targetId:'other'}}],recommendation:{count:1,items:[{question_id:'q1'}]}},{commonQuestions:[]},'',true,true,true,'briefing',[],undefined]),'./dashboard-planner':{DashboardPlanner:()=>null},'./department-news':{DepartmentNews:()=>null}}).Dashboard;
const scopedHome=renderToStaticMarkup(React.createElement(scopedDashboard()));
assert.ok(!scopedHome.includes('다른 학교의 미완료 질문')&&!scopedHome.includes('/interview/other?'));
assert.ok(!scopedHome.includes('/quiz/session/foreign-quiz'));
assert.ok(!scopedHome.includes('다른 학교의 계획')&&scopedHome.includes('나의 공통 계획'));
bootstrap.interviews.push({id:'own',state:'active',kind:'video',target_id:target.id,data:{context:{target},questionQueue:[{...originalQuestion,prompt:'지금 이어갈 면접의 실제 질문'}]}});
const activeHome=renderToStaticMarkup(React.createElement(scopedDashboard()));
assert.ok(activeHome.includes('지금 이어갈 면접의 실제 질문')&&activeHome.includes('/interview/own?kind=video'));
console.log('Learning flow React render: 19 assertions passed; single primary action, source version, current-target interviews/quizzes/plans, shared plans and actual resume question.');
const practicePlans=[
 {id:'practiced',date:'2026-10-14',title:'실제 수행한 복습',target:{targetId:target.id},completed:false,performedAt:'2026-10-14T07:00:00Z',href:'/quiz?questionId=q1&targetId=target&sourceType=personal&sourceVersion=6'},
 {id:'checked',date:'2026-10-14',title:'직접 체크한 계획',target:{targetId:target.id},completed:true,performedAt:null,href:'/quiz?questionId=q1'},
 {id:'pending',date:'2026-10-14',title:'아직 연습하지 않은 복습',target:{targetId:target.id},completed:false,performedAt:null,href:'/quiz?questionId=q1'},
];
function renderDashboardPlans(plans){
 const component=load('../apps/web/src/components/dashboard.tsx',{...mocks,react:hooks([{answerRevisions:[],assignments:[]},null,plans,[],{recommendation:{count:1,items:[{question_id:'q1'}]}},{commonQuestions:[]},'',true,true,true,'briefing',[],undefined]),'./dashboard-planner':{DashboardPlanner:()=>null},'./department-news':{DepartmentNews:()=>null}}).Dashboard;
 return renderToStaticMarkup(React.createElement(component));
}
const practicedHome=renderDashboardPlans(practicePlans);
assert.match(practicedHome,/남은 계획 1개/);assert.ok(!practicedHome.includes('남은 계획 2개'));
assert.match(practicedHome,/실제 수행한 복습 · 실제 연습 기록 있음/);
assert.match(practicedHome,/href="\/quiz\?questionId=q1&amp;targetId=target&amp;sourceType=personal&amp;sourceVersion=6"[^>]*>다시 연습/);
assert.ok(practicedHome.indexOf('아직 연습하지 않은 복습')<practicedHome.indexOf('실제 수행한 복습')&&practicedHome.indexOf('아직 연습하지 않은 복습')<practicedHome.indexOf('직접 체크한 계획'),'unfinished work precedes both observed practice and manually completed plans');
assert.ok(!practicedHome.includes('숙달 완료')&&!practicedHome.includes('실력 향상'));
assert.equal(practicePlans[0].completed,false,'observed practice never toggles the manual checkbox');
assert.equal(practicePlans[1].performedAt,null,'a manual check never fabricates saved practice');
const onlyPracticed=renderDashboardPlans([practicePlans[0]]);
assert.ok(!onlyPracticed.includes('남은 계획')&&onlyPracticed.includes('실제 연습 기록 있음')&&onlyPracticed.includes('다시 연습'));
const manuallyCheckedAndPracticed=renderDashboardPlans([{...practicePlans[0],completed:true}]);
assert.ok(manuallyCheckedAndPracticed.includes('다시 연습')&&!manuallyCheckedAndPracticed.includes('남은 계획'));
console.log('Dashboard planned-review React render: performed/manual/pending remain distinct; correct pending count, practice evidence, repeat CTA and pending-first order passed.');
