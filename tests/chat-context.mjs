import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Exercise the production selection functions and component without a browser,
// database, provider key, or paid AI call. Effects can only use the GET adapter.
// The production SSE reader consumes real Response/ReadableStream instances.
const source=fs.readFileSync(new URL('../apps/web/src/components/chat.tsx',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const streamSource=fs.readFileSync(new URL('../apps/web/src/lib/assistant-stream-model.ts',import.meta.url),'utf8');
const streamModule={exports:{}};
vm.runInNewContext(ts.transpileModule(streamSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:streamModule,exports:streamModule.exports,TextDecoder,JSON,Object});
const deltaModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/lib/assistant-delta-buffer.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:deltaModule,exports:deltaModule.exports});
const state={values:[],hook:0,refs:[],refHook:0,effects:[],effectDependencies:[],mountedEffects:[],params:new URLSearchParams(),pathname:'/on',data:null,calls:[],resources:[],storage:new Map(),sendCalls:[],fetchAdapter:null,apiAdapter:null,refreshAdapter:null,navigations:[],routerNavigations:[],refreshes:0,requestNumber:0,timers:new Map(),timerNumber:0};
const module={exports:{}};
const personal={id:'personal-question',prompt:'맡은 역할을 설명해 주세요.',support_target_ids:['school-owned'],activity_ids:['activity-owned']};
const common={id:'common_motivation',prompt:'지원 동기를 설명해 주세요.',source_type:'general_practice'};
const currentData={user:{id:'synthetic-chat-student',name:'테스트'},package:{active_version:5},targets:[{id:'school-owned',university:'지원 학교'},{id:'school-other',university:'다른 학교'}],learning:{questions:[personal],activities:[],source_refs:[]},answers:[],threads:[]};
vm.runInNewContext(output,{module,exports:module.exports,URLSearchParams,Set,JSON,Number,Boolean,AbortController,FormData,requestAnimationFrame:callback=>{callback();return 1;},cancelAnimationFrame:()=>{},setTimeout:callback=>{const id=++state.timerNumber;state.timers.set(id,callback);return id;},clearTimeout:id=>state.timers.delete(id),window:{history:{replaceState(_state,_title,url){const location=new URL(url,'http://local');state.pathname=location.pathname;state.params=location.searchParams;state.navigations.push(url);}}},crypto:{randomUUID:()=>{if(!state.fetchAdapter)throw new Error('Rendering must not send a message');return`synthetic-request-${++state.requestNumber}`;}},fetch:async(url,options)=>{if(!state.fetchAdapter)throw new Error('No automatic AI request is allowed');const call={url,method:options?.method,payload:JSON.parse(options?.body||'{}'),headers:options?.headers,signal:options?.signal};state.sendCalls.push(call);return state.fetchAdapter(call);},sessionStorage:{getItem:key=>state.storage.get(key)||null,setItem:(key,value)=>state.storage.set(key,value),removeItem:key=>state.storage.delete(key)},require(name){
 if(name==='react')return{useState(initial){const index=state.hook++;if(!(index in state.values))state.values[index]=initial;return[state.values[index],value=>{state.values[index]=typeof value==='function'?value(state.values[index]):value;}];},useRef(value){const index=state.refHook++;if(!(index in state.refs))state.refs[index]={current:value};return state.refs[index];},useEffect(callback,dependencies){state.effects.push(callback);state.effectDependencies.push(dependencies);}};
 if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
 if(name==='next/link')return{__esModule:true,default:'Link'};
 if(name==='next/navigation')return{useRouter:()=>({push:()=>{throw new Error('Rendering must not navigate');},replace:url=>{if(!state.fetchAdapter)throw new Error('Rendering must not navigate');state.routerNavigations.push(url);state.navigations.push(url);}}),useSearchParams:()=>state.params,usePathname:()=>state.pathname};
 if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
 if(name==='./shared')return{api:async(url,options)=>{const call={method:options?.method||'GET',url,options};if(call.method!=='GET'&&!state.apiAdapter)throw new Error('No automatic mutation is allowed');state.calls.push(call);return state.apiAdapter?state.apiAdapter(call):state.previewResult;},post:()=>{throw new Error('Unexpected legacy JSON send');},action:()=>{throw new Error('No automatic save is allowed');},PageTitle:'PageTitle',Breadcrumb:'Breadcrumb',Alert:'Alert',Logo:'Logo',targetName:target=>target?.university||'지원처 미등록',targetMajor:target=>target?.department||''};
 if(name==='./app-shell')return{useApp:()=>({data:state.data,targetId:'school-other',target:state.data.targets.find(item=>item.id==='school-other'),refresh:()=>{if(!state.fetchAdapter)throw new Error('No automatic refresh is needed');state.refreshes++;return state.refreshAdapter?state.refreshAdapter():Promise.resolve();},toast:()=>{},openResource:resource=>state.resources.push(resource)})};
 if(name==='./interview')return{InterviewSetup:'InterviewSetup',InterviewSession:'InterviewSession'};
 if(name==='./chat-composer')return{ChatComposer:'ChatComposer'};
 if(name==='./chat-history')return{ChatHistory:'ChatHistory'};
 if(name==='@/lib/assistant-stream-model')return streamModule.exports;
 if(name==='@/lib/assistant-delta-buffer')return deltaModule.exports;
 if(name==='./markdown-message')return{MarkdownMessage:'MarkdownMessage'};
 if(name.endsWith('.css'))return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
 throw new Error(`Unexpected import: ${name}`);
}});
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return[];return[tree,...nodes(tree.props?.children)];}
function textContent(value){if(Array.isArray(value))return value.map(textContent).join('');if(typeof value==='string'||typeof value==='number')return String(value);return value&&typeof value==='object'?textContent(value.props?.children):'';}
function plain(value){return JSON.parse(JSON.stringify(value));}
function render({params='',pathname,data=currentData,values=[],threadId,preserveRefs=false}={}){state.pathname=pathname??(threadId?`/on/${threadId}`:preserveRefs?state.pathname:'/on');state.params=new URLSearchParams(params);state.data=data;state.values=values;state.hook=0;state.refHook=0;if(!preserveRefs){state.refs=[];state.mountedEffects=[];}state.effects=[];state.effectDependencies=[];const page=module.exports.ChatPages({slug:threadId?[threadId]:[]});return page.type(page.props);}
function repaint(options){return render({...options,values:state.values,preserveRefs:true});}
function flushDeltaTimers(){const callbacks=[...state.timers.values()];state.timers.clear();for(const callback of callbacks)callback();}
function commitEffects(){state.effects.forEach((callback,index)=>{const dependencies=state.effectDependencies[index],previous=state.mountedEffects[index];if(previous&&dependencies&&previous.dependencies&&dependencies.length===previous.dependencies.length&&dependencies.every((value,i)=>Object.is(value,previous.dependencies[i])))return;previous?.cleanup?.();state.mountedEffects[index]={dependencies,cleanup:callback()};});}
function turn(){return new Promise(resolve=>setImmediate(resolve));}
async function settleEffects(options){for(let i=0;i<3;i++){repaint(options);commitEffects();await turn();}return repaint(options);}
function jsonResponse(result,status=200){return new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json'}});}
function streamResponse(){let controller;const body=new ReadableStream({start(value){controller=value;}});return{response:new Response(body,{headers:{'Content-Type':'text/event-stream'}}),event(event){const bytes=new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));},close(){controller.close();},error(error){controller.error(error);}};}

