import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {learningTargetIdentityMatches} from '../packages/content-contracts/src/workflows';

const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):value==null?'':String(value);
const fixture=(title:string)=>({contentVersion:1,library:{choice:[{id:'quiz',question_id:'question'}]},sessions:[],recommendation:{reason:title}});

test('quiz library and session creation reject stale school, publication and account responses',async()=>{
 const hooks:any[]=[],effects:any[]=[],pending:Function[]=[],reads:any[]=[],creates:any[]=[],pushes:string[]=[];
 let cursor=0,dirty=true,tree:any,school='a',student='one',version=1;
 const react={useCallback:(fn:Function)=>fn,useState(initial:any){const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],(value:any)=>{hooks[index]=typeof value==='function'?value(hooks[index]):value;dirty=true;}];},useRef(initial:any){return hooks[cursor++]??={current:initial};},useEffect(fn:Function,deps:any[]){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){effects[index]={deps};pending.push(()=>{previous?.cleanup?.();effects[index].cleanup=fn();});}}};
 const module={exports:{} as any};
 vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/quiz-v3.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,AbortController,URLSearchParams,require(name:string){
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
  if(name==='next/navigation')return {useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:(href:string)=>pushes.push(href)})};
  if(name==='./app-shell')return {useApp:()=>({targetId:school,data:{user:{id:student},package:{id:'package',active_version:version},targets:[{id:school,university:'대학 '+school,department:'학과'}]}})};
  if(name==='./shared')return {api:(url:string,options:any)=>new Promise(resolve=>reads.push({url,options,resolve})),post:(url:string,body:any)=>new Promise(resolve=>creates.push({url,body,resolve})),ActionButton:'ActionButton',Spinner:'Spinner',Alert:'Alert',PageTitle:'PageTitle'};
  if(name==='./owned-class-name')return {ownedClassName:(value:string)=>value};
  if(name==='@gakja/content-contracts/workflows')return {learningTargetIdentityMatches};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
  return new Proxy({},{get:(_,key)=>String(key)});
 }});
 function render(){dirty=false;cursor=0;tree=module.exports.QuizHome();}
 async function flush(){for(let index=0;index<10;index++){if(dirty)render();while(pending.length)pending.shift()!();await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;}throw Error('render loop');}
 const start=()=>nodes(tree).find(node=>node.type==='ActionButton');
 await flush();const first=reads[0];school='b';dirty=true;await flush();assert.equal(first.options.signal.aborted,true);
 reads[1].resolve(fixture('current school'));await flush();first.resolve(fixture('old school'));await flush();assert.ok(text(tree).includes('current school'));assert.ok(!text(tree).includes('old school'));
 start().props.onClick();await flush();assert.equal(creates[0].body.targetId,'b');
 version++;dirty=true;render();assert.equal(start(),undefined,'a new publication hides the old library before effects');await flush();
 reads[2].resolve(fixture('new publication'));await flush();creates[0].resolve({session:{id:'old-publication-session'}});await flush();assert.deepEqual(pushes,[]);
 start().props.onClick();await flush();const prior=creates[1];student='two';dirty=true;await flush();reads[3].resolve(fixture('new account'));await flush();prior.resolve({session:{id:'old-account-session'}});await flush();assert.deepEqual(pushes,[]);
 start().props.onClick();await flush();creates[2].resolve({session:{id:'current-session'}});await flush();assert.deepEqual(pushes,['/quiz/session/current-session']);
});
