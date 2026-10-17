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
function load(name,context){
 const module={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/'+name,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,require(name){
  if(name==='react/jsx-runtime')return jsx;
  if(name==='next/link')return {__esModule:true,default:({href,children,...props})=>React.createElement('a',{href,...props},children)};
  if(name==='next/navigation')return {usePathname:()=>path};
  if(name==='lucide-react')return icons;
  if(name==='@/lib/app-navigation')return nav;
  if(name==='@/lib/learning-target-scope')return scope;
  if(name==='./app-shell')return {useApp:()=>context};
  if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
  throw Error(name);
 }});return module.exports;
}
equal(nav.STUDENT_NAVIGATION.map(item=>item.label),['오늘','연습','무기고','자료','내 리포트']);
for(const [section,paths] of Object.entries({today:['/my','/my/today'],armory:['/armory','/armory/example'],practice:['/learn','/quiz','/quiz/memory','/quiz/assignments','/quiz/session/example','/interview','/interview/new','/interview/example','/chat/interviews/example','/practice/video/example'],resources:['/knowledge','/knowledge/example','/materials','/materials/questions/example','/materials/briefings','/schools','/schools/example','/account/confirmations'],reports:['/records','/records/comparisons','/reports/example']})){
 for(const route of paths)equal(nav.studentSection(route),section);
}
equal(nav.studentSection('/on'),null);equal(nav.studentSection('/account/settings'),null);
const {SectionNavigation}=load('section-navigation.tsx');
for(const route of ['/knowledge','/materials/briefings','/materials','/schools','/account/confirmations','/learn','/quiz','/quiz/assignments','/interview','/interview/new']){
 path=route;const markup=renderToStaticMarkup(React.createElement(SectionNavigation));
 equal((markup.match(/aria-current="page"/g)||[]).length,1);
}
for(const route of ['/quiz/session/frozen','/interview/frozen','/practice/video/frozen','/chat/interviews/frozen']){
 path=route;equal(renderToStaticMarkup(React.createElement(SectionNavigation)),'');
}
const target={id:'target',university:'서울시립대학교',department:'환경공학부',admission_year:2027,campus:'본교',admission_type:'면접형'};
const current={id:'current',state:'active',target_id:target.id,kind:'chat',data:{context:{target}}};
const old={...current,id:'old',data:{context:{target:{...target,department:'다른 학과'}}}};
const context={target,targetId:target.id,data:{interviews:[old,current]}};
const {PracticeHome}=load('practice-home.tsx',context);
let markup=renderToStaticMarkup(React.createElement(PracticeHome));
equal(markup.includes('/interview/current?kind=chat'),true);equal(markup.includes('/interview/old?'),false);
equal(markup.includes('/quiz?targetId=target'),true);equal(markup.includes('/interview?targetId=target'),true);
equal(markup.includes('href="/knowledge"'),true);equal(markup.includes('href="/records/comparisons"'),true);
context.data.interviews=[old];markup=renderToStaticMarkup(React.createElement(PracticeHome));equal(markup.includes('저장한 답에서 이어가기'),false);
console.log(`App navigation: ${checks} route/context/render checks passed; five primary areas, one active child, focused answer workspaces and frozen-target resume verified.`);