const selected=module.exports.chatSelection(new URLSearchParams('questionId=personal-question'),currentData,'school-other');
check(selected.targetId==='school-owned','a selected personal question chooses a supported owned school instead of the global selection');
const oldThread={id:'thread-owned',target_id:'school-owned',content_version:2,context:{questionId:'old-question',activityId:'old-activity',briefingId:'old-briefing'}};
const pinned=module.exports.chatSelection(new URLSearchParams('questionId=unrelated&activityId=unrelated&targetId=school-other&sourceVersion=5'),currentData,'school-other',oldThread);
assert.deepEqual(plain(pinned),{questionId:'old-question',activityId:'old-activity',briefingId:'old-briefing',targetId:'school-owned',sourceVersion:2});checks++;
const assisted={session:{id:'interview-owned',target_id:'school-owned',supportTarget:currentData.targets[0],state:'active',data:{context:{sourceKind:'common',questionId:'common_motivation',contentVersion:'1',targetId:'school-owned'}}},question:{rootQuestionId:'common_motivation'}};
const assistedSelection=module.exports.chatSelection(new URLSearchParams('sessionId=interview-owned'),{...currentData,package:null},'school-other',null,assisted);
check(assistedSelection.questionId==='common_motivation'&&assistedSelection.sourceVersion===1&&assistedSelection.targetId==='school-owned','a paused common interview supplies its own question, school and revision without a published package');
const mixedCommonSelection=module.exports.chatSelection(new URLSearchParams('sessionId=interview-owned&sourceVersion=6'),currentData,'school-other',null,{...assisted,session:{...assisted.session,content_version:6,data:{context:{...assisted.session.data.context,contentVersion:'6',questions:[{id:'common_motivation',common_revision:1}]}}}});check(mixedCommonSelection.sourceVersion===1&&mixedCommonSelection.sourceType==='common','a common-bank revision is separate from the interview personal-book version');
const briefingSelection=module.exports.chatSelection(new URLSearchParams('sessionId=interview-owned&briefingId=briefing-owned'),{...currentData,package:null},'school-other',null,{...assisted,question:{rootQuestionId:'briefing_generated_question'},session:{...assisted.session,data:{context:{...assisted.session.data.context,questionId:null,briefingId:'briefing-owned'}}}});
check(!briefingSelection.questionId&&briefingSelection.briefingId==='briefing-owned','a generated briefing question is not sent as an approved personal question ID');
const completedReply={role:'assistant',status:'completed',content:'연결한 질문의 근거를 확인해 보세요.'};
check(module.exports.chatReplyAssisted(completedReply,assistedSelection,assistedSelection),'an actual completed response for the paused question counts as AI assistance');
for(const status of ['pending','failed']){check(!module.exports.chatReplyAssisted({...completedReply,status,content:''},assistedSelection,assistedSelection),`empty ${status} responses are not visible help`);check(module.exports.chatReplyAssisted({...completedReply,status,content:'원문에서 역할을 확인'},assistedSelection,assistedSelection),`visible ${status} partial text is help even without completion`);}
check(!module.exports.chatReplyAssisted(completedReply,{...assistedSelection,questionId:'different-question'},assistedSelection),'an unrelated completed thread cannot mark the paused question as assisted');
check(!module.exports.chatReplyAssisted({...completedReply,content:''},assistedSelection,assistedSelection),'a blank completed response cannot count as help');
const keys=new Set([module.exports.chatDraftKey('student-a',undefined,{questionId:'q',targetId:'t',sourceVersion:2},'session-a'),module.exports.chatDraftKey('student-b',undefined,{questionId:'q',targetId:'t',sourceVersion:2},'session-a'),module.exports.chatDraftKey('student-a',undefined,{questionId:'q',targetId:'t',sourceVersion:3},'session-a'),module.exports.chatDraftKey('student-a',undefined,{questionId:'q',targetId:'other',sourceVersion:2},'session-a'),module.exports.chatDraftKey('student-a',undefined,{questionId:'q',targetId:'t',sourceVersion:2},'session-b'),module.exports.chatDraftKey('student-a',undefined,{questionId:'q',activityId:'activity',targetId:'t',sourceVersion:2},'session-a')]);
check(keys.size===6,'drafts are isolated by user, revision, school, paused session and activity');
check(module.exports.canSaveChatCandidate(currentData,selected,5),'a current personal question permits explicitly saving a completed candidate');
check(!module.exports.canSaveChatCandidate(currentData,selected,2),'an old version cannot overwrite the current personal answer');
check(!module.exports.canSaveChatCandidate(currentData,{questionId:common.id,targetId:'school-owned'},1),'a common question cannot become a personal answer candidate');
check(!module.exports.canSaveChatCandidate(currentData,{questionId:personal.id,targetId:'school-other'},5),'a mismatched school cannot receive the candidate');

