import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Actual review-library hooks and links; API responses are in-memory fixtures.
const state={values:[],hook:0,effects:[],query:'',appTargetId:'current-school'};
const requests=[];
const module={exports:{}};
const source=fs.readFileSync(new URL('../apps/web/src/components/quiz-library.tsx',import.meta.url),'utf8');
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,URLSearchParams,AbortController,Set,Map,require(name){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if(name==='react')return {useState(initial){const index=state.hook++;if(!(index in state.values))state.values[index]=initial;return [state.values[index],value=>state.values[index]=typeof value==='function'?value(state.values[index]):value];},useEffect:callback=>state.effects.push(callback)};
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
  if(name==='next/link')return {__esModule:true,default:'Link'};
  if(name==='next/navigation')return {useSearchParams:()=>new URLSearchParams(state.query)};
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
  if(name==='./app-shell')return {useApp:()=>({targetId:state.appTargetId,data:{package:null,learning:{memory_items:[]}}})};
  if(name==='./shared')return {api:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),Alert:'Alert',Breadcrumb:'Breadcrumb',Empty:'Empty',PageTitle:'PageTitle',Spinner:'Spinner'};
  throw new Error('Unexpected import '+name);
}});
function render(values){if(values)state.values=values;state.hook=0;state.effects=[];return module.exports.QuizLibrary();}
function nodes(value){return Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];}
function text(value){return Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):String(value??'');}
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
function rows(tree){return nodes(tree).filter(node=>node.type==='Link'&&node.props.className==='training-memory-row');}
const target={id:'saved-school',university:'부산대학교',department:'건설융합학부'};
const common=Array.from({length:13},(_,index)=>({id:'common-memory-'+index,question_id:'common-question-'+index,prompt:'지원 동기를 설명해 주세요. '+index,source_kind:'common',common_revision:3,target_id:target.id}));
state.query='targetId=saved-school';
let tree=render();
check(nodes(tree).some(node=>node.type==='Spinner'),'first visit shows loading instead of a false zero-item empty state');
const cleanup=state.effects[0]();
check(requests.at(-1).url==='/api/quiz?targetId=saved-school','full library loads the explicit school instead of the global selected target');
requests.at(-1).resolve({contentVersion:0,target,library:{choice:[],answer:common}});
await new Promise(resolve=>setImmediate(resolve));
tree=render();
check(rows(tree).length===13,'all common Q&A entries remain reachable without a personal package or a six-question recommendation limit');
check(!nodes(tree).some(node=>node.type==='Empty'),'available common practice never becomes an empty personal-material screen');
check(text(tree).includes('부산대학교')&&text(tree).includes('건설융합학부'),'library shows its own school context');
for(const row of rows(tree)){
  const href=new URL(row.props.href,'http://localhost');
  check(href.pathname==='/quiz'&&href.searchParams.get('targetId')==='saved-school'&&href.searchParams.get('sourceType')==='common'&&href.searchParams.get('sourceVersion')==='3'&&href.searchParams.get('mode')==='answer','each common item opens the existing scoped Q&A flow');
}
check(!text(tree).includes('10초'),'untimed common Q&A is not incorrectly labeled with a ten-second timer');
check(nodes(tree).find(node=>node.type==='Breadcrumb').props.items[0].href==='/quiz?targetId=saved-school','return to quiz preserves the explicit school');
cleanup();

state.query='targetId=saved-school&sourceType=personal&sourceVersion=6';
const choice={id:'personal-memory',question_id:'concept:personal-memory',prompt:'알맞은 내용을 골라보세요.',kind:'choice'};
tree=render([{scope:state.query,contentVersion:6,target,library:{choice:[choice],answer:[{...choice,prompt:'내용을 설명해 주세요.'},...common]}},'','all',0]);
check(rows(tree).length===1,'choice and answer variants are deduplicated and an explicit personal library excludes common sources');
const personalHref=new URL(rows(tree)[0].props.href,'http://localhost');
check(personalHref.searchParams.get('sourceVersion')==='6'&&personalHref.searchParams.get('sourceType')==='personal'&&personalHref.searchParams.get('mode')==='choice','personal reviewed choice keeps its exact publication and mode');
check(text(rows(tree)[0]).includes(choice.prompt),'choice mode retains the choice prompt rather than its explanation variant');

state.query='targetId=saved-school&sourceType=common&sourceVersion=3';
tree=render([{scope:state.query,contentVersion:6,target,library:{choice:[choice],answer:[choice,...common]}},'','all',0]);
check(rows(tree).length===13,'explicit common revision never borrows the personal library');
state.query='targetId=other-school';
tree=render();
check(nodes(tree).some(node=>node.type==='Spinner')&&rows(tree).length===0,'changing schools hides the previous library before the effect runs');
const cleanupOld=state.effects[0](),oldRequest=requests.at(-1);cleanupOld();
state.query='targetId=latest-school';render();
const cleanupNew=state.effects[0](),newRequest=requests.at(-1);
newRequest.resolve({target:{id:'latest-school'},library:{choice:[],answer:[{...common[0],id:'latest-memory',target_id:'latest-school'}]}});
await new Promise(resolve=>setImmediate(resolve));
oldRequest.resolve({target,library:{choice:[],answer:common}});await new Promise(resolve=>setImmediate(resolve));
tree=render();
check(oldRequest.options.signal.aborted&&rows(tree).length===1&&rows(tree)[0].props.href.includes('targetId=latest-school'),'aborted late response cannot replace the newly selected school');
cleanupNew();
tree=render([null,'복습 자료를 불러오지 못했어요.','all',0]);
check(nodes(tree).some(node=>node.type==='Alert')&&nodes(tree).some(node=>node.type==='button'&&text(node)==='다시 불러오기'),'load failure exposes an explicit retry instead of hiding behind an empty library');
console.log(`Quiz library render, source scope and request races: ${checks} checks passed; external calls: 0.`);
