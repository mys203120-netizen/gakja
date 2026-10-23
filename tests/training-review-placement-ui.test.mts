import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {z} from 'zod';
import {validPlanDay} from '../apps/web/src/lib/planner-model';
const source=ts.transpileModule(readFileSync('apps/web/src/components/training-review-placement.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const suggestion={questionKey:'scoped-question-key',questionId:'q',title:'합성 질문',reason:'도움 없이 다시 답할 과제예요.',targetId:'school',school:'합성 학교 · 환경공학과',sourceType:'personal',sourceVersion:2,area:'진로활동',deadline:'2026-10-27',deadlineLabel:'개별 면접일',status:'ready',message:'해당 영역의 날짜가 없어요.',candidates:[{date:'2026-10-23',minutes:30,before:[{id:'old',title:'기존 자동 계획',revision:1,area:'세특'}]}],conflicts:[{date:'2026-10-24',reason:'직접 추가한 일정이 있어요.'}]};
const proposal={preview:{label:'보완 영역 편성',...suggestion,date:'2026-10-23',minutes:30,before:suggestion.candidates[0].before,after:[{title:'기록 복습',minutes:6,kind:'reading',sequence:0,area:'진로활동'},{title:'화상 보완',minutes:19,kind:'focus',sequence:1,area:'진로활동'},{title:'오늘 정리',minutes:5,kind:'review',sequence:2,area:'진로활동'}]},fingerprint:'a'.repeat(64)};
const undo={preview:{label:'편성 되돌리기',replacement:{date:'2026-10-23',before:['기록 복습','화상 보완','오늘 정리'],after:['기존 자동 계획']},changes:[]},fingerprint:'b'.repeat(64),operationId:'op'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const words=(value:any):string=>Array.isArray(value)?value.map(words).join(''):typeof value==='string'?value:typeof value==='object'&&value?words(value.props?.children):'';
function fixture(handler:(url:string,body:any)=>Promise<any>=async(_url,body)=>body.action==='preview'?proposal:body.action==='undoPreview'?undo:{operationId:'op',history:[]}){
 const state:any[]=[[suggestion],suggestion.questionKey,'2026-10-23',null,null,'',false,'','',0],refs:any[]=[],calls:any[]=[],effects:any[]=[];let cursor=0,refCursor=0,saved=0;
 const hooks={...React,useState(initial:any){const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],(next:any)=>{state[index]=typeof next==='function'?next(state[index]):next;}];},useRef(initial:any){return refs[refCursor++]??={current:initial};},useEffect(fn:Function){effects.push(fn);}};
 const module={exports:{} as any};vm.runInNewContext(source,{module,exports:module.exports,AbortController,Promise,require(name:string){
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;
  if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};
  if(name==='next/link')return {default:({children,...props}:any)=>React.createElement('a',props,children)};
  if(name==='./settings-select')return {SettingsSelect:({label,value,options,onChange}:any)=>React.createElement('label',null,label,React.createElement('select',{value,onChange:(event:any)=>onChange(event.target.value)},options.map((option:any)=>React.createElement('option',{key:option.value,value:option.value},option.label))))};
  if(name==='./shared')return {api:async()=>({suggestions:[suggestion],history:[]}),post:async(url:string,body:any)=>{calls.push({url,body});return handler(url,body);},Modal:({title,children}:any)=>React.createElement('section',{'aria-label':title},children),Alert:({children}:any)=>React.createElement('p',{role:'alert'},children)};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);
 }});
 const render=()=>{cursor=0;refCursor=0;effects.length=0;return module.exports.TrainingReviewPlacement({enabled:true,onChanged:()=>{saved++;}});};
 return {state,calls,render,html:()=>renderToStaticMarkup(render()),button:(label:string)=>nodes(render()).find(node=>node.type==='button'&&words(node).includes(label)),dispose(){refs[0].current=false;},get saved(){return saved;}};
}
test('area preview exposes evidence, whole-day before/after, protected-date conflict and applies only after explicit confirmation',async()=>{
 const f=fixture();let html=f.html();assert.match(html,/합성 질문/);assert.match(html,/개인 자료.*2.*판/);assert.match(html,/직접 추가한 일정/);assert.equal(f.calls.length,0);
 f.button('변경 미리보기').props.onClick();await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.action,'preview');assert.equal(f.saved,0);html=f.html();assert.match(html,/변경 전/);assert.match(html,/기존 자동 계획/);assert.match(html,/변경 후/);assert.match(html,/화상 보완/);assert.match(html,/하루 한 영역/);
 f.button('이 일정으로 적용').props.onClick();await flush();assert.equal(f.calls[1].body.fingerprint,proposal.fingerprint);assert.equal(f.calls[1].body.selection.questionKey,suggestion.questionKey);assert.equal(f.saved,1);assert.match(f.html(),/연습을 시작하기 전에는 되돌릴/);
 f.button('최근 보완 편성 되돌리기').props.onClick();await flush();assert.equal(f.calls[2].url,'/api/planner/calendar');assert.equal(f.calls[2].body.action,'undoPreview');assert.equal(f.saved,1);assert.match(f.html(),/복원할 순서/);
 nodes(f.render()).find(node=>node.type==='button'&&words(node)==='편성 되돌리기').props.onClick();await flush();assert.equal(f.calls[3].body.action,'undo');assert.equal(f.calls[3].body.fingerprint,undo.fingerprint);assert.equal(f.saved,2);
});
test('conflicts stay reviewable and duplicate clicks or late scoped responses cannot apply twice',async()=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise(yes=>{resolve=yes;}),f=fixture(async()=>pending);const preview=f.button('변경 미리보기');preview.props.onClick();preview.props.onClick();assert.equal(f.calls.length,1);f.dispose();resolve(proposal);await flush();assert.equal(f.state[3],null);assert.equal(f.saved,0);
 const failed=fixture(async(_url,body)=>{if(body.action==='preview')return proposal;throw Error('일정·자료·보완 근거가 바뀌었어요. 변경 내용을 다시 확인해 주세요.');});failed.button('변경 미리보기').props.onClick();await flush();failed.button('이 일정으로 적용').props.onClick();await flush();assert.match(failed.html(),/일정·자료·보완 근거가 바뀌었어요/);assert.equal(failed.saved,0);assert.ok(failed.state[3]);
});
test('no available day shows a concrete settings path and no apply/preview action',()=>{
 const f=fixture();f.state[0]=[{...suggestion,status:'blocked',candidates:[],message:'면접 전 가용일이 없어요.',resolution:{href:'/availability',label:'학습 시간 설정'}}];const html=f.html();assert.match(html,/href="\/availability"/);assert.match(html,/면접 전 가용일이 없어요/);assert.equal(f.button('변경 미리보기'),undefined);
});
test('route checks origin/role/strict input and passes only the authenticated owner to the service',async()=>{
 let role='student',originCalls=0;const calls:any[]=[];class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
 const module={exports:{} as any},code=ts.transpileModule(readFileSync('apps/web/src/app/api/training/review-placement/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const imports:any={'zod':{z},'@/lib/auth':{checkOrigin(){originCalls++;},requireUser:async()=>({id:'owner',role})},'@/lib/db':{ApiError,errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500})},'@/lib/planner-model':{validPlanDay},'@/lib/training-review-placement-store':{trainingReviewPlacement:async(...args:any[])=>{calls.push(args);return {suggestions:[]};}}};
 vm.runInNewContext(code,{module,exports:module.exports,Response,Request,JSON,require:(name:string)=>imports[name]});
 const send=(value:any)=>module.exports.POST(new Request('http://local/api/training/review-placement',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}));
 assert.equal((await module.exports.GET()).status,200);assert.equal(calls[0][0],'owner');
 assert.equal((await send({action:'preview',selection:{questionKey:'key',date:'2026-02-30'}})).status,400);
 assert.equal((await send({action:'apply',selection:{questionKey:'key',date:'2026-10-23'},fingerprint:'a'.repeat(64),studentId:'foreign'})).status,400);
 assert.equal(calls.length,1);assert.equal((await send({action:'apply',selection:{questionKey:'key',date:'2026-10-23'},fingerprint:'a'.repeat(64)})).status,200);assert.equal(calls[1][0],'owner');assert.equal(calls[1][2],'a'.repeat(64));assert.equal(originCalls,3);
 role='admin';assert.equal((await module.exports.GET()).status,403);assert.equal((await send({action:'preview',selection:{questionKey:'key',date:'2026-10-23'}})).status,403);assert.equal(calls.length,2);
});