let tree=render({params:'questionId=common_motivation&targetId=school-owned',data:{...currentData,package:null}});
check(nodes(tree).find(node=>node.type==='ChatComposer').props.disabled,'a selected question is unavailable until its owned preview is loaded');
check(!nodes(tree).some(node=>node.type==='button'&&(node.props.children==='핸드북'||Array.isArray(node.props.children)&&node.props.children.includes('가이드북'))),'a pending historical or common preview does not open unrelated current documents');
check(state.calls.length===0,'rendering does not make any provider request');
state.previewResult={learning:{questions:[common],activities:[],source_refs:[]},documents:[],contentVersion:'1'};
for(const effect of state.effects)effect();
await Promise.resolve();await Promise.resolve();
check(state.calls.length===2&&state.calls.every(call=>call.method==='GET')&&state.calls.some(call=>call.url==='/api/chat')&&state.calls.some(call=>call.url==='/api/learning-help?questionId=common_motivation&targetId=school-owned'),'mounting a common-question page reads only its owned evidence and lightweight conversation list');
const commonSelection={questionId:common.id,targetId:'school-owned',sourceVersion:1},commonKey=module.exports.chatDraftKey(currentData.user.id,undefined,commonSelection,null);
const commonValues=[];commonValues[9]=commonKey;commonValues[11]=state.previewResult;commonValues[12]='questionId=common_motivation&targetId=school-owned';
tree=render({params:'questionId=common_motivation&targetId=school-owned',data:{...currentData,package:null},values:commonValues});
check(!nodes(tree).find(node=>node.type==='ChatComposer').props.disabled,'a loaded common question enables the composer without personal content publication');
check(nodes(tree).some(node=>node.type==='h2'&&node.props.children===common.prompt),'the same common question is visible before writing');
const onward=nodes(tree).find(node=>node.type==='PageTitle').props.aside.props.href;
const onwardQuery=new URL(onward,'http://local').searchParams;
check(onwardQuery.get('questionId')===common.id&&onwardQuery.get('targetId')==='school-owned'&&onwardQuery.get('sourceVersion')==='1'&&onwardQuery.get('count')==='1','continuing into an interview preserves question, school, revision and one-question practice');
nodes(tree).find(node=>node.type==='button'&&node.props.children==='질문 근거').props.onClick();
check(state.resources.at(-1).snapshot.learning.questions[0].id===common.id&&state.resources.at(-1).snapshot.documents.length===0,'common evidence opens the loaded snapshot without borrowing unrelated personal documents');
const concept={...personal,question_types:['concept']};
const conceptValues=[];conceptValues[9]=module.exports.chatDraftKey(currentData.user.id,undefined,{questionId:concept.id,targetId:'school-owned',sourceVersion:5},null);conceptValues[11]={learning:{questions:[concept],activities:[],source_refs:[]},documents:[],contentVersion:'5'};conceptValues[12]='questionId=personal-question&targetId=school-owned';
tree=render({params:'questionId=personal-question',values:conceptValues});
check(nodes(tree).some(node=>node.type==='button'&&Array.isArray(node.props.children)&&node.props.children.includes('이 질문이 무엇을 묻는지 확인하고 싶어')),'concept practice starts with the concept rather than an invented personal role');

const threadValues=[];threadValues[0]=[{id:'pending-message',role:'assistant',content:'',status:'pending'}];threadValues[1]={...oldThread,resources:{learning:{questions:[{id:'old-question',prompt:'이전 질문'}],activities:[],source_refs:[]},documents:[]}};threadValues[4]=false;threadValues[9]=module.exports.chatDraftKey(currentData.user.id,oldThread.id,pinned,null);
tree=render({params:'questionId=unrelated&targetId=school-other&sourceVersion=5',values:threadValues,threadId:oldThread.id});
check(nodes(tree).find(node=>node.type==='ChatComposer').props.disabled,'an outstanding response blocks a duplicate send');
check(nodes(tree).some(node=>node.type==='button'&&node.props.children==='대화 다시 불러오기'),'an outstanding response has an explicit reload action');
check(!nodes(tree).some(node=>node.props?.className==='message-save'),'pending or historical answers never offer current answer overwrite');
threadValues[0]=[{id:'failed-message',role:'assistant',content:'',status:'failed',data:{error:'응답이 중단됐어요.'}}];
tree=render({values:threadValues,threadId:oldThread.id});
check(nodes(tree).some(node=>node.props?.className==='message-content'&&textContent(node)==='응답이 중단됐어요.'),'failed responses expose their recovery message instead of an empty bubble');
check(state.calls.length===2,'all component renders keep paid AI calls at zero');

