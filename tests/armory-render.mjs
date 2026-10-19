import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';

const model=await tsImport('../apps/web/src/lib/armory-model.ts',import.meta.url);
const flow=await tsImport('../apps/web/src/lib/interview-flow.ts',import.meta.url);
const support=await tsImport('../apps/web/src/lib/school-interview-scope.ts',import.meta.url);
const draftsModel=await tsImport('../apps/web/src/lib/armory-drafts.ts',import.meta.url);
const recommendations=await tsImport('../apps/web/src/lib/armory-recommendations.ts',import.meta.url);
const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/armory.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const confirmed={id:'confirmed-card',revision:4,updated_at:'2026-10-18',data:{title:'내가 정리한 자료',category:'협업',situation:'형식이 달랐다',action:'공통 양식을 만들었다',result:'팀이 함께 사용했다',confirmed:true,pinned:true,sourceNote:'직접 작성'}};
const draft={id:'draft-card',revision:2,updated_at:'2026-10-18',data:{...confirmed.data,title:'작성 중인 경험',situation:'',action:'',result:'',confirmed:false,pinned:false}};
const common={id:'common-question',prompt:'협업에서 맡은 역할을 말해보세요.',common_revision:8};
const personal={id:'published-question',prompt:'자료를 정리할 때 어떤 기준을 세웠나요?',activity_ids:['activity']};
let checks=0;
const equal=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
const text=node=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):React.Children.toArray(node.props?.children).map(text).join('');
function elements(node,condition){if(!React.isValidElement(node))return [];return [...(condition(node)?[node]:[]),...React.Children.toArray(node.props.children).flatMap(child=>elements(child,condition))];}

