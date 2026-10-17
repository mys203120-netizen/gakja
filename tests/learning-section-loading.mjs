import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import * as runtime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as icons from 'lucide-react';
import {tsImport} from 'tsx/esm/api';

// Execute the real component effects and render their resulting states. Deferred
// requests deliberately ignore abort, so stale-result guards are exercised too.
const targetScope=await tsImport('../apps/web/src/lib/learning-target-scope.ts',import.meta.url);
const workflow=await tsImport('../packages/content-contracts/src/workflows.ts',import.meta.url);
const styles=new Proxy({},{get:(_,name)=>String(name)}),cache=new Map();
const link=({href,children,...props})=>React.createElement('a',{href,...props},children);
const primitive=({children})=>React.createElement('div',null,children);
function load(path,mocks={}){
 const url=new URL(path,import.meta.url);if(cache.has(url.href)&&!Object.keys(mocks).length)return cache.get(url.href);
 const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,URLSearchParams,Intl,Date,Set,Map,AbortController,console,require(name){
  if(name in mocks)return mocks[name];
  if(name==='react/jsx-runtime')return runtime;if(name==='react')return React;if(name==='lucide-react')return icons;
  if(name==='@/lib/learning-target-scope')return targetScope;if(name==='@gakja/content-contracts/workflows')return workflow;
  if(name==='@/lib/learning-growth'||name==='./learning-growth')return load('../apps/web/src/lib/learning-growth.ts');
  if(name==='./transcript-provenance')return load('../apps/web/src/lib/transcript-provenance.ts');
  if(name.startsWith('@/lib/'))return load('../apps/web/src/lib/'+name.slice(6)+'.ts');
  throw new Error(name);
 }});
 if(!Object.keys(mocks).length)cache.set(url.href,module.exports);return module.exports;
}
const a={id:'a',university:'서울시립대학교',department:'환경공학부',admission_year:2027,campus:'본교',admission_type:'학생부종합Ⅰ'};
const b={...a,id:'b',university:'다른대학교',department:'다른학과'};
const qa={id:'qa',prompt:'A 학교에서 연습할 질문',support_target_ids:['a'],activity_ids:[]};
const qb={id:'qb',prompt:'B 학교에서 연습할 질문',support_target_ids:['b'],activity_ids:[]};
function bootstrap(){return {user:{id:'student',name:'하린'},targets:[a,b],package:{id:'publication',active_version:6},learning:{activities:[],questions:[qa,qb],memory_items:[],source_refs:[]},interviews:[],notifications:[]};}
function harness(component,params={}){
 const state=[],effects=[],queued=[],requests=[];let cursor=0;
 const context={data:bootstrap(),target:a,targetId:'a',learningRevision:0,toast(){}};
 const hooks={...React,useState(initial){const id=cursor++;if(!(id in state))state[id]=typeof initial==='function'?initial():initial;return [state[id],value=>{state[id]=typeof value==='function'?value(state[id]):value;}];},useEffect(effect,deps){const id=cursor++,old=effects[id];if(!old||deps.some((dep,index)=>!Object.is(dep,old.deps[index]))){queued.push(()=>{old?.cleanup?.();effects[id]={deps:[...deps],cleanup:effect()};});}}};
 const api=(url,options={})=>new Promise((resolve,reject)=>requests.push({url,signal:options.signal,resolve,reject}));
 const shared={ActionButton:({pending,pendingLabel,children,...props})=>React.createElement('button',{...props,disabled:props.disabled||pending,'aria-busy':pending||undefined},pending?pendingLabel:children),api,post:()=>{throw new Error('must not write');},Alert:primitive,Breadcrumb:()=>null,Spinner:()=>React.createElement('p',null,'구역 불러오는 중'),Empty:({title})=>React.createElement('p',null,title),PageTitle:({title})=>React.createElement('h1',null,title),dateLabel:()=> '10월 15일',targetName:t=>t?.university||'지원처 미등록',LinkedRow:({href,title})=>React.createElement(link,{href},title)};
 const mocks={react:hooks,'next/link':{default:link},'./app-shell':{useApp:()=>context},'./shared':shared,'./learning-flow-ui.module.css':{default:styles},
  '@/lib/planner-model':{koreaToday:()=> '2026-10-15',shiftPlanDay:()=> '2026-10-18'},
  'next/navigation':{useRouter:()=>({push(){},replace(){}}),useSearchParams:()=>new URLSearchParams(params)},
  './learning-help':{LearningHelp:()=>React.createElement('p',null,'완료된 도움 자료')},'./study-session-provider':{finishStudySession:()=>{throw new Error('must not submit');}},
  './dashboard-planner':{DashboardPlanner:({loaded,plans})=>React.createElement('p',null,loaded?'계획:'+plans.map(p=>p.title).join(','):'계획 불러오는 중')},
  './department-news':{DepartmentNews:()=>React.createElement('p',null,'독립 뉴스 구역')},
 };
 const Component=load('../apps/web/src/components/'+component+'.tsx',mocks)[component==='dashboard'?'Dashboard':'TodayLearning'];
 return {context,requests,render(commit=true){cursor=0;queued.length=0;const html=renderToStaticMarkup(React.createElement(Component));if(commit)while(queued.length)queued.shift()();return html;},dispose(){effects.forEach(effect=>effect?.cleanup?.());}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function request(h,path,start=0){const req=h.requests.slice(start).find(r=>r.url.split('?')[0]===path);assert.ok(req,'request exists: '+path);return req;}
async function resolveCore(h,start=0,target='a',learning={answerRevisions:[],assignments:[]}){
 request(h,'/api/learning',start).resolve(learning);
 request(h,'/api/study-sessions',start).resolve({});
 request(h,'/api/quiz',start).resolve({contentVersion:6,target:target==='a'?a:b,recommendation:{count:1,items:[{question_id:target==='a'?'qa':'qb'}]},library:{answer:[]}});
 await flush();
}

const dashboard=harness('dashboard');dashboard.render();assert.equal(dashboard.requests.length,6);
await resolveCore(dashboard);let html=dashboard.render();
assert.ok(html.includes(qa.prompt)&&html.includes('이 질문에 답하기'),'core learning becomes usable while all optional requests are pending');
assert.ok(html.includes('계획 불러오는 중'),'planner keeps its own pending state');
assert.ok(!html.includes('예정된 할 일이 없어요.'),'pending plans are not announced as empty');
request(dashboard,'/api/planner').resolve({plans:[{id:'plan',date:'2026-10-15',title:'나중에 도착한 계획'}]});await flush();html=dashboard.render();
assert.ok(html.includes('나중에 도착한 계획')&&html.includes(qa.prompt),'late planner updates independently');
dashboard.context.data={...dashboard.context.data,notifications:[{id:'read',read_at:'now'}]};dashboard.render();
assert.equal(dashboard.requests.length,6,'an unrelated bootstrap object replacement does not recrawl every section');
dashboard.context.learningRevision++;dashboard.render();assert.equal(dashboard.requests.length,12,'an explicit learning refresh reloads saved evidence');
assert.ok(dashboard.requests.slice(0,6).every(r=>r.signal.aborted),'replaced effects cancel all old reads');
await resolveCore(dashboard,6,'a',{answerRevisions:[{id:'new',question_id:'qa',script:'방금 저장한 답변',target_id:'a',target_snapshot:a,content_version:6,revision_kind:'interview_answer',created_at:'2026-10-15T02:00:00Z',assistance_recorded:true}],assignments:[]});
assert.ok(dashboard.render().includes('방금 저장한 답변'),'saved answers are visible after refresh');
dashboard.context.target=b;dashboard.context.targetId='b';html=dashboard.render(false);
assert.ok(!html.includes(qa.prompt)&&!html.includes('방금 저장한 답변'),'target changes hide old data before the next effect commit');
dashboard.render();assert.equal(dashboard.requests.length,18);
request(dashboard,'/api/planner',6).resolve({plans:[{id:'stale',date:'2026-10-15',title:'폐기된 지원처 계획'}]});
request(dashboard,'/api/schools',6).resolve({commonQuestions:[{id:'stale',prompt:'폐기된 학교 질문'}]});
await resolveCore(dashboard,12,'b');html=dashboard.render();
assert.ok(html.includes(qb.prompt)&&!html.includes(qa.prompt)&&!html.includes('폐기된'),'late aborted results cannot enter the new target');
dashboard.context.learningRevision++;dashboard.render();request(dashboard,'/api/learning',18).reject(new Error('학습 기록 연결 오류'));
request(dashboard,'/api/study-sessions',18).resolve({});request(dashboard,'/api/quiz',18).resolve({recommendation:{count:1,items:[{question_id:'qb'}]}});await flush();html=dashboard.render();
assert.ok(html.includes('오늘의 질문을 확인하지 못했어요.')&&html.includes('답변 기록을 확인하지 못했어요.'));
assert.ok(!html.includes('직접 남긴 답변이 아직 없어요.'),'failed history never becomes a first-attempt claim');
request(dashboard,'/api/planner',18).reject(new Error('일정 연결 오류'));await flush();html=dashboard.render();
assert.ok(html.includes('일정을 확인하지 못했어요.')&&!html.includes('계획 불러오는 중')&&!html.includes('예정된 면접 일정이 없어요.'),'a failed calendar is neither perpetually loading nor an empty schedule');
dashboard.dispose();

const today=harness('today-learning');today.render();assert.equal(today.requests.length,6);await resolveCore(today);html=today.render();
assert.ok(html.includes(qa.prompt)&&html.includes('class="button primary"'),'today learning does not wait for videos, schools or optional help');
assert.ok(!html.includes('완료된 도움 자료'),'pending evidence does not mount a second help fetch');
today.context.data={...today.context.data,notifications:[{id:'notification'}]};today.render();assert.equal(today.requests.length,6);
request(today,'/api/learning-help').resolve({learning:{questions:[qa],activities:[],source_refs:[]}});await flush();html=today.render();
assert.ok(html.includes('완료된 도움 자료')&&html.includes(qa.prompt));
today.context.target=b;today.context.targetId='b';html=today.render(false);assert.ok(!html.includes(qa.prompt));today.render();await resolveCore(today,6,'b');html=today.render();assert.ok(html.includes(qb.prompt)&&!html.includes(qa.prompt));
today.context.learningRevision++;today.render();assert.equal(today.requests.length,18);
request(today,'/api/quiz',12).reject(new Error('퀴즈 기록 연결 오류'));request(today,'/api/learning',12).resolve({answerRevisions:[]});request(today,'/api/study-sessions',12).resolve({});await flush();html=today.render();
assert.ok(html.includes('학습 기록을 모두 확인하지 못했어요.')&&!html.includes('새 답변 없음'),'failed required reads cannot choose a learning stage');today.dispose();

const frozen=harness('today-learning',{questionId:'qa',targetId:'a',sourceType:'personal',sourceVersion:'6'});frozen.render();await resolveCore(frozen);html=frozen.render();
assert.ok(!html.includes(qa.prompt),'a pinned source waits for its historical snapshot');
request(frozen,'/api/learning-help').resolve({learning:{questions:[{...qa,prompt:'발행 당시 질문'}],activities:[],source_refs:[]}});await flush();html=frozen.render();
assert.ok(html.includes('발행 당시 질문')&&!html.includes(qa.prompt),'historical source is released independently of pending recommended videos');
frozen.context.data={...frozen.context.data,package:{id:'publication',active_version:7}};frozen.render();assert.equal(frozen.requests.length,12,'publishing a new source revalidates scoped learning');frozen.dispose();
console.log('Section loading regression passed: independent core/optional reads, late updates, abort/stale-target isolation, pinned source protection, explicit refresh, unrelated bootstrap stability and required-read failures.');