// A recommendation uses exactly the same guarded submission as typed text.
// A deferred local adapter verifies double clicks without using any provider.
let finishSend;
state.fetchAdapter=()=>new Promise(resolve=>{finishSend=resolve;});
tree=render({params:'questionId=common_motivation&targetId=school-owned',data:{...currentData,package:null},values:commonValues.slice()});
const recommendation=nodes(tree).find(node=>node.type==='button'&&Array.isArray(node.props.children)&&node.props.children.includes('이 질문에 답할 때 필요한 근거를 찾아줘'));
recommendation.props.onClick();
check(state.sendCalls.length===1&&state.sendCalls[0].payload.message==='이 질문에 답할 때 필요한 근거를 찾아줘','clicking a recommendation immediately submits its own text without a second send');
check(state.sendCalls[0].payload.questionId===common.id&&state.sendCalls[0].payload.targetId==='school-owned'&&state.sendCalls[0].payload.sourceVersion===1,'recommendations keep the owned question, school and pinned source revision');
recommendation.props.onClick();
check(state.sendCalls.length===1,'a double click cannot send a duplicate recommendation while its first request is pending');
check(state.values[2]==='이 질문에 답할 때 필요한 근거를 찾아줘','a recommendation is retained as the in-flight draft');
finishSend(jsonResponse({threadId:'suggestion-thread',userMessage:{id:'suggestion-user',role:'user',content:'이 질문에 답할 때 필요한 근거를 찾아줘'},message:{id:'suggestion-answer',role:'assistant',status:'completed',content:'## 필요한 근거\n\n1. **본인 역할**을 확인하세요.'}}));
await new Promise(resolve=>setImmediate(resolve));
check(state.values[2]===''&&state.values[0].length===2,'a completed suggestion clears the draft and replaces optimistic content with saved messages');
check(state.navigations[0]==='/on/suggestion-thread','a new suggestion thread follows the existing saved-thread navigation');

state.fetchAdapter=()=>Promise.reject(new Error('추천 전송 실패'));
tree=render({params:'questionId=common_motivation&targetId=school-owned',data:{...currentData,package:null},values:commonValues.slice()});
const failedRecommendation=nodes(tree).find(node=>node.type==='button'&&Array.isArray(node.props.children)&&node.props.children.includes('이 질문에 답할 때 필요한 근거를 찾아줘'));
failedRecommendation.props.onClick();
await new Promise(resolve=>setImmediate(resolve));
const failedRequest=state.sendCalls.at(-1).payload.requestId;
check(state.values[2]==='이 질문에 답할 때 필요한 근거를 찾아줘'&&state.values[5]==='추천 전송 실패','a failed recommendation exposes the error and keeps its text for retry');
check(state.values[0].length===0,'a transport failure removes the optimistic user message');
failedRecommendation.props.onClick();
await new Promise(resolve=>setImmediate(resolve));
check(state.sendCalls.at(-1).payload.requestId===failedRequest,'retrying an unchanged recommendation preserves its idempotency key');

const savedValues=[];savedValues[0]=[{id:'markdown-answer',role:'assistant',status:'completed',content:'## 제목\n\n**근거**'}];savedValues[1]={...oldThread,resources:{learning:{questions:[],activities:[],source_refs:[]},documents:[]}};savedValues[4]=false;savedValues[9]=module.exports.chatDraftKey(currentData.user.id,oldThread.id,pinned,null);
tree=render({params:'questionId=unrelated&targetId=school-other&sourceVersion=5',values:savedValues,threadId:oldThread.id});
check(nodes(tree).some(node=>node.type==='MarkdownMessage'&&node.props.content==='## 제목\n\n**근거**'),'assistant content reaches the Markdown renderer without flattening its syntax');