function harness({unsupported=false,cardId='',legacyDraft=null,durableDrafts=[],remoteDrafts=[],localWriteError=false,remoteWriteError=false}={}){
 const target={id:'target',university:unsupported?'고려대학교':'서울시립대학교',department:unsupported?'경영학과':'환경공학부',admission_year:2027,admission_type:unsupported?'고른기회':'면접형'};
 const app={targetId:target.id,data:{user:{id:'student'},targets:[target],package:{active_version:7},learning:{activities:[]},interviews:[]}};
 let cards=structuredClone([confirmed,draft]),params=new URLSearchParams(cardId?{card:cardId}:{}),cursor=0,dirty=true,tree;
 const hooks=[],pending=[],requests=[],saved=[],storage=new Map(),durableStorage=new Map(),serverDrafts=new Map(),timers=new Map();let timerId=0;
 if(legacyDraft)storage.set('armory-draft:student',JSON.stringify(legacyDraft));
 const durableAdapter={getItem:key=>durableStorage.get(key)||null,setItem:(key,value)=>durableStorage.set(key,value),removeItem:key=>durableStorage.delete(key)};
 for(const item of durableDrafts)draftsModel.writeExperienceDraft(durableAdapter,'student',item);
 for(const item of remoteDrafts)serverDrafts.set(item.id,structuredClone(item));
 const react={...React,
  useState(initial){const index=cursor++;if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;return [hooks[index],value=>{const next=typeof value==='function'?value(hooks[index]):value;if(!Object.is(next,hooks[index])){hooks[index]=next;dirty=true;}}];},
  useRef(initial){const index=cursor++;return hooks[index]??=( {current:initial} );},
  useEffect(effect,deps){const index=cursor++,previous=hooks[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){hooks[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{hooks[index].cleanup?.();hooks[index].cleanup=effect();});}},
 };
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,URLSearchParams,crypto:{randomUUID},setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id),window:{addEventListener(){},removeEventListener(){}},localStorage:{getItem:key=>durableStorage.get(key)||null,setItem:(key,value)=>{if(localWriteError)throw Error('Storage unavailable');durableStorage.set(key,value);},removeItem:key=>durableStorage.delete(key)},sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},require(name){
  if(name==='react/jsx-runtime')return jsx;
  if(name==='react')return react;
  if(name==='next/link')return {__esModule:true,default:({href,children,...props})=>React.createElement('a',{href,...props},children)};
  if(name==='next/navigation')return {useSearchParams:()=>params,useRouter:()=>({replace(url){params=new URL(url,'http://local').searchParams;dirty=true;}})};
  if(name==='lucide-react')return icons;
  if(name==='./app-shell')return {useApp:()=>app};
  if(name==='@/lib/armory-model')return model;
  if(name==='@/lib/armory-drafts')return draftsModel;
  if(name==='@/lib/armory-recommendations')return recommendations;
  if(name==='@/lib/interview-flow')return flow;
  if(name==='@/lib/school-interview-scope')return support;
  if(name==='./armory-assist')return {ArmoryAssist:()=>null};
  if(name==='./experience-text-classifier')return {ExperienceTextClassifier:()=>null};
  if(name==='./shared')return {PageTitle:({title,children})=>React.createElement('header',null,React.createElement('h1',null,title),children),Alert:({children})=>React.createElement('div',{role:'alert'},children),api:async(url,options)=>{
   requests.push(url);
   if(url==='/api/armory'&&!options)return {cards:structuredClone(cards),sessions:[]};
   if(url==='/api/armory/drafts'&&!options)return {drafts:[...serverDrafts.values()]};
   if(url==='/api/armory/drafts'&&options?.method==='PUT'){if(remoteWriteError)throw Error('Server unavailable');const input=JSON.parse(options.body),previous=serverDrafts.get(input.id);input.draft=model.experienceDraftSchema.parse(input.draft);if(input.serverRevision!==(previous?.serverRevision||0))throw Error('다른 화면에서 초안이 바뀌었어요.');const result={...input,serverRevision:input.serverRevision+1};serverDrafts.set(input.id,result);return {draft:result};}
   if(url==='/api/armory'&&options?.method==='POST'){const input=JSON.parse(options.body);input.data=model.experienceSaveSchema.parse(input.data);saved.push(input);const card={...input,revision:input.revision+1,updated_at:'2026-10-18'};cards=[card,...cards.filter(item=>item.id!==card.id)];serverDrafts.delete(input.id);return {card};}
   if(url.startsWith('/api/interviews?'))return {sourceKind:unsupported?'personal':'common',contentVersion:7,practiceScope:unsupported?'personal_record':'school',questions:unsupported?[personal,common]:[common]};
   throw Error('Unexpected request: '+url);
  }};
  if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
  throw Error('Unexpected import: '+name);
 }});
 async function flush(){for(let tick=0;tick<12;tick++){if(dirty){dirty=false;cursor=0;tree=module.exports.Armory();while(pending.length)pending.shift()();}await new Promise(resolve=>setImmediate(resolve));if(!dirty)return tree;}throw Error('Render did not settle');}
 function button(label){const matches=elements(tree,node=>node.type==='button'&&text(node)===label);assert.equal(matches.length,1,'One action: '+label);return matches[0];}
 function card(id){return elements(tree,node=>node.type==='button'&&node.props.className==='card').find(node=>text(node).includes(id==='confirmed-card'?confirmed.data.title:draft.data.title));}
 function tab(label){return elements(tree,node=>node.type==='button'&&node.props['aria-pressed']!==undefined&&text(node)===label)[0];}
 function question(){return elements(tree,node=>node.type==='input'&&node.props.name==='armory-question')[0];}
 function links(){return elements(tree,node=>typeof node.props.href==='string'&&node.props.href.startsWith('/interview/new?')).map(node=>new URL(node.props.href,'http://local'));}
 return {flush,button,card,tab,question,links,requests,saved,storage,durableStorage,serverDrafts,async runTimers(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(callback=>callback());await new Promise(resolve=>setImmediate(resolve));return flush();},markup:()=>renderToStaticMarkup(tree),get tree(){return tree;}};
}

const commonView=harness();await commonView.flush();
equal(new URL(commonView.requests.find(url=>url.startsWith('/api/interviews?')),'http://local').searchParams.get('sourceType'),'common');
commonView.card('confirmed-card').props.onClick();await commonView.flush();equal(commonView.tab('면접에 활용').props['aria-pressed'],true);
commonView.question().props.onChange();await commonView.flush();
equal(commonView.links().map(url=>[url.searchParams.get('kind'),url.searchParams.get('sourceType'),url.searchParams.get('sourceVersion'),url.searchParams.get('experienceCardId'),url.searchParams.get('experienceRevision'),url.searchParams.get('targetId')]),[['chat','common','8','confirmed-card','4','target'],['video','common','8','confirmed-card','4','target']]);

