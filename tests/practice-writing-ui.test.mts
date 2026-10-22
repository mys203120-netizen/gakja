import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as writing from '../apps/web/src/lib/practice-writing';

const source=ts.transpileModule(readFileSync('apps/web/src/components/practice-writing-help.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
type Node={type:any;props:any};
function nodes(tree:any):Node[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];}
function text(tree:any):string{return Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null||typeof tree==='boolean'?'':String(tree);}
function harness(initial:Partial<{value:string;maxLength:number;rawTranscript:string;draftKey:string}>={}){
 const hooks:any[]=[],effects:Function[]=[],calls:any[]=[],storage=new Map<string,string>();let cursor=0,dirty=true,tree:any;
 const faults={storage:false,assistance:false};
 let props={value:'수정한 원문: 2번 시도했고, 성공하지는 못했습니다.',maxLength:12_000,rawTranscript:'원전사: 두 번 했고 성공 못했어요.',draftKey:'owned-draft:question:version',...initial,onApply(value:string){calls.push({kind:'apply',value,backup:storage.get(props.draftKey)});},async onAssisted(){calls.push({kind:'assisted'});if(faults.assistance)throw Error('도움 사용 기록 실패');}};
 const module={exports:{} as any};
 vm.runInNewContext(source,{module,exports:module.exports,localStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>{calls.push({kind:'storage',key,value});if(faults.storage)throw Error('Storage full');storage.set(key,value);}},require(id:string){if(id==='@/lib/client/device-storage'||id==='./client/device-storage')return {setDeviceItem:(storage:any,key:string,value:string)=>storage.setItem(key,value),openDeviceDocumentScope:()=>({ready:Promise.resolve(),close(){}})};if(id==='./owned-class-name'||id==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
  if(id==='react')return {useId:()=> 'practice-help',useState(initial:any){const slot=cursor++;if(!(slot in hooks))hooks[slot]=typeof initial==='function'?initial():initial;return [hooks[slot],(value:any)=>{const next=typeof value==='function'?value(hooks[slot]):value;if(!Object.is(next,hooks[slot])){hooks[slot]=next;dirty=true;}}];},useEffect(effect:Function,deps:any[]){const slot=cursor++,previous=hooks[slot];if(!previous||deps.some((value,index)=>!Object.is(value,previous.deps[index]))){hooks[slot]={deps,cleanup:previous?.cleanup};effects.push(()=>{hooks[slot].cleanup?.();hooks[slot].cleanup=effect();});}}};
  if(id==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
  if(id==='@/lib/practice-writing')return writing;
  if(id.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};throw Error('Unexpected import '+id);
 }});
 return {calls,storage,faults,get props(){return props;},get tree(){return tree;},setValue(value:string){props={...props,value};dirty=true;},async flush(){for(let i=0;i<15;i++){if(dirty){dirty=false;cursor=0;tree=module.exports.PracticeWritingHelp(props);while(effects.length)effects.shift()!();}await new Promise(done=>setImmediate(done));if(!dirty)return tree;}throw Error('Writing panel did not settle');},button(label:string){const matches=nodes(tree).filter(node=>node.type==='button'&&text(node)===label);assert.equal(matches.length,1,'One button '+label);return matches[0];},radios:()=>nodes(tree).filter(node=>node.type==='input'&&node.props.type==='radio'),confirm(){const control=nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox');assert.ok(control);control.props.onChange({target:{checked:true}});},sentence(value:string){const control=nodes(tree).find(node=>node.type==='textarea');assert.ok(control);control.props.onChange({target:{value}});}};
}
test('writing direction waits for student facts and confirmation; cancellation preserves the edited baseline',async()=>{
 const h=harness();await h.flush();h.button('답변이 막혀요').props.onClick();await h.flush();assert.equal(h.calls.filter(call=>call.kind==='assisted').length,1);assert.equal(h.button('내 연습용 초안에 적용').props.disabled,true);assert.equal(h.calls.filter(call=>call.kind==='apply').length,0);
 assert.equal(h.radios().length,4);h.radios()[0].props.onChange();await h.flush();h.sentence('제가 조사 순서를 정했습니다.');await h.flush();assert.equal(h.button('내 연습용 초안에 적용').props.disabled,true);h.button('취소 · 원문 유지').props.onClick();await h.flush();assert.equal(h.calls.filter(call=>call.kind==='apply').length,0);assert.equal(h.storage.size,0);assert.equal(h.props.value,'수정한 원문: 2번 시도했고, 성공하지는 못했습니다.');
});
test('direction applies only the student sentence and saves the edited baseline before onApply',async()=>{
 const h=harness(),before=h.props.value,raw=h.props.rawTranscript;await h.flush();h.button('답변이 막혀요').props.onClick();await h.flush();h.radios()[2].props.onChange();await h.flush();const sentence='제가 새로 확인한 조건은 세 가지입니다.';h.sentence(sentence);await h.flush();h.confirm();await h.flush();assert.equal(h.button('내 연습용 초안에 적용').props.disabled,false);h.button('내 연습용 초안에 적용').props.onClick();await h.flush();
 const apply=h.calls.find(call=>call.kind==='apply');assert.equal(apply.value,before+'\n\n'+sentence);assert.deepEqual(JSON.parse(apply.backup),{before,after:apply.value});assert.ok(h.calls.findIndex(call=>call.kind==='storage')<h.calls.findIndex(call=>call.kind==='apply'));assert.equal(h.props.rawTranscript,raw);
 h.setValue(apply.value);await h.flush();h.button('적용 전 초안으로 되돌리기').props.onClick();await h.flush();assert.equal(h.calls.filter(call=>call.kind==='apply').at(-1)?.value,before);
});
test('speaking layouts preserve the edited answer including numbers and negation rather than replacing it with raw STT',async()=>{
 const before='수정한 문장입니다. 2번 했지만, 성공하지는 못했습니다.',raw='원전사 완전히 다른 문장 3번 성공했습니다.',h=harness({value:before,rawTranscript:raw});await h.flush();h.button('말하기 좋게 다듬기').props.onClick();await h.flush();assert.equal(h.radios().length,3);h.radios()[0].props.onChange();await h.flush();h.confirm();await h.flush();h.button('내 연습용 초안에 적용').props.onClick();await h.flush();const apply=h.calls.find(call=>call.kind==='apply');assert.ok(writing.sameTranscriptWords(before,apply.value));assert.equal(apply.value.includes('3번'),false);assert.match(apply.value,/2번/);assert.match(apply.value,/성공하지는 못했습니다/);assert.equal(JSON.parse(apply.backup).before,before);assert.equal(h.props.rawTranscript,raw);
});
test('an externally changed answer cannot be overwritten by a stale open suggestion',async()=>{
 const h=harness();await h.flush();h.button('답변이 막혀요').props.onClick();await h.flush();h.radios()[0].props.onChange();await h.flush();h.sentence('새로 쓴 행동입니다.');await h.flush();h.confirm();await h.flush();h.setValue('다른 입력 경로에서 보완한 최신 초안');await h.flush();h.button('내 연습용 초안에 적용').props.onClick();await h.flush();assert.equal(h.calls.some(call=>call.kind==='apply'),false);assert.equal(h.storage.size,0);assert.match(text(h.tree),/작성한 글이 바뀌었어요/);assert.equal(h.props.value,'다른 입력 경로에서 보완한 최신 초안');
});
test('storage failure blocks replacement and a failed assistance record does not open a writing panel',async()=>{
 const h=harness();await h.flush();h.button('말하기 좋게 다듬기').props.onClick();await h.flush();h.radios()[1].props.onChange();await h.flush();h.confirm();await h.flush();h.faults.storage=true;h.button('내 연습용 초안에 적용').props.onClick();await h.flush();assert.equal(h.calls.some(call=>call.kind==='apply'),false);assert.match(text(h.tree),/기존 수정본을 보관하지 못해 적용하지 않았어요/);assert.equal(h.props.value,'수정한 원문: 2번 시도했고, 성공하지는 못했습니다.');
 const denied=harness();denied.faults.assistance=true;await denied.flush();denied.button('답변이 막혀요').props.onClick();await denied.flush();assert.equal(nodes(denied.tree).some(node=>node.type==='section'),false);assert.equal(denied.calls.some(call=>call.kind==='apply'),false);assert.match(text(denied.tree),/도움 사용 기록 실패/);
});
test('quiz assistance blocks 10,001 characters before backup or apply and accepts the exact 10,000-character boundary',async()=>{
 const before='가'.repeat(9990),h=harness({value:before,maxLength:10_000});await h.flush();h.button('답변이 막혀요').props.onClick();await h.flush();h.radios()[0].props.onChange();await h.flush();h.sentence('나'.repeat(9));await h.flush();h.confirm();await h.flush();
 assert.equal(h.button('내 연습용 초안에 적용').props.disabled,true);assert.match(text(h.tree),/10,001자예요.*10,000자까지 저장.*1자를 줄여/);assert.equal(h.props.value,before);
 h.button('내 연습용 초안에 적용').props.onClick();await h.flush();assert.equal(h.calls.some(call=>call.kind==='storage'||call.kind==='apply'),false,'even a stale/programmatic click must check before backup or replacement');
 h.sentence('나'.repeat(8));await h.flush();h.confirm();await h.flush();assert.equal(h.button('내 연습용 초안에 적용').props.disabled,false);h.button('내 연습용 초안에 적용').props.onClick();await h.flush();const apply=h.calls.find(call=>call.kind==='apply');assert.equal(apply.value.length,10_000);assert.equal(JSON.parse(apply.backup).before,before);
});
test('speaking changes respect the target limit even when polite endings increase a valid answer by one character',async()=>{
 const before='가'.repeat(9996)+'했어요.',h=harness({value:before,maxLength:10_000});assert.equal(before.length,10_000);await h.flush();h.button('말하기 좋게 다듬기').props.onClick();await h.flush();h.radios()[1].props.onChange();await h.flush();h.confirm();await h.flush();assert.equal(h.button('내 연습용 초안에 적용').props.disabled,true);assert.match(text(h.tree),/10,001자예요/);h.button('내 연습용 초안에 적용').props.onClick();await h.flush();assert.equal(h.calls.some(call=>call.kind==='storage'||call.kind==='apply'),false);assert.equal(h.props.value,before);
 const interview=harness({value:before,maxLength:12_000});await interview.flush();interview.button('말하기 좋게 다듬기').props.onClick();await interview.flush();interview.radios()[1].props.onChange();await interview.flush();interview.confirm();await interview.flush();assert.equal(interview.button('내 연습용 초안에 적용').props.disabled,false);interview.button('내 연습용 초안에 적용').props.onClick();await interview.flush();assert.equal(interview.calls.find(call=>call.kind==='apply').value.length,10_001);
});