// Real incremental transport, not a completed-response replay. Rendering between
// each independently supplied server event verifies what the user can see while
// the stream is still open. Every event splits Korean UTF-8 bytes across chunks.
const streamOptions={params:'questionId=common_motivation&targetId=school-owned',data:{...currentData,package:null}};
const file={id:'owned-attachment',name:'탐구 기록.md',size:1200,url:'/api/chat/attachments/owned-attachment'};
const streamValues=commonValues.slice();streamValues[16]=[file];
const live=streamResponse();state.fetchAdapter=()=>live.response;
state.navigations=[];state.refreshes=0;
tree=render({...streamOptions,values:streamValues});
const composer=nodes(tree).find(node=>node.type==='ChatComposer');
const streamedSend=composer.props.onSend('첨부한 탐구의 비교 조건을 알려줘');
const call=state.sendCalls.at(-1);
check(call.url==='/api/chat'&&call.method==='POST'&&call.headers['Content-Type']==='application/json','the production sender uses the chat POST endpoint and JSON transport');
check(call.payload.stream===true&&call.signal instanceof AbortSignal&&!call.signal.aborted,'the request opts into live SSE and supplies an abortable signal');
assert.deepEqual(call.payload.attachmentIds,[file.id]);checks++;
check(call.payload.questionId===common.id&&call.payload.targetId==='school-owned'&&call.payload.sourceVersion===1&&typeof call.payload.requestId==='string','typed messages pin the same owned learning context and idempotency key as recommendations');
check(state.values[0].length===1&&state.values[0][0].role==='user'&&state.values[0][0].content===call.payload.message,'typed text appears optimistically without waiting for AI completion');
await turn();
const userMessage={id:'live-user',role:'user',content:call.payload.message,attachments:[file]};
live.event({type:'start',threadId:'live-thread',assistantId:'live-answer',userMessage});
await turn();
tree=repaint(streamOptions);
check(state.values[0].length===2&&state.values[0][0].id==='live-user'&&state.values[0][1].status==='pending','the start event replaces the optimistic message with its saved receipt and creates one pending AI reply');
check(nodes(tree).some(node=>node.props?.className==='typing-dots'&&node.props['aria-label']==='응답 작성 중'),'an empty pending reply displays a writing indicator');
check(nodes(tree).some(node=>node.type==='a'&&node.props.href===file.url&&node.props.children.includes(file.name)),'the saved user message retains its attached source');
const sendsBeforeDoubleClick=state.sendCalls.length;
await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('중복 전송');
check(state.sendCalls.length===sendsBeforeDoubleClick,'a re-rendered composer also blocks duplicate sends during a live reply');
live.event({type:'delta',delta:'## 비교 조건\n\n'});
await turn();
check(state.values[0][1].content===''&&state.timers.size===1,'an arriving delta is batched instead of re-rendering every split token');
flushDeltaTimers();
tree=repaint(streamOptions);
check(nodes(tree).some(node=>node.type==='MarkdownMessage'&&node.props.content==='## 비교 조건\n\n'),'the first Korean Markdown delta is rendered while the provider stream remains open');
check(nodes(tree).some(node=>node.props?.className==='chat-stream-cursor')&&nodes(tree).find(node=>node.type==='ChatComposer').props.busy,'a streamed partial reply keeps its writing cursor and busy composer');
check(state.navigations.length===0&&state.refreshes===0&&state.values[15]==='','partial deltas do not navigate, refresh or announce a completed reply');
live.event({type:'delta',delta:'1. **시료**를 같은 양으로 준비해요. 😀'});
await turn();flushDeltaTimers();
tree=repaint(streamOptions);
const fullContent='## 비교 조건\n\n1. **시료**를 같은 양으로 준비해요. 😀';
check(nodes(tree).some(node=>node.type==='MarkdownMessage'&&node.props.content===fullContent),'multiple split UTF-8 deltas append exactly once and preserve Markdown and emoji');
check(state.values[16].length===1,'attached sources remain queued until a completed server receipt');
const doneMessage={id:'live-answer',role:'assistant',status:'completed',content:fullContent,data:{sources:[{id:common.id,type:'question',title:'연결한 질문'}]}};
live.event({type:'done',threadId:'live-thread',userMessage,message:doneMessage,contextChanged:true});
live.close();await streamedSend;
tree=repaint(streamOptions);
check(state.values[0].length===2&&state.values[0][1].status==='completed'&&state.values[0][1].content===fullContent,'completion replaces the partial AI message with the persisted final answer without duplicates');
check(state.values[2]===''&&state.values[16].length===0&&!state.storage.has(commonKey),'successful completion clears the draft and only then releases the attachment queue');
check(state.values[6]===true&&state.values[15]==='AI 비서 답변이 도착했어요.','the final receipt applies context changes and supplies a concise completion announcement');
check(!nodes(tree).some(node=>node.props?.className==='chat-stream-cursor')&&!nodes(tree).find(node=>node.type==='ChatComposer').props.busy,'the final reply removes its live cursor and unlocks the composer');
check(state.navigations[0]==='/on/live-thread'&&state.refreshes===0&&state.routerNavigations.length===0,'a newly persisted live conversation adopts its canonical URL without router replacement or bootstrap refresh');
nodes(tree).find(node=>node.type==='button'&&textContent(node)==='연결한 질문').props.onClick();
check(state.resources.at(-1).kind==='question'&&state.resources.at(-1).id===common.id,'streamed source chips open the same learning evidence as saved replies');

// The stop button aborts the actual transport and keeps readable partial text.
const stoppedStream=streamResponse();
state.fetchAdapter=call=>{call.signal.addEventListener('abort',()=>stoppedStream.error(new DOMException('Aborted','AbortError')),{once:true});return stoppedStream.response;};
tree=render({...streamOptions,values:commonValues.slice()});
const interruptedSend=nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('발표 내용을 다듬어줘');
const interruptedCall=state.sendCalls.at(-1);
await turn();stoppedStream.event({type:'start',threadId:'stopped-thread',assistantId:'stopped-answer',userMessage:{id:'stopped-user',role:'user',content:interruptedCall.payload.message}});
stoppedStream.event({type:'delta',delta:'**비교 조건**을 먼저 '});await turn();
tree=repaint(streamOptions);
const stopButton=nodes(nodes(tree).find(node=>node.type==='ChatComposer').props.actions).find(node=>node.type==='button'&&textContent(node)==='응답 멈추기');
check(Boolean(stopButton),'an active stream exposes an explicit stop action');
stopButton.props.onClick();await interruptedSend;
tree=repaint(streamOptions);
check(interruptedCall.signal.aborted&&state.values[0][1].status==='failed'&&state.values[0][1].content==='**비교 조건**을 먼저 ','aborting the stream marks only the incomplete AI reply failed and retains its readable partial Markdown');
check(state.values[5]==='응답을 멈췄어요. 대화에서 다시 이어갈 수 있어요.'&&state.values[2]==='발표 내용을 다듬어줘','stopping gives an actionable recovery notice and keeps the unchanged draft');
check(nodes(tree).some(node=>node.props?.className==='chat-interrupted-note')&&!nodes(tree).some(node=>node.props?.className==='chat-stream-cursor'),'interrupted partial content shows its recovery note without a misleading writing cursor');
check(state.values[15]===''&&state.navigations.at(-1)==='/on/stopped-thread','a stopped new conversation remains accessible and is never announced as a completed answer');
const stoppedDraftKey=module.exports.chatDraftKey(currentData.user.id,'stopped-thread',commonSelection,null);
const stoppedDraft=JSON.parse(state.storage.get(stoppedDraftKey));
check(stoppedDraft.draft==='발표 내용을 다듬어줘'&&stoppedDraft.requestId===''&&stoppedDraft.requestText==='','navigation after an explicit stop migrates its draft while releasing the stopped request identity');
tree=await settleEffects({...streamOptions,params:'',pathname:'/on/stopped-thread'});
state.fetchAdapter=()=>jsonResponse({threadId:'stopped-thread',userMessage:{id:'retry-stopped-user',role:'user',content:'발표 내용을 다듬어줘'},message:{id:'retry-stopped-answer',role:'assistant',status:'completed',content:'비교 조건을 먼저 설명해요.'}});
await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('발표 내용을 다듬어줘');
check(state.sendCalls.at(-1).payload.requestId!==interruptedCall.payload.requestId,'resending unchanged text after an explicit stop receives a fresh request identity');