const personalView=harness({unsupported:true});await personalView.flush();
equal(new URL(personalView.requests.find(url=>url.startsWith('/api/interviews?')),'http://local').searchParams.get('sourceType'),'personal');
personalView.card('confirmed-card').props.onClick();await personalView.flush();
equal(elements(personalView.tree,node=>node.type==='input'&&node.props.name==='armory-question').map(node=>node.props.value),['published-question']);
personalView.question().props.onChange();await personalView.flush();
equal(personalView.links().map(url=>[url.searchParams.get('questionId'),url.searchParams.get('sourceType'),url.searchParams.get('sourceVersion')]),[['published-question','personal','7'],['published-question','personal','7']]);
assert.match(personalView.markup(),/선택한 전형의 실제 면접을 재현하지 않아요/);checks++;

const directDraft=harness({cardId:'draft-card'});await directDraft.flush();equal(directDraft.tab('내 이야기').props['aria-pressed'],true);
directDraft.tab('면접에 활용').props.onClick();await directDraft.flush();equal(directDraft.tab('면접에 활용').props['aria-pressed'],true);equal(directDraft.links().length,0);
directDraft.tab('내 이야기').props.onClick();await directDraft.flush();directDraft.button('이야기 보완하기').props.onClick();await directDraft.flush();
equal(elements(directDraft.tree,node=>node.type==='h2').map(text),['어떤 일이 있었나요?']);equal(elements(directDraft.tree,node=>node.type==='h1').length,0);
const entryMarkup=directDraft.markup(),tools=elements(directDraft.tree,node=>node.type==='details'&&node.props.className==='editorTools')[0];equal(Boolean(tools.props.open),false);assert.ok(entryMarkup.indexOf('<textarea')<entryMarkup.indexOf('>다음'));assert.ok(entryMarkup.indexOf('>다음')<entryMarkup.indexOf('제목·유형 및 작성 도구'));checks++;
directDraft.button('다음').props.onClick();await directDraft.flush();assert.match(directDraft.markup(),/어떤 상황이었는지 한 문장만 적어주세요/);checks++;
elements(directDraft.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'팀의 기록 형식이 달랐다'}});await directDraft.flush();directDraft.button('다음').props.onClick();await directDraft.flush();
elements(directDraft.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'공통 양식을 제안했다'}});await directDraft.flush();directDraft.button('두 문장 확인하기').props.onClick();await directDraft.flush();equal(elements(directDraft.tree,node=>node.type==='h2').map(text),['두 문장을 확인해 주세요']);equal(Boolean(elements(directDraft.tree,node=>node.type==='details'&&node.props.className==='optionalResult')[0].props.open),false);directDraft.button('이전').props.onClick();await directDraft.flush();equal(elements(directDraft.tree,node=>node.type==='textarea')[0].props.value,'공통 양식을 제안했다');directDraft.button('두 문장 확인하기').props.onClick();await directDraft.flush();directDraft.button('내 경험 확인하고 저장').props.onClick();await directDraft.flush();
equal(directDraft.saved.map(input=>[input.id,input.revision,input.data.confirmed,input.data.situation,input.data.action]),[['draft-card',2,true,'팀의 기록 형식이 달랐다','공통 양식을 제안했다']]);
equal(directDraft.tab('면접에 활용').props['aria-pressed'],true);

