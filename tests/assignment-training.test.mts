import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(readFileSync('apps/web/src/components/practice.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const plan='7d68fe10-126f-49d2-bd76-464df4648278',otherPlan='958181c8-38db-414f-b76e-38ca4a0a2cff';
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):value==null||typeof value==='boolean'?'':String(value);
function harness(state='in_progress',defer=false){
 let owner='student-a',id='assignment-a',query=plan,cursor=0,dirty=true,tree:any,currentKey:any,refreshes=0,reloads=0,resolve!:(value:any)=>void;
 let hooks:any[]=[],effects:any[]=[],pending:Function[]=[];
 const storage=new Map<string,string>(),posts:any[]=[],pushes:string[]=[],writes:any[]=[],listeners=new Map<string,Function>();
 const assignment:any={id,title:'내 활동 다시 설명하기',state,content_version:1,items:[{memory_item_id:'item',question_id:'question',kind:'short_answer',category:'experiential',prompt:'내 역할은?',question_snapshot:{id:'question',prompt:'내 역할은?'}}]};
 const data:any={user:{id:owner},package:{active_version:1},targets:[],learning:{questions:[]}};
 const react={useCallback:(fn:Function)=>fn,useState(initial:any){const index=cursor++,instance=hooks;if(!(index in instance))instance[index]=initial;return [instance[index],(value:any)=>{instance[index]=typeof value==='function'?value(instance[index]):value;if(instance===hooks)dirty=true;}];},useRef(initial:any){return hooks[cursor++]??={current:initial};},useEffect(fn:Function,deps:any[]){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){effects[index]={deps};pending.push(()=>{previous?.cleanup?.();effects[index].cleanup=fn();});}}};
 const jsx={jsx:(type:any,props:any,key:any)=>({type,props,key}),jsxs:(type:any,props:any,key:any)=>({type,props,key})},module={exports:{} as any};
 vm.runInNewContext(source,{module,exports:module.exports,URLSearchParams,crypto:{randomUUID:()=> 'request'},sessionStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{writes.push({key,value});storage.set(key,value);},removeItem:(key:string)=>storage.delete(key)},window:{addEventListener:(name:string,fn:Function)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)},require(name:string){if(name==='@/lib/client/device-storage'||name==='./client/device-storage')return {setDeviceItem:(storage:any,key:string,value:string)=>storage.setItem(key,value),openDeviceDocumentScope:()=>({ready:Promise.resolve(),close(){}})};
   if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;
   if(name==='next/link')return {default:'Link'};
   if(name==='next/navigation')return {useRouter:()=>({push:(href:string)=>pushes.push(href)}),useSearchParams:()=>new URLSearchParams(query?{trainingPlanId:query}:{})};
   if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
   if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};
   if(name==='./app-shell')return {useApp:()=>({data,refresh:async()=>{refreshes++;}})};
   if(name==='./use-record-pages')return {useRecordPages(){throw Error('Unexpected assignment list');},useRecordDetail:()=>({item:assignment,loading:false,error:'',reload:async()=>{reloads++;assignment.state='submitted';dirty=true;}})};
   if(name==='./shared')return {PageTitle:'PageTitle',Breadcrumb:'Breadcrumb',Badge:'Badge',Empty:'Empty',Alert:'Alert',Spinner:'Spinner',InfoTip:'InfoTip',post:async(url:string,body:any)=>{posts.push({url,body});return defer?new Promise(yes=>{resolve=yes;}):{};}};
   if(name==='./learning-help')return {LearningHelp:'LearningHelp'};
   if(name==='./training-continuation')return {TrainingContinuation:'TrainingContinuation'};
   if(name==='@/lib/learning-navigation')return {learningRetryHref:()=>'/interview/new'};
   if(name==='@/lib/learning-growth')return {growthContextKey:()=>''};
   if(['./interview','./quiz-v3','./quiz-library'].includes(name))return {};
   throw Error(name);
 }});
 function render(){
   const route=module.exports.QuizPages({slug:['assignments',id]}),bound=route.type(route.props);
   if(currentKey!==bound.key){for(const effect of effects)effect?.cleanup?.();hooks=[];effects=[];pending=[];currentKey=bound.key;}
   cursor=0;tree=bound.type(bound.props);while(pending.length)pending.shift()!();return bound;
 }
 async function flush(){for(let i=0;i<12;i++){if(dirty){dirty=false;render();}await new Promise(yes=>setImmediate(yes));if(!dirty)return;}throw Error('Unexpected render loop');}
 return {assignment,data,storage,posts,pushes,writes,listeners,flush,render,get tree(){return tree;},get reloads(){return reloads;},get refreshes(){return refreshes;},setQuery(value:string){query=value;dirty=true;},setOwner(value:string){owner=value;data.user={id:value};dirty=true;},setId(value:string){id=value;assignment.id=value;dirty=true;},resolve(value={}){resolve(value);},unmount(){for(const effect of effects)effect?.cleanup?.();},button(label:string){return nodes(tree).find(node=>node.type==='button'&&text(node).includes(label));},response(){return nodes(tree).find(node=>node.type==='textarea');}};
}