const rejectedStream=streamResponse();state.fetchAdapter=()=>rejectedStream.response;
tree=render({...streamOptions,values:commonValues.slice()});
const rejectedSend=nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('응답 오류 뒤에도 다시 질문해요');
const rejectedCall=state.sendCalls.at(-1);await turn();
rejectedStream.event({type:'start',threadId:'failed-thread',assistantId:'failed-answer',userMessage:{id:'failed-user',role:'user',content:rejectedCall.payload.message}});
rejectedStream.event({type:'error',error:'응답 생성 실패'});rejectedStream.close();await rejectedSend;
tree=repaint(streamOptions);
check(state.values[5]==='응답 생성 실패'&&state.values[0][1].status==='failed'&&state.values[15]==='','an explicit SSE failure shows its notice, marks the reply failed and does not announce completion');
const rejectedDraft=JSON.parse(state.storage.get(module.exports.chatDraftKey(currentData.user.id,'failed-thread',commonSelection,null)));
check(rejectedDraft.draft===rejectedCall.payload.message&&rejectedDraft.requestId==='','a confirmed server failure preserves the text and resets the failed request identity');
tree=await settleEffects({...streamOptions,params:'',pathname:'/on/failed-thread'});
state.fetchAdapter=()=>jsonResponse({threadId:'failed-thread',userMessage:{id:'retry-user',role:'user',content:rejectedCall.payload.message},message:{id:'retry-answer',role:'assistant',status:'completed',content:'새 응답'}});
await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend(rejectedCall.payload.message);
check(state.sendCalls.at(-1).payload.requestId!==rejectedCall.payload.requestId,'an identical-text retry after a confirmed failure starts a new generation instead of retrieving the permanently failed one');

const disconnected=streamResponse();state.fetchAdapter=()=>disconnected.response;
tree=render({...streamOptions,values:commonValues.slice()});
const disconnectedSend=nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('네트워크가 끊겨도 중복 생성하지 않아요');
const disconnectedCall=state.sendCalls.at(-1);await turn();
disconnected.event({type:'start',threadId:'disconnected-thread',assistantId:'disconnected-answer',userMessage:{id:'disconnected-user',role:'user',content:disconnectedCall.payload.message}});
disconnected.event({type:'delta',delta:'일부 답변'});await turn();
disconnected.error(new Error('네트워크 연결 종료'));await disconnectedSend;tree=repaint(streamOptions);
check(state.values[0][1].content==='일부 답변'&&state.values[0][1].status==='failed'&&state.values[5]==='네트워크 연결 종료','an unconfirmed connection loss keeps readable partial content and exposes its recovery notice');
const disconnectedDraft=JSON.parse(state.storage.get(module.exports.chatDraftKey(currentData.user.id,'disconnected-thread',commonSelection,null)));
check(disconnectedDraft.requestId===disconnectedCall.payload.requestId&&disconnectedDraft.requestText===disconnectedCall.payload.message,'an ambiguous transport loss preserves the original idempotency receipt for reconciliation');
tree=await settleEffects({...streamOptions,params:'',pathname:'/on/disconnected-thread'});
state.fetchAdapter=()=>jsonResponse({threadId:'disconnected-thread',userMessage:{id:'disconnected-user',role:'user',content:disconnectedCall.payload.message},message:{id:'disconnected-answer',role:'assistant',status:'completed',content:'서버에 이미 저장된 응답'}});
await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend(disconnectedCall.payload.message);
check(state.sendCalls.at(-1).payload.requestId===disconnectedCall.payload.requestId,'an unchanged retry after an ambiguous transport loss reuses its original receipt rather than creating another AI generation');
check(state.values[0].filter(item=>item.id==='disconnected-answer').length===1&&state.values[0].find(item=>item.id==='disconnected-answer').status==='completed','reconciling the saved receipt replaces partial content without duplicating the assistant message');