const recovery=harness({legacyDraft:{draft:{...draft.data,title:'',situation:'복구 전에도 남아야 하는 원문'},draftId:'legacy-card',revision:0,step:0}});await recovery.flush();assert.equal(recovery.storage.has('armory-draft:student'),false);checks++;
recovery.button('주제 없이 직접 적기').props.onClick();await recovery.flush();elements(recovery.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'새 카드에만 쓴 상황'}});await recovery.flush();assert.doesNotMatch(recovery.markup(),/자동 저장됨/);checks++;await recovery.runTimers();
assert.match(recovery.markup(),/자동 저장됨 · \d{2}:\d{2}/);checks++;recovery.button('초안 보관하고 목록으로').props.onClick();await recovery.flush();assert.match(recovery.markup(),/복구 전에도 남아야 하는 원문/);checks++;assert.match(recovery.markup(),/새 카드에만 쓴 상황/);checks++;
equal([...recovery.durableStorage.keys()].filter(key=>key.startsWith('armory-drafts:v2:student:')).length,2);equal(recovery.serverDrafts.size,1);
const untitled=JSON.parse([...recovery.durableStorage.entries()].find(([key,value])=>key.startsWith('armory-drafts:v2:student:')&&JSON.parse(value).draft.situation==='새 카드에만 쓴 상황')[1]);
const reloaded=harness({durableDrafts:[untitled],remoteDrafts:[...recovery.serverDrafts.values()]});await reloaded.flush();assert.match(reloaded.markup(),/새 카드에만 쓴 상황/);checks++;
elements(reloaded.tree,node=>node.type==='button'&&text(node).includes('새 카드에만 쓴 상황'))[0].props.onClick();await reloaded.flush();equal(elements(reloaded.tree,node=>node.type==='input'&&node.props.maxLength===120)[0].props.value,'');reloaded.button('초안 저장 후 나가기').props.onClick();await reloaded.flush();equal(reloaded.saved[0].data.title,'협업 경험');equal(reloaded.saved[0].data.situation,'새 카드에만 쓴 상황');

const localConflict={id:'new-conflict',draft:{...draft.data,title:'',situation:'이 기기의 상황',action:'이 기기의 행동'},revision:0,step:1,serverRevision:1,updatedAt:'2026-10-19T00:00:00.000Z'},remoteConflict={...localConflict,draft:{...localConflict.draft,action:'서버의 최신 행동'},serverRevision:3};
const conflicting=harness({durableDrafts:[localConflict],remoteDrafts:[remoteConflict]});await conflicting.flush();elements(conflicting.tree,node=>node.type==='button'&&text(node).includes('이 기기의 행동'))[0].props.onClick();await conflicting.flush();await conflicting.runTimers();assert.match(conflicting.markup(),/초안의 버전이 달라요/);checks++;
equal(elements(conflicting.tree,node=>node.type==='textarea'&&node.props.readOnly).map(node=>node.props.value).some(value=>value.includes('서버의 최신 행동')),true);equal([...conflicting.durableStorage.keys()].filter(key=>key.startsWith('armory-draft-backups:v1:student:')).length,2);
conflicting.button('이 기기 초안으로 계속').props.onClick();await conflicting.flush();await conflicting.runTimers();equal(conflicting.serverDrafts.get(localConflict.id).serverRevision,4);equal(conflicting.serverDrafts.get(localConflict.id).draft.action,'이 기기의 행동');
conflicting.button('초안 보관하고 목록으로').props.onClick();await conflicting.flush();assert.match(conflicting.markup(),/비교한 버전 보관함/);checks++;

