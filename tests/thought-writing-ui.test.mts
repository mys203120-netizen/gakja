import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync('apps/web/src/components/thought-writing.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const nodes=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const text=(tree:any):string=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);
function harness(){
 const states:any[]=[],refs:any[]=[],effects:any[]=[],queue:Function[]=[],calls:any[]=[],applied:any[]=[];let index=0,ref=0,effect=0,dirty=true,tree:any;
 const state={gate:null as Promise<any>|null,cleared:false};
 const props:any={userId:'student',kind:'experience',scopeId:randomUUID(),scopeKey:'field-a',field:'situation',value:'수질 기록 비교',onApply:(value:string,receipt:any)=>{applied.push({value,receipt});props.value=value;dirty=true;}};
 const jsx=(type:any,props:any)=>({type:type==='ActionButton'?'button':type,props});const module={exports:{} as any};
 vm.runInNewContext(code,{module,exports:module.exports,JSON,AbortController,crypto:{randomUUID},require:(name:string)=>{
  if(name==='react')return {useState:(initial:any)=>{const current=index++;if(!(current in states))states[current]=initial;return [states[current],(value:any)=>{states[current]=typeof value==='function'?value(states[current]):value;dirty=true;}];},useRef:(initial:any)=>refs[ref++]??={current:initial},useEffect:(callback:Function,deps:any[])=>{const current=effect++,previous=effects[current];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))queue.push(()=>{previous?.cleanup?.();effects[current]={deps,cleanup:callback()};});}};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='lucide-react')return new Proxy({},{get:(_,name)=>String(name)});
  if(name==='@/lib/client/device-storage')return {assertDeviceDocumentCurrent:()=>{if(state.cleared)throw Error('Device data cleared');}};
  if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,name)=>String(name)})};
  if(name==='./shared')return {Modal:'Modal',Alert:'Alert',ActionButton:'ActionButton',api:async(path:string,options:any)=>{const input=JSON.parse(options.body);calls.push({path,input,signal:options.signal});return state.gate?await state.gate:{requestId:input.requestId,proposal:{draft:'수질 기록을 비교했습니다.',followup_question:'어떤 기준을 사용했나요?',support_quotes:['수질 기록 비교']}};}};
  throw Error(name);
 }});
 function render(){index=0;ref=0;effect=0;tree=module.exports.ThoughtWriting(props);return tree;}
 async function flush(){for(let i=0;i<20;i++){if(dirty){dirty=false;render();while(queue.length)queue.shift()!();}await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;}throw Error('Did not settle');}
 function button(label:string){const found=nodes(tree).find(item=>item.type==='button'&&text(item)===label);assert.ok(found,'button '+label);return found;}
 return {state,props,applied,calls,flush,button,get tree(){return tree;},change(value:any){Object.assign(props,value);dirty=true;},cleanup(){effects.forEach(item=>item?.cleanup?.());}};
}
test('writing proposals are explicitly generated, editable, applied and undoable without replacing input beforehand',async()=>{
 const h=harness();await h.flush();assert.equal(h.calls.length,0);h.button('문장 정리').props.onClick();await h.flush();assert.equal(h.calls.length,0);h.button('문장으로 정리').props.onClick();await h.flush();assert.equal(h.calls.length,1);assert.equal(h.applied.length,0);assert.equal(h.props.value,'수질 기록 비교');
 nodes(h.tree).find(item=>item.type==='textarea'&&item.props['aria-label']==='정리한 문장').props.onChange({target:{value:'기록을 같은 기준으로 비교했습니다.'}});await h.flush();h.button('확인하고 적용').props.onClick();await h.flush();assert.equal(h.applied[0].value,'기록을 같은 기준으로 비교했습니다.');assert.equal(h.applied[0].receipt.original,'수질 기록 비교');h.button('원문으로').props.onClick();await h.flush();assert.equal(h.applied[1].value,'수질 기록 비교');assert.equal(h.applied[1].receipt.undo,true);h.cleanup();
});
test('one follow-up uses only the student reply and cancelling preserves the source',async()=>{
 const h=harness();await h.flush();h.button('문장 정리').props.onClick();await h.flush();h.button('문장으로 정리').props.onClick();await h.flush();
 assert.equal(nodes(h.tree).filter(item=>item.type==='textarea'&&item.props['aria-label']==='꼬리질문에 답하기').length,1);
 nodes(h.tree).find(item=>item.type==='textarea'&&item.props['aria-label']==='꼬리질문에 답하기').props.onChange({target:{value:'측정 시간을 맞춤'}});await h.flush();h.button('이 내용도 반영하기').props.onClick();await h.flush();assert.deepEqual(h.calls[1].input.history,[{question:'어떤 기준을 사용했나요?',answer:'측정 시간을 맞춤'}]);assert.equal(h.applied.length,0);h.button('취소').props.onClick();await h.flush();assert.equal(h.props.value,'수질 기록 비교');assert.equal(nodes(h.tree).some(item=>item.type==='Modal'),false);h.cleanup();
});
test('scope changes, stops and late replies cannot change another input or revive cleared device text',async()=>{
 for(const action of ['scope','stop','source'] as const){
  const h=harness();await h.flush();h.button('문장 정리').props.onClick();await h.flush();let finish!:(value:any)=>void;h.state.gate=new Promise(resolve=>finish=resolve);h.button('문장으로 정리').props.onClick();await h.flush();
  if(action==='scope')h.change({scopeKey:'field-b',value:'다른 경험'});else if(action==='source')h.change({value:'새로 직접 쓴 원문'});else h.button('정리 멈추기').props.onClick();await h.flush();
  assert.equal(h.calls[0].signal.aborted,true);finish({proposal:{draft:'늦은 문장',followup_question:null},requestId:h.calls[0].input.requestId});await h.flush();assert.equal(h.applied.length,0);assert.equal(nodes(h.tree).some(item=>item.type==='textarea'&&item.props.value==='늦은 문장'),false);h.cleanup();
 }
 const cleared=harness();await cleared.flush();cleared.button('문장 정리').props.onClick();await cleared.flush();cleared.button('문장으로 정리').props.onClick();await cleared.flush();cleared.state.cleared=true;cleared.button('확인하고 적용').props.onClick();await cleared.flush();assert.equal(cleared.applied.length,0);assert.match(text(cleared.tree),/Device data cleared/);cleared.cleanup();
});
test('a saved original can be restored after the proposal component is remounted',async()=>{
 const h=harness();h.change({value:'정리된 문단',savedOriginal:'원래 키워드'});await h.flush();h.button('원문으로').props.onClick();await h.flush();assert.equal(h.applied[0].value,'원래 키워드');assert.equal(h.applied[0].receipt.undo,true);h.cleanup();
});