// Navigation may occur while a browser has already queued an old server frame.
// Commit the real cleanup, then deliberately continue feeding the stale stream.
const abandoned=streamResponse();state.fetchAdapter=()=>abandoned.response;
state.previewResult=commonValues[11];state.storage.clear();state.navigations=[];state.refreshes=0;
tree=render({...streamOptions,values:commonValues.slice()});commitEffects();await turn();
tree=repaint(streamOptions);commitEffects();await turn();
tree=repaint(streamOptions);commitEffects();await turn();
tree=repaint(streamOptions);
check(!nodes(tree).find(node=>node.type==='ChatComposer').props.disabled,'the real mounted effects settle the owned preview and draft before submission');
const abandonedSend=nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('옛 질문의 답변');
const abandonedCall=state.sendCalls.at(-1);await turn();
abandoned.event({type:'start',threadId:'abandoned-thread',assistantId:'abandoned-answer',userMessage:{id:'abandoned-user',role:'user',content:'옛 질문의 답변'}});
abandoned.event({type:'delta',delta:'이전 질문의 일부'});await turn();
const newOptions={...streamOptions,pathname:'/on',params:'questionId=common_future&targetId=school-owned'};
state.previewResult={...commonValues[11],learning:{questions:[{...common,id:'common_future',prompt:'새 질문'}],activities:[],source_refs:[]}};
tree=repaint(newOptions);commitEffects();await turn();
tree=repaint(newOptions);commitEffects();await turn();
tree=repaint(newOptions);commitEffects();await turn();
tree=repaint(newOptions);
check(abandonedCall.signal.aborted&&!nodes(tree).find(node=>node.type==='ChatComposer').props.busy,'a same-page question change executes the real stream cleanup, aborts the old request and releases busy state');
const newSnapshot=plain(state.values),navigationsBeforeStale=state.navigations.length,refreshesBeforeStale=state.refreshes;
abandoned.event({type:'delta',delta:'새 화면에 섞이면 안 됨'});
abandoned.event({type:'done',threadId:'abandoned-thread',userMessage:{id:'abandoned-user',role:'user',content:'옛 질문의 답변'},message:{id:'abandoned-answer',role:'assistant',status:'completed',content:'옛 답변 완료'}});
abandoned.close();await abandonedSend;
assert.deepEqual(plain(state.values),newSnapshot);checks++;
check(state.navigations.length===navigationsBeforeStale&&state.refreshes===refreshesBeforeStale,'late completion from an abandoned question neither refreshes nor opens its old conversation');
check(!state.storage.has(module.exports.chatDraftKey(currentData.user.id,'abandoned-thread',commonSelection,null)),'abandoned stream completion cannot migrate or overwrite a new-context draft');

// Finalization must unlock the visible conversation immediately. The small
// history-list read may be slow, but cannot block, remount or clear the answer.
const delayedLists=[];
let historyReads=0;
state.storage.clear();state.previewResult=commonValues[11];state.navigations=[];state.routerNavigations=[];state.refreshes=0;
state.apiAdapter=call=>{
 if(call.url==='/api/chat')return ++historyReads===1?{threads:[]}:new Promise(resolve=>delayedLists.push(resolve));
 if(call.url.startsWith('/api/learning-help?'))return state.previewResult;
 throw new Error(`Canonical handoff must not reload saved messages: ${call.url}`);
};
const handoff=streamResponse();state.fetchAdapter=()=>handoff.response;
tree=render({...streamOptions,values:commonValues.slice()});commitEffects();await turn();
tree=repaint(streamOptions);commitEffects();await turn();
tree=repaint(streamOptions);commitEffects();await turn();tree=repaint(streamOptions);
const handoffSend=nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('흐름을 끊지 않고 이어가요');await turn();
const handoffUser={id:'handoff-user',role:'user',content:'흐름을 끊지 않고 이어가요'};
handoff.event({type:'start',threadId:'handoff-thread',assistantId:'handoff-answer',userMessage:handoffUser});
handoff.event({type:'delta',delta:'## 바로 보이는 답\n\n**기존 근거**를 유지해요.'});await turn();flushDeltaTimers();
const handoffContent=state.values[0][1].content;
handoff.event({type:'done',threadId:'handoff-thread',userMessage:handoffUser,message:{id:'handoff-answer',role:'assistant',status:'completed',content:handoffContent},contextChanged:true});handoff.close();await handoffSend;
check(delayedLists.length===1&&state.values[3]===false&&state.refreshes===0,'completion unlocks busy state before the targeted history-list GET resolves and never refreshes bootstrap');
check(state.pathname==='/on/handoff-thread'&&state.params.size===0&&state.routerNavigations.length===0,'the canonical native URL is adopted without a router transition');
const handoffOptions={data:streamOptions.data,params:'',pathname:'/on/handoff-thread'};
const callsBeforeHandoff=state.calls.length;
tree=repaint(handoffOptions);commitEffects();await turn();
tree=repaint(handoffOptions);commitEffects();await turn();
tree=repaint(handoffOptions);commitEffects();await turn();tree=repaint(handoffOptions);
check(state.calls.slice(callsBeforeHandoff).every(call=>!call.url.startsWith('/api/chat?threadId=')),'native pathname adoption with unchanged root route props never reloads the saved thread');
check(state.values[0].length===2&&state.values[0][1].content===handoffContent&&state.values[0][1].status==='completed','the streamed message survives the native pathname and draft-key effects intact');
check(nodes(tree).find(node=>node.type==='ChatHistory').props.currentId==='handoff-thread'&&!nodes(tree).find(node=>node.type==='ChatComposer').props.disabled,'history selection and composer are ready while the lightweight list read is still pending');
state.fetchAdapter=()=>jsonResponse({threadId:'handoff-thread',userMessage:{id:'followup-user',role:'user',content:'같은 맥락으로 더 물어봐요'},message:{id:'followup-answer',role:'assistant',status:'completed',content:'같은 질문의 후속 답변'}});
await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend('같은 맥락으로 더 물어봐요');
const followupCall=state.sendCalls.at(-1);
check(followupCall.payload.threadId==='handoff-thread'&&followupCall.payload.questionId===common.id&&followupCall.payload.targetId==='school-owned'&&followupCall.payload.sourceVersion===1,'the immediate follow-up uses the saved thread and original school, question and source revision');
check(state.values[0].length===4&&state.values[0][1].content===handoffContent&&state.values[0][3].id==='followup-answer','an immediate follow-up retains the first answer and appends exactly one new user and AI pair');
check(delayedLists.length===2&&state.values[3]===false,'a follow-up also completes without awaiting either history-list read');
delayedLists[1]({threads:[{id:'handoff-thread',title:'최신 목록'}]});await turn();
const afterLatestList=plain(state.values);
delayedLists[0]({threads:[{id:'stale-list-thread',title:'이전 목록'}]});await turn();
assert.deepEqual(plain(state.values),afterLatestList);checks++;
check(state.values[19][0].id==='handoff-thread'&&state.values[1].id==='handoff-thread'&&state.values[0][3].id==='followup-answer','a late older targeted list read cannot overwrite the newer list, response or learning context');
const canonicalFallback={...handoffOptions,pathname:'/on',threadId:'handoff-thread'};
tree=repaint(canonicalFallback);commitEffects();await turn();
tree=repaint(canonicalFallback);commitEffects();await turn();
tree=repaint(canonicalFallback);commitEffects();await turn();tree=repaint(canonicalFallback);
check(state.values[0].length===0&&state.values[1]===null&&!nodes(tree).find(node=>node.type==='ChatHistory').props.currentId,'native navigation to /on clears the local conversation even while server route props retain the old slug');
state.apiAdapter=null;

