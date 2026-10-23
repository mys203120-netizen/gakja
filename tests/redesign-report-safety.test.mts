import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {renderReportExport} from '../apps/web/src/lib/report-export';
import * as exampleModel from '../apps/web/src/lib/example-answer-model';

function load(file:string,imports:Record<string,unknown>){const module={exports:{} as any};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Response,Request,URL,Date,Promise,Number,require(name:string){if(name in imports)return imports[name];if(name==='@/lib/example-answer-model')return exampleModel;if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};throw new Error(name);}});return module.exports;}

test('progress distinguishes no plan from an unstarted plan',()=>{
 const charts=load('apps/web/src/components/learning-charts.tsx',{'react/jsx-runtime':jsx});
 const markup=(total:number)=>renderToStaticMarkup(React.createElement(charts.ProgressRing,{completed:0,total,label:'이번 주'}));
 assert.match(markup(0),/등록된 계획 없음/);assert.match(markup(0),/—/);assert.doesNotMatch(markup(0).replace(/<[^>]*>/g,''),/0%|0 \/ 0/);
 assert.match(markup(3),/0 \/ 3개/);assert.match(markup(3),/0<small>%/);
});

test('distribution stacks keep the legend color when an earlier category is zero',()=>{
 const charts=load('apps/web/src/components/learning-charts.tsx',{'react/jsx-runtime':jsx});
 const html=renderToStaticMarkup(React.createElement(charts.LearningDistribution,{rows:[{label:'답변한 항목',value:0},{label:'답변 후 보완',value:2},{label:'아직 답변 전',value:6}]}));
 assert.deepEqual([...html.matchAll(/data-tone="(\w+)"/g)].map(match=>match[1]),['sage','mint','green','sage','mint']);assert.match(html,/>2<small/);assert.match(html,/>6<small/);
});
test('HTML export escapes every student string, uses the submitted answer and omits withdrawn events',()=>{
 const html=renderReportExport({title:'<img src=x onerror=alert(1)>',interviews:[{data:{sections:[{question:'<script>x</script>',answer:'학생이 수정해 제출한 답변',rawTranscript:'전사 오인식',feedback:{content:'<iframe>악성</iframe>'}}]}}],studies:[{events:[{kind:'quiz_response',data:{answer:'삭제한 답변',invalidated:true}},{kind:'interview_answer',data:{answer:'남길 답변',feedback:{content:'확인할 문장'}}}]}]});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<iframe>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('학생이 수정해 제출한 답변'));assert.ok(!html.includes('전사 오인식'));assert.ok(!html.includes('삭제한 답변'));assert.ok(!html.includes('[object Object]'));
});
test('export requires a student and exactly one valid selector before reading owned data',async()=>{
 const queries:any[]=[];let role='student';const route=load('apps/web/src/app/api/report-export/route.ts',{
  '@/lib/auth':{requireUser:async()=>({id:'owner',role})},'@/lib/db':{ApiError:class extends Error{constructor(public status:number,message:string){super(message);}},errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500}),query:async(sql:string,args:unknown[])=>{queries.push({sql,args});return [];},transaction:async(fn:Function)=>fn({})},'@/lib/report-export':{renderReportExport},'@/lib/study-sessions':{normaliseSourceFacts:async()=>[],studySummary:()=>({})},
 });
 for(const query of ['date=2026-02-30','reportId=bad','date=2026-10-23&studyId=00000000-0000-0000-0000-000000000001',''])assert.equal((await route.GET(new Request('http://local/api/report-export?'+query))).status,400);
 assert.equal(queries.length,0);role='admin';assert.equal((await route.GET(new Request('http://local/api/report-export?date=2026-10-23'))).status,403);assert.equal(queries.length,0);
 role='student';assert.equal((await route.GET(new Request('http://local/api/report-export?reportId=00000000-0000-0000-0000-000000000001'))).status,404);assert.equal(queries.length,1);assert.equal(queries[0].args[0],'owner');assert.match(queries[0].sql,/r.student_id=\$1/);assert.match(queries[0].sql,/s.student_id=r.student_id/);
});
test('study download normalises current source facts and recomputes its summary',async()=>{
 let sourceChecked=false,summaryChecked=false;const route=load('apps/web/src/app/api/report-export/route.ts',{
  '@/lib/auth':{requireUser:async()=>({id:'owner',role:'student'})},'@/lib/db':{ApiError:Error,errorResponse:(error:any)=>Response.json({error:error.message},{status:500}),query:async()=>[{id:'study',report:{quiz:{answered:99}},events:[{source_id:'source',data:{answer:'old answer'}}]}],transaction:async(fn:Function)=>fn({})},'@/lib/report-export':{renderReportExport},'@/lib/study-sessions':{normaliseSourceFacts:async(_db:unknown,id:string,events:any[])=>{assert.equal(id,'owner');assert.equal(events[0].source_id,'source');sourceChecked=true;return [{kind:'interview_answer',data:{answer:'current answer'}},{kind:'quiz_response',data:{answer:'withdrawn',invalidated:true}}];},studySummary:(events:any[])=>{summaryChecked=true;assert.equal(events.length,1);return {quiz:{answered:0},interviews:{answered:1}};}},
 });
 const response=await route.GET(new Request('http://local/api/report-export?studyId=00000000-0000-0000-0000-000000000001'));assert.equal(response.status,200);const html=await response.text();assert.ok(sourceChecked&&summaryChecked);assert.ok(html.includes('current answer'));assert.ok(!html.includes('old answer'));assert.ok(!html.includes('withdrawn'));assert.ok(html.includes('퀴즈 0문항'));assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.match(response.headers.get('Content-Security-Policy')!,/default-src 'none'/);
});
