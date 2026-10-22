import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';
const nav=await tsImport('../apps/web/src/lib/app-navigation.ts',import.meta.url);
const scope=await tsImport('../apps/web/src/lib/learning-target-scope.ts',import.meta.url);
let checks=0,path='/learn';
const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
function load(name,context,environment={}){
 const module={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/'+name,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{...environment.globals,module,exports:module.exports,require(name){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if(name==='react/jsx-runtime')return jsx;
  if(name==='react')return environment.react||React;
  if(name==='next/link')return {__esModule:true,default:({href,children,...props})=>React.createElement('a',{href,...props},children)};
  if(name==='next/navigation')return {usePathname:()=>path};
  if(name==='lucide-react')return icons;
  if(name==='@/lib/app-navigation')return nav;
  if(name==='@/lib/learning-target-scope')return scope;
  if(name==='./app-shell')return {useApp:()=>context};
  if(name==='./focus-training')return {FocusTraining:({targetId})=>React.createElement('section',{'aria-label':'약점 집중 훈련','data-target-id':targetId})};
  if(name==='./training-hub')return {TrainingHeader:({title})=>React.createElement('header',null,React.createElement('h1',null,title))};
  if(name==='./learning-discovery')return load('learning-discovery.tsx',context,environment);
  if(name==='./shared')return {PageTitle:({title})=>React.createElement('h1',null,title)};
  if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
  throw Error(name);
 }});return module.exports;
}
equal(nav.STUDENT_NAVIGATION.map(item=>item.label),['오늘 훈련','준비 현황','내 기록']);
equal(nav.PRACTICE_SECTIONS.map(item=>[item.href,item.label]),[['/my','오늘 계획'],['/learn','자유 연습'],['/on','AI 비서']]);
equal(nav.MOBILE_STUDENT_NAVIGATION.map(item=>[item.href,item.label]),[
 ['/my','오늘 훈련'],['/preparation','준비 현황'],['/records','내 기록'],
]);
equal(nav.MOBILE_STUDENT_NAVIGATION.map(item=>[item.href,item.label]),nav.STUDENT_NAVIGATION.map(item=>[item.href,item.label]));
for(const [href,routes] of Object.entries({
 '/my':['/my','/my/today','/my/train','/my/diagnosis','/availability','/learn','/quiz/session/answer','/quiz/assignments/task','/interview/new','/interview/session','/chat/interviews/session','/practice/video/session','/on/interviews','/on/interviews/new','/on/interviews/session','/on/interviews/session/turn','/on','/on/conversation','/on/interviews-extra'],
 '/preparation':['/preparation','/armory','/armory/answer/edit','/knowledge','/knowledge/article','/materials/questions/question','/materials/briefings/article','/schools/school','/account/confirmations'],
 '/records':['/records','/records/comparisons','/reports/report'],
})){
 for(const route of routes)equal(nav.MOBILE_STUDENT_NAVIGATION.filter(item=>nav.mobileStudentActive(route,item.href)).map(item=>item.href),[href]);
}
for(const route of ['/online','/armory-extra','/myth','/records-old','/account/settings']){
 equal(nav.MOBILE_STUDENT_NAVIGATION.filter(item=>nav.mobileStudentActive(route,item.href)).map(item=>item.href),[]);
}
for(const [section,paths] of Object.entries({today:['/my','/my/today','/my/diagnosis','/my/train','/availability','/learn','/quiz','/quiz/memory','/quiz/assignments','/quiz/session/example','/interview','/interview/new','/interview/example','/chat/interviews/example','/practice/video/example'],preparation:['/preparation','/armory','/armory/example','/knowledge','/knowledge/example','/materials','/materials/questions/example','/materials/briefings','/schools','/schools/example','/account/confirmations'],records:['/records','/records/comparisons','/reports/example']})){
 for(const route of paths){equal(nav.studentSection(route),section);equal(nav.STUDENT_NAVIGATION.filter(item=>nav.studentSection(item.href)===nav.studentSection(route)).map(item=>item.id),[section]);}
}
for(const route of ['/on','/on/conversation','/on/interviews-extra'])equal(nav.studentSection(route),'today');equal(nav.studentSection('/account/settings'),null);
for(const route of ['/on/interviews','/on/interviews/new','/on/interviews/session','/on/interviews/session/turn']){
 equal(nav.studentSection(route),'today');
 equal(nav.practiceSectionHref(route),'/learn');
}
for(const route of ['/on/interviews','/on/interviews/new','/on/interviews/new/setup','/on/interviews-extra/session'])equal(nav.isAnswerWorkspace(route),false);
for(const route of ['/on/interviews/session','/on/interviews/session/turn','/on/interviews/newly-created'])equal(nav.isAnswerWorkspace(route),true);
equal(nav.isAnswerWorkspace('/quiz/assignments/task'),true);
equal(nav.isAnswerWorkspace('/quiz/assignments'),false);
const {SectionNavigation}=load('section-navigation.tsx');
for(const route of ['/knowledge','/materials/briefings','/materials','/schools','/account/confirmations','/my','/learn','/quiz','/quiz/assignments','/interview','/interview/new']){
 path=route;const markup=renderToStaticMarkup(React.createElement(SectionNavigation));
 equal((markup.match(/aria-current="page"/g)||[]).length,1);
}
for(const route of ['/knowledge','/materials/briefings/article','/schools/school']){
 path=route;const markup=renderToStaticMarkup(React.createElement(SectionNavigation));
 equal(markup.includes('aria-label="준비 자료와 활동"'),true);
 equal(markup.includes('href="/armory"'),true);
 const active=markup.match(/<a[^>]*href="([^"]+)"[^>]*aria-current="page"/);
 equal(active?.[1],route.startsWith('/schools')?'/schools':route.startsWith('/materials/briefings')?'/materials/briefings':'/knowledge');
}
for(const route of ['/my/diagnosis','/my/train','/preparation','/availability']){
 path=route;equal(renderToStaticMarkup(React.createElement(SectionNavigation)),'');
}
for(const route of ['/on','/on/conversation','/armory','/armory/answer/edit']){
 path=route;const markup=renderToStaticMarkup(React.createElement(SectionNavigation));
 equal((markup.match(/aria-current="page"/g)||[]).length,1);
 equal(markup.includes('href="/my"')||markup.includes('href="/preparation"'),true);
}
for(const route of ['/on/interviews','/on/interviews/new']){
 path=route;const markup=renderToStaticMarkup(React.createElement(SectionNavigation));
 equal(markup.includes('aria-label="오늘 훈련과 연습"'),true);
 equal(markup.match(/<a[^>]*href="([^"]+)"[^>]*aria-current="page"/)?.[1],'/learn');
}
// Every entry shares the same three destinations, with interview and assignment browsers under free practice.
for(const [route,current] of [['/my','/my'],['/quiz','/learn'],['/quiz/assignments','/learn'],['/interview','/learn'],['/interview/chat','/learn'],['/interview/live','/learn'],['/on','/on']]){
 path=route;const markup=renderToStaticMarkup(React.createElement(SectionNavigation));
 equal((markup.match(/<a /g)||[]).length,3);
 equal(markup.match(/<a[^>]*href="([^"]+)"[^>]*aria-current="page"/)?.[1],current);
 equal(markup.includes('직접 연습 선택')||markup.includes('모의면접')||markup.includes('>과제<'),false);
}
for(const route of ['/quiz/session/frozen','/interview/frozen','/practice/video/frozen','/chat/interviews/frozen','/on/interviews/frozen','/on/interviews/frozen/turn']){
 path=route;equal(renderToStaticMarkup(React.createElement(SectionNavigation)),'');
}
// The AI helper still allows active answer/recording workspaces to pause or veto a move.
{
 const events=[];
 path='/learn';
 const {SectionNavigation:Interactive}=load('section-navigation.tsx',undefined,{react:{...React,useRef:()=>({current:null}),useEffect(){}},globals:{Event,window:{dispatchEvent(event){events.push(event);event.preventDefault();}}}});
 const tree=Interactive(),nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
 const helper=nodes(tree).find(node=>node.props?.href==='/on');let prevented=false;
 helper.props.onClick({preventDefault(){prevented=true;}});
 equal(events[0].type,'gakja:open-on');equal(prevented,true);
}
// Active tabs scroll only their own horizontal strip, never the document.
for(const [left,right,reduced,expected] of [[360,440,false,[120,'smooth']],[-30,50,true,[-30,'instant']],[10,80,false,null]]){
 const calls=[],container={getBoundingClientRect:()=>({left:0,right:320}),querySelector:()=>({getBoundingClientRect:()=>({left,right})}),scrollBy:options=>calls.push([options.left,options.behavior])};
 const {SectionNavigation:Scrollable}=load('section-navigation.tsx',undefined,{react:{...React,useRef:()=>({current:container}),useEffect:effect=>effect()},globals:{window:{matchMedia:()=>({matches:reduced})}}});
 path='/schools';Scrollable();equal(calls,expected?[expected]:[]);
}
const target={id:'target',university:'서울시립대학교',department:'환경공학부',admission_year:2027,campus:'본교',admission_type:'면접형'};
const current={id:'current',state:'active',target_id:target.id,kind:'chat',data:{context:{target}}};
const old={...current,id:'old',data:{context:{target:{...target,department:'다른 학과'}}}};
const context={target,targetId:target.id,data:{interviews:[old,current]}};
const {PracticeHome}=load('practice-home.tsx',context);
let markup=renderToStaticMarkup(React.createElement(PracticeHome));
equal(markup.includes('/interview/current?kind=chat'),true);equal(markup.includes('/interview/old?'),false);
equal(markup.includes('/quiz?targetId=target'),true);equal(markup.includes('/interview/chat?targetId=target'),true);equal(markup.includes('/interview/live?targetId=target'),true);
for(const label of ['퀴즈','Chat 면접','Live 면접'])equal((markup.match(new RegExp(`<h2>${label}</h2>`,'g'))||[]).length,1);
equal(markup.includes('href="/on"'),false);equal(markup.includes('href="/quiz/assignments"'),true);
equal(markup.includes('aria-label="약점 집중 훈련" data-target-id="target"'),true);
equal(markup.includes('href="/knowledge?targetId=target"'),true);equal(markup.includes('href="/materials/briefings"'),true);equal(markup.includes('href="/armory"'),true);equal(markup.includes('href="/records/comparisons"'),true);
equal(markup.includes('지식한입'),true);equal(markup.includes('시사 브리핑'),true);
equal(markup.indexOf('aria-label="개념과 시사"')<markup.indexOf('href="/armory"'),true);
equal((markup.match(/href="\/armory"/g)||[]).length,1);
equal(markup.indexOf('href="/interview/live?targetId=target"')<markup.indexOf('href="/armory"'),true);
equal(markup.indexOf('href="/armory"')<markup.indexOf('aria-label="약점 집중 훈련"'),true);
equal(markup.includes('<strong>내 경험 정리</strong>'),true);
context.data.interviews=[old];markup=renderToStaticMarkup(React.createElement(PracticeHome));equal(markup.includes('저장한 답에서 이어가기'),false);
for(const purpose of ['diagnostic','focus','mixed']){
 context.data.interviews=[{...current,data:{...current.data,trainingPlanId:'saved-plan',trainingPurpose:purpose}}];
 markup=renderToStaticMarkup(React.createElement(PracticeHome));equal(markup.includes('href="/my/train?planId=saved-plan"'),true);equal(markup.includes('/interview/current?'),false);
 equal(markup.includes('진행 중인 훈련'),true);
}
console.log(`App navigation: ${checks} route/context/render checks passed; three shared menus, nested activity/material access, focused answer workspaces and frozen-target resume verified.`);