// Retained/history UI and upload guards do not silently start AI generation.
const archivedValues=savedValues.slice();archivedValues[1]={...savedValues[1],archived_at:'2026-10-12T00:00:00.000Z'};
tree=render({values:archivedValues,threadId:oldThread.id});
check(textContent(tree).includes('이 대화의 지원처')&&textContent(tree).includes('현재 선택과 다른 지원처'),'a historical conversation explicitly identifies its frozen school when the global selection differs');
const messageRegion=nodes(tree).find(node=>node.props?.className==='chat-messages');
check(messageRegion.props.role==='region'&&messageRegion.props['aria-label']==='대화 메시지'&&messageRegion.props.tabIndex===0,'the one conversation scroll region is labelled and keyboard focusable');
check(nodes(tree).filter(node=>node.type==='MarkdownMessage').every(node=>node.props.humanizeLearningStatuses===true),'only assistant Markdown opts into display-only learning-status labels');
check(nodes(tree).find(node=>node.type==='ChatComposer').props.disabled&&nodes(tree).some(node=>node.type==='button'&&textContent(node)==='보관 해제하고 이어가기'),'an archived thread is read-only and has an explicit restore action');
check(nodes(tree).find(node=>node.type==='ChatHistory').props.currentId===oldThread.id,'the conversation history receives the current thread for selection and management');
const uploadValues=commonValues.slice();uploadValues[16]=[file,{...file,id:'second'},{...file,id:'third'}];
tree=render({...streamOptions,values:uploadValues});
const fileInput=nodes(tree).find(node=>node.type==='input'&&node.props.type==='file');
check(fileInput.props.multiple&&fileInput.props.accept.includes('.pdf')&&fileInput.props.accept.includes('.md')&&fileInput.props['aria-label']==='첨부 파일 선택','the attachment input exposes supported learning document formats accessibly');
const callsBeforeOverflow=state.calls.length;
await fileInput.props.onChange({target:{files:[new File(['내용'],'fourth.md',{type:'text/markdown'})]}});
check(state.values[5]==='파일은 한 번에 3개까지 첨부할 수 있어요.'&&state.calls.length===callsBeforeOverflow,'a fourth attachment is rejected before upload or AI transport');
state.apiAdapter=call=>{assert.equal(call.method,'DELETE');assert.equal(call.url,'/api/chat/attachments?id=owned-attachment');return{ok:true};};
nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='탐구 기록.md 첨부 취소').props.onClick();await turn();
check(state.values[16].length===2&&!state.values[16].some(item=>item.id===file.id),'explicit attachment cancellation removes only its acknowledged source');
state.apiAdapter=call=>{assert.equal(call.method,'POST');assert.equal(call.url,'/api/chat/attachments');assert.ok(call.options.body instanceof FormData);assert.equal(call.options.body.getAll('files')[0].name,'탐구.md');return{attachments:[file]};};
tree=render({...streamOptions,values:commonValues.slice()});
nodes(tree).find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[new File(['비교 조건 기록'],'탐구.md',{type:'text/markdown'})]}});
check(state.values[17]===true,'uploading indicates document processing before the local receipt returns');
await turn();tree=repaint(streamOptions);
check(state.values[16].length===1&&state.values[16][0].id===file.id&&state.values[17]===false&&nodes(tree).some(node=>node.props?.className==='chat-attachment-queue'),'the attachment upload uses FormData and presents only acknowledged queued sources');
state.apiAdapter=null;
tree=render({values:archivedValues.slice(),threadId:oldThread.id});
state.apiAdapter=()=>Promise.reject(new Error('보관 해제 연결 실패'));
await nodes(tree).find(node=>node.type==='button'&&textContent(node)==='보관 해제하고 이어가기').props.onClick();
tree=repaint({threadId:oldThread.id});
check(state.values[5]==='보관 해제 연결 실패'&&nodes(tree).some(node=>node.type==='Alert'),'a failed explicit restore is surfaced as an actionable alert rather than an unhandled rejection');
check(nodes(tree).find(node=>node.type==='ChatComposer').props.disabled,'a failed restore leaves the archived conversation read-only');
state.apiAdapter=null;
console.log(`chat context: ${checks} checks passed; no database changes or paid AI calls`);