test('a planned assignment retains its draft across plan query changes and separates each account and assignment',async()=>{
 const h=harness();await h.flush();h.response().props.onChange({target:{value:'내가 직접 측정했어요.'}});await h.flush();
 const first=h.render();assert.equal(first.props.trainingPlanId,plan);
 h.setQuery(otherPlan);await h.flush();assert.equal(h.render().key,first.key);assert.equal(h.response().props.value,'내가 직접 측정했어요.');
 assert.ok(nodes(h.tree).some(node=>node.props?.href==='/my/train?planId='+otherPlan));
 h.setOwner('student-b');await h.flush();assert.notEqual(h.render().key,first.key);assert.equal(h.response().props.value,'');
 assert.equal(h.writes.some(write=>write.key==='gakja-assignment:student-b:assignment-a'&&write.value.includes('직접 측정')),false);
 h.response().props.onChange({target:{value:'다른 계정 답변'}});await h.flush();h.setId('assignment-b');await h.flush();assert.equal(h.response().props.value,'');
});

test('only a submitted planned assignment exposes continuation; opening the page cannot complete a lesson',async()=>{
 for(const state of ['assigned','in_progress','submitted','reviewed','retry_due','completed']){
   const h=harness(state);await h.flush();const locked=['submitted','reviewed','retry_due','completed'].includes(state);
   assert.equal(nodes(h.tree).some(node=>node.type==='TrainingContinuation'&&node.props.planId===plan),locked);
   const rendered=nodes(h.tree);assert.equal(rendered.filter(node=>node.type==='TrainingContinuation').length,Number(locked));
   if(locked){const continuation=rendered.findIndex(node=>node.type==='TrainingContinuation');assert.ok(continuation>rendered.findIndex(node=>node.type==='PageTitle'));assert.ok(continuation<rendered.findIndex(node=>node.props?.className==='assignment-item'),'the next lesson is visible before the long submitted answer detail');}
   assert.equal(text(h.tree).includes('오늘 계획에서 진행 중'),!locked);assert.equal(h.posts.length,0);
 }
 const h=harness('submitted');h.setQuery('invalid-plan');await h.flush();assert.equal(nodes(h.tree).some(node=>node.type==='TrainingContinuation'),false);assert.ok(h.button('다시 말하기 과제'),'free practice retains its existing retry action');
});

test('the actual assignment submission remains the completion evidence and AI help keeps the same question',async()=>{
 const h=harness();await h.flush();h.response().props.onChange({target:{value:'내가 맡은 역할을 설명했어요.'}});await h.flush();
 const help=nodes(h.tree).find(node=>node.type==='LearningHelp');assert.equal(help.props.assignmentId,'assignment-a');assert.equal(help.props.questionId,'question');
 const rating=nodes(nodes(h.tree).find(node=>node.type==='label'&&text(node)==='도움 없이 가능해요')).find(node=>node.type==='input');
 assert.ok(rating);rating.props.onChange();await h.flush();assert.equal(h.button('과제 제출').props.disabled,false);
 h.button('과제 제출').props.onClick();await h.flush();assert.equal(h.posts.length,1);assert.equal(h.posts[0].body.action,'assignment_submit');
 assert.equal(h.posts[0].body.assignmentId,'assignment-a');assert.equal(h.posts[0].body.responses[0].response,'내가 맡은 역할을 설명했어요.');assert.equal(h.refreshes,1);
 assert.equal(h.storage.has('gakja-assignment:student-a:assignment-a'),false);assert.ok(nodes(h.tree).some(node=>node.type==='TrainingContinuation'));
});

test('an old account submission resolving after unmount cannot reload, clear its draft, or navigate the next account',async()=>{
 const h=harness('in_progress',true);await h.flush();h.response().props.onChange({target:{value:'아직 보관할 초안'}});await h.flush();
 const rating=nodes(h.tree).find(node=>node.type==='input'&&node.props.type==='radio');rating.props.onChange();await h.flush();h.button('과제 제출').props.onClick();await h.flush();
 h.unmount();h.resolve();await h.flush();assert.equal(h.reloads,0);assert.equal(h.refreshes,0);assert.equal(h.pushes.length,0);assert.ok(h.storage.get('gakja-assignment:student-a:assignment-a')?.includes('아직 보관할 초안'));
});
