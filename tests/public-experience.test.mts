import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';

function load(file:string){
  const module={exports:{} as any};
  const code=ts.transpileModule(readFileSync('apps/web/src/components/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require(name:string){
    if(name==='react')return React;
    if(name==='react/jsx-runtime')return jsx;
    if(name==='react-dom')return {};
    if(name==='next/link')return {default:({href,children,...props}:any)=>React.createElement('a',{href,...props},children)};
    if(name==='lucide-react')return icons;
    if(name==='./owned-class-name')return {ownedClassName:(value:string)=>value};
    if(name==='./public-faq')return load('public-faq.tsx');
    if(name==='./public-links')return load('public-links.tsx');
    if(name==='@/lib/analytics')return {trackEvent:()=>{}};
    if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
    if(name==='@/lib/client/request-cache'||name==='./info-tip'||name==='./floating-notice')return {};
    throw Error(name);
  }});
  return module.exports;
}

test('FAQ is shared by the introduction and public page with five accessible disclosures and accurate access guidance',()=>{
  const {PublicFaq,PUBLIC_FAQ}=load('public-faq.tsx');
  assert.equal(PUBLIC_FAQ.length,5);
  const html=renderToStaticMarkup(React.createElement(PublicFaq,{standalone:true}));
  assert.equal((html.match(/<details>/g)||[]).length,5);
  assert.match(html,/<h1 id="faq-title">자주 묻는 질문<\/h1>/);
  assert.match(html,/운영자와 업무 권한을 배정받은 담당자/);
  assert.match(html,/외부 AI 처리 범위/);
  assert.doesNotMatch(html,/본인만 볼/);
  assert.match(html,/href="\/privacy"/);
  assert.match(html,/href="\/contact"/);
});

test('the public introduction shows three illustrative product steps and service links without invented testimonials',()=>{
  const {LoginIntroSheet}=load('login-intro-sheet.tsx');
  const html=renderToStaticMarkup(React.createElement(LoginIntroSheet));
  assert.match(html,/서비스 이해를 위한 예시/);
  for(const step of ['01 · 활동 선택','02 · 답변·보완','03 · 이전 답변 비교'])assert.ok(html.includes(step));
  for(const path of ['/faq','/contact','/privacy'])assert.ok(html.includes('href="'+path+'"'));
  assert.match(html,/intro-faq-title/);
  assert.doesNotMatch(html,/합격 후기|합격률|이용자 후기/);
});

test('breadcrumbs expose the current page, keep only parent links and handle a single current item',()=>{
  const {Breadcrumb}=load('shared.tsx');
  const html=renderToStaticMarkup(React.createElement(Breadcrumb,{items:[{label:'준비 현황',href:'/preparation'},{label:'지원 학교',href:'/schools'},{label:'학교 상세',href:'/schools/current'}]}));
  assert.match(html,/aria-label="현재 위치"/);
  assert.match(html,/href="\/preparation"/);
  assert.match(html,/href="\/schools"/);
  assert.match(html,/<span aria-current="page">학교 상세<\/span>/);
  assert.doesNotMatch(html,/href="\/schools\/current"/);
  const single=renderToStaticMarkup(React.createElement(Breadcrumb,{items:[{label:'내 계정'}]}));
  assert.match(single,/aria-current="page">내 계정/);
});