const staleSource={...localConflict,id:confirmed.id,revision:3},staleRemote={...remoteConflict,id:confirmed.id,revision:3};const sourceConflict=harness({durableDrafts:[staleSource],remoteDrafts:[staleRemote]});await sourceConflict.flush();elements(sourceConflict.tree,node=>node.type==='button'&&text(node).includes('이 기기의 행동'))[0].props.onClick();await sourceConflict.flush();await sourceConflict.runTimers();equal(sourceConflict.button('이 기기 초안으로 계속').props.disabled,true);equal(sourceConflict.button('서버 초안으로 계속').props.disabled,true);sourceConflict.button('이 기기 글을 새 경험으로').props.onClick();await sourceConflict.flush();await sourceConflict.runTimers();const copied=[...sourceConflict.serverDrafts.values()].find(item=>item.id!==confirmed.id);equal(copied.draft.action,'이 기기의 행동');equal(copied.revision,0);equal(sourceConflict.serverDrafts.get(confirmed.id).draft.action,'서버의 최신 행동');
// Closing the editor must leave a durable copy even when browser storage is unavailable.
for(const localWriteError of [false,true]){const editedCard=harness({cardId:'confirmed-card',localWriteError});await editedCard.flush();editedCard.tab('내 이야기').props.onClick();await editedCard.flush();editedCard.button('이야기 보완하기').props.onClick();await editedCard.flush();elements(editedCard.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'카드 상세에서 바꾼 상황'}});await editedCard.flush();editedCard.button('초안 보관하고 목록으로').props.onClick();await editedCard.flush();equal(elements(editedCard.tree,node=>node.type==='section'&&node.props['aria-labelledby']==='my-experiences-title').length,1);equal(elements(editedCard.tree,node=>node.type==='section'&&node.props['aria-labelledby']==='experience-title').length,0);const savedDraftList=elements(editedCard.tree,node=>node.type==='section'&&node.props['aria-label']==='작성 중인 경험 초안')[0];elements(savedDraftList,node=>node.type==='button')[0].props.onClick();await editedCard.flush();equal(elements(editedCard.tree,node=>node.type==='textarea')[0].props.value,'카드 상세에서 바꾼 상황');}
const serverOnly=harness({localWriteError:true});await serverOnly.flush();serverOnly.button('주제 없이 직접 적기').props.onClick();await serverOnly.flush();elements(serverOnly.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'이 기기에 저장할 수 없는 상황'}});await serverOnly.flush();serverOnly.button('초안 보관하고 목록으로').props.onClick();await serverOnly.flush();equal(elements(serverOnly.tree,node=>node.type==='section'&&node.props['aria-label']==='경험 카드 만들기').length,0);equal(serverOnly.serverDrafts.size,1);equal([...serverOnly.serverDrafts.values()][0].draft.situation,'이 기기에 저장할 수 없는 상황');
const serverOnlyReload=harness({remoteDrafts:[...serverOnly.serverDrafts.values()]});await serverOnlyReload.flush();assert.match(serverOnlyReload.markup(),/이 기기에 저장할 수 없는 상황/);checks++;
const noStorage=harness({localWriteError:true,remoteWriteError:true});await noStorage.flush();noStorage.button('주제 없이 직접 적기').props.onClick();await noStorage.flush();elements(noStorage.tree,node=>node.type==='textarea')[0].props.onChange({target:{value:'저장 실패 후에도 반드시 남을 문장'}});await noStorage.flush();noStorage.button('초안 보관하고 목록으로').props.onClick();await noStorage.flush();equal(elements(noStorage.tree,node=>node.type==='textarea')[0].props.value,'저장 실패 후에도 반드시 남을 문장');assert.match(noStorage.markup(),/초안을 보관하지 못했어요/);checks++;equal(elements(noStorage.tree,node=>node.type==='section'&&node.props['aria-label']==='경험 카드 만들기').length,1);

// Restoring another draft starts with its own step and validation, including legacy result steps.
const legacyResult={...localConflict,id:'legacy-result',serverRevision:0,step:2,draft:{...localConflict.draft,result:'기존에 정리한 배운 점'}},stepRecovery=harness({durableDrafts:[legacyResult]});await stepRecovery.flush();stepRecovery.button('주제 없이 직접 적기').props.onClick();await stepRecovery.flush();stepRecovery.button('다음').props.onClick();await stepRecovery.flush();assert.match(stepRecovery.markup(),/어떤 상황이었는지 한 문장만 적어주세요/);checks++;stepRecovery.button('초안 보관하고 목록으로').props.onClick();await stepRecovery.flush();elements(stepRecovery.tree,node=>node.type==='button'&&text(node).includes('이 기기의 행동'))[0].props.onClick();await stepRecovery.flush();assert.doesNotMatch(stepRecovery.markup(),/어떤 상황이었는지 한 문장만 적어주세요/);checks++;equal(elements(stepRecovery.tree,node=>node.type==='textarea')[0].props.value,'기존에 정리한 배운 점');stepRecovery.button('확인하기').props.onClick();await stepRecovery.flush();equal(elements(stepRecovery.tree,node=>node.type==='details'&&node.props.className==='optionalResult')[0].props.open,true);stepRecovery.button('내 경험 확인하고 저장').props.onClick();await stepRecovery.flush();equal(stepRecovery.saved[0].data.result,'기존에 정리한 배운 점');

equal([...commonView.requests,...personalView.requests,...directDraft.requests].some(url=>url.includes('/assist')),false);
console.log(`Armory render: ${checks} interaction checks passed (draft deep link, confirmation, owned card revision, actual question source/version, personal-only fallback, no automatic AI request).`);
