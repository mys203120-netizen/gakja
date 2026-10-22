import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';
const scopeLibrary=await tsImport('../apps/web/src/lib/learning-target-scope.ts',import.meta.url);
const dayRefreshLibrary=await tsImport('../apps/web/src/lib/training-day-refresh.ts',import.meta.url);
const trainingFlowLibrary=await tsImport('../apps/web/src/lib/training-flow.ts',import.meta.url);
const planSummaryLibrary=await tsImport('../apps/web/src/lib/training-plan-summary.ts',import.meta.url);
const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/training-hub.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const target={id:'a',university:'시험대학교',department:'환경공학과',admission_year:2027,campus:'본교',admission_type:'학생부종합'};
const school={targetId:'a',university:'시험대학교',department:'환경공학과',date:'2026-10-31',source:'public_period',periodStart:'2026-10-31',periodEnd:'2026-11-01',status:'ready',label:'공개 기간 시작 전 준비 목표 · 개인 배정 대기',reason:'개별일 확인 대기',daysLeft:11,availableMinutes:1320};
const task={id:'plan',kind:'focus',title:'내 역할 설명하기',minutes:25,reason:'이전 답변에서 도움을 사용했어요.',targetId:'a',status:'pending'};
function payload(tasks=[task]){const today={date:'2026-10-20',capacityMinutes:120,plannedMinutes:tasks.reduce((sum,task)=>sum+task.minutes,0),remainingMinutes:0,tasks};return {availability:{version:1},needsAvailability:false,deadlines:[school],days:[today],today,readiness:{items:[],summary:{total:0,practiced:0,unconfirmed:0}},diagnostics:null,warnings:[]};}
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(value=payload(),page='TodayTraining',mutate=async()=>({href:'/my/train?planId=plan'})){
 const context={data:{user:{id:'student',name:'민서'},targets:[target],interviews:[]},target,targetId:target.id,learningRevision:0,refresh:async()=>{}};
 const identity=()=>JSON.stringify([context.data.user.id,context.target?.id,scopeLibrary.learningScopeIdentity(context.target||{}),context.data.package?.id,context.data.package?.active_version,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())]);
 const state=[{scope:identity(),value},'',false,0,page==='TodayTraining'?'':'all',''];let index=0;
 const refs=[],posts=[],pushes=[];let refIndex=0;
 const hooks={...React,useEffect(){},useMemo:callback=>callback(),useCallback:callback=>callback,useRef(initial){return refs[refIndex++]??={current:initial};},useState(initial){const slot=index++;if(!(slot in state))state[slot]=initial;return [state[slot],next=>{state[slot]=typeof next==='function'?next(state[slot]):next;}];}};
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,Date,Intl,Event,AbortController,URLSearchParams,console,require(name){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;
  if(name==='next/link')return {default:({href,children,...props})=>React.createElement('a',{href,...props},children)};
  if(name==='next/navigation')return {usePathname:()=>'/my',useRouter:()=>({push:href=>pushes.push(href)})};
  if(name==='lucide-react')return icons;if(name==='./app-shell')return {useApp:()=>context};
  if(name==='@/lib/learning-target-scope')return scopeLibrary;
  if(name==='@/lib/training-day-refresh')return dayRefreshLibrary;
  if(name==='@/lib/training-plan-summary')return planSummaryLibrary;
  if(name==='@/lib/training-flow')return trainingFlowLibrary;
  if(name==='./training-calendar')return {TrainingCalendar:()=>React.createElement('section',{'aria-label':'훈련과 학교 면접 캘린더',id:'training-calendar'},'계획과 면접 일정')};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
  if(name==='./shared')return {InfoTip:({label,children})=>React.createElement('aside',{'aria-label':label},children),api(){throw Error('No reads during render');},post:async(url,body)=>{posts.push({url,body});return mutate(body);},ActionButton:({pending,pendingLabel,children,...props})=>React.createElement('button',props,pending?pendingLabel:children),Alert:({children})=>React.createElement('p',{role:'alert'},children),Spinner:()=>React.createElement('p',null,'loading'),targetName:target=>target?.university||''};
  throw Error(name);
 }});
 return {context,posts,pushes,render(){index=0;refIndex=0;return module.exports[page]();},markup(){return renderToStaticMarkup(this.render());}};
}
// Public periods stay visibly distinct from a personal interview date.
{
 const h=harness(),markup=h.markup();
 assert.ok(markup.includes('준비 목표까지 11일')&&markup.replace(/<[^>]*>/g,'').replace(/\s+/g,'').includes('준비목표D-11'));
 assert.ok(markup.includes('10월 31일–11월 1일')&&markup.includes('개인 배정 대기'));
 assert.ok(markup.includes('오늘 가능 2시간')&&markup.includes('준비 목표 전'));
 assert.equal(h.posts.length,0);
 assert.ok(markup.includes('href="#training-calendar"')&&markup.includes('계획과 면접 일정'),'today exposes the actual combined calendar');
 assert.ok(markup.includes('권장 25분')&&markup.includes('내 역할 설명하기'),'the compact plan preserves its concrete task and recommended time');
 assert.ok(!markup.includes('오늘 가능한 시간에 맞춰 순서대로 준비해요.')&&!markup.includes('새 답변과 가능한 시간이 바뀌면 우선순위를 다시 맞춰요.'),'repeated introductory explanations are omitted');
 assert.ok(!markup.includes('본질문 → 꼬리질문 → 보완 → 재답변')&&!markup.includes(task.reason),'the overview omits repeated workflow and selection explanations');
 assert.ok(!markup.includes('aria-label="필요한 연습 직접 선택"')&&!markup.includes('직접 연습 선택'),'tools are no longer buried in a second navigation at the bottom');
}
// Missing availability and missing questions cannot masquerade as a completed day.
{
 const value=payload();value.needsAvailability=true;
 assert.ok(harness(value).markup().includes('학습 시간 설정'));
 const empty=harness(payload([])).markup();assert.ok(empty.includes('면접 일정과 연습 질문을 먼저 확인해요.'));
 assert.ok(!empty.includes('오늘 계획을 모두 마쳤어요.'));
}
// Manual work uses its original resource and never starts an automatic session.
{
 const diagnostic={...task,id:'diagnostic',kind:'diagnostic',title:'첫 진단 · 활동·개념·지원 동기 확인'};
 const focus={...task,title:'활동·개념 확인하고 내 말로 답하기 · 긴 탐구 질문 전체'};
 const first=nodes(harness(payload([diagnostic,focus])).render());
 assert.equal(first.find(node=>node.type==='h2'&&node.props.id==='today-focus-title').props.children,'첫 진단','the hero describes the same diagnostic task as its primary action');
 assert.ok(React.Children.toArray(first.find(node=>node.props?.className==='button primary').props.children).includes('첫 진단 시작'));
 const after=nodes(harness(payload([{...diagnostic,completed:true,status:'completed'},focus])).render());
 assert.equal(after.find(node=>node.type==='h2'&&node.props.id==='today-focus-title').props.children,'활동·개념 확인하고 내 말로 답하기','after diagnosis the hero follows the next focus task and keeps its title short');
 assert.ok(after.some(node=>node.type==='strong'&&node.props.children===focus.title),'the full question remains visible in the ordered plan');
}
{
 const completed=harness(payload([{...task,status:'completed',completed:true}])).markup();
 assert.ok(completed.includes('오늘 계획을 모두 마쳤어요.'));
 const h=harness(payload([{...task,status:'completed',completed:true},{...task,id:'next',title:'개념을 더 설명하기'}]));
 const heading=nodes(h.render()).find(node=>node.type==='h2'&&node.props.id==='today-focus-title');
 assert.equal(heading.props.children,'개념을 더 설명하기');
}
{
 const h=harness(payload([{...task,manual:true,href:'/materials/questions/q1'}]));
 const button=nodes(h.render()).find(node=>node.props?.className==='button primary'&&node.props.onClick);
 button.props.onClick();await flush();
 assert.deepEqual(h.pushes,['/materials/questions/q1']);assert.equal(h.posts.length,0);
 const plain=harness(payload([{...task,manual:true}])).markup();assert.ok(plain.includes('직접 추가한 계획'));
}
// Session work starts on the server; review is opened, never marked complete by opening it.
for(const kind of ['chat','video']){
 const session={id:'active-session',kind,state:'active',target_id:target.id,data:{context:{target},trainingPlanId:'owned-plan',trainingPurpose:'focus'}};
 const h=harness();h.context.data.interviews=[{...session,id:'old-snapshot',data:{...session.data,context:{target:{...target,department:'이전 학과'}}}},session];
 const unified=h.markup();
 assert.ok(unified.includes('href="/my/train?planId=owned-plan"'),'active training resumes through the same unified wrapper');
 assert.ok(!unified.includes('href="/interview/active-session'),'training sessions do not resume in a separate input-mode room');
 assert.ok(!unified.includes('old-snapshot'),'a changed school snapshot is excluded from the active resume');
 h.context.data.interviews=[{...session,data:{context:{target}}}];
 assert.ok(h.markup().includes(`href="/interview/active-session?kind=${kind==='video'?'video':'chat'}"`),'legacy unlinked practice retains its existing detail route');
 h.context.data.interviews=[{...session,state:'completed'}];
 assert.ok(!h.markup().includes('이어 하기'),'completed sessions never appear as active work');
}
for(const kind of ['focus','review','quiz','assignment']){
 const h=harness(payload([{...task,kind}]));
 const tree=h.render(),button=nodes(tree).find(node=>node.props?.onClick&&node.props.className==='taskTrigger');
 button.props.onClick();await flush();
 assert.equal(h.posts[0].body.action,'task_start');
 assert.equal(h.posts[0].body.planId,'plan');
}
{
 const quiz={...task,id:'quiz',kind:'quiz',title:'질문 속 개념 확인하기',minutes:12},assignment={...task,id:'assignment',kind:'assignment',title:'받은 과제 마치기',minutes:15};
 const markup=harness(payload([quiz,assignment])).markup();
 assert.ok(markup.includes('퀴즈 · 권장 12분')&&markup.includes(quiz.title));
 assert.ok(markup.includes('받은 과제 · 권장 15분')&&markup.includes(assignment.title));
}
// A response to the old school cannot navigate after the student switches their target.
{
 let finish;const h=harness(payload(),undefined,()=>new Promise(resolve=>{finish=resolve;}));
 const button=nodes(h.render()).find(node=>node.props?.className==='button primary'&&node.props.onClick);
 button.props.onClick();h.context.target={...target,id:'b',department:'다른 학과'};h.context.targetId='b';h.render();
 finish({href:'/my/train?planId=old'});await flush();assert.deepEqual(h.pushes,[]);
}
// Actual modalities, follow-ups, confirmed notes and comparison context stay together.
{
 const value=payload();value.readiness={items:[{id:'activity',kind:'activity',title:'수질 탐구',questionCount:2,mainAnswers:1,followupAnswers:2,textAttempts:1,audioAttempts:2,assistedAttempts:1,needsReview:['측정 원리 다시 설명하기'],unconfirmed:false,sourceHref:'/materials/activities/activity',editHref:'/materials/activities/activity',notes:[{id:'note',body:'같은 시간에 다시 측정하자고 제안했어요.',confirmedByStudent:true,createdAt:'2026-10-20T09:00:00+09:00'},{id:'draft',body:'아직 확인하지 않은 제안',confirmedByStudent:false,createdAt:'2026-10-20T09:00:00+09:00'}]}],summary:{total:1,practiced:1,unconfirmed:0}};
 const markup=harness(value,'PreparationOverview').markup();
 assert.ok(markup.includes('답변한 항목 1개'),'one practiced item with several attempts is labeled as an item count, not one submitted answer');
 assert.ok(markup.includes('글 1')&&markup.includes('음성 2')&&markup.includes('꼬리질문 답변'));
 assert.ok(markup.includes('같은 시간에 다시 측정')&&!markup.includes('아직 확인하지 않은 제안'));
 assert.ok(markup.includes('/records/comparisons?activityId=activity&amp;targetId=a'));
 assert.ok(markup.includes('/materials/activities/activity'));
 assert.ok(markup.includes('준비 행동')&&markup.includes('활동 확인·보완'),'activity actions are visible without opening a disclosure');
 assert.ok(markup.includes('오늘 훈련')&&markup.includes('내 역할 설명하기'),'preparation opens on its actual next scheduled task');
}
// Summary controls select real observations and never turn practice counts into a readiness score.
{
 const value=payload();value.readiness={items:[{id:'unconfirmed',kind:'experience',title:'아직 확인하지 않은 탐구',mainAnswers:0,followupAnswers:0,textAttempts:0,audioAttempts:0,assistedAttempts:0,questionCount:1,needsReview:['활동 사실 확인'],unconfirmed:true,editHref:'/armory?card=check'},{id:'practiced',kind:'question',title:'직접 답한 질문',mainAnswers:1,followupAnswers:2,textAttempts:3,audioAttempts:0,assistedAttempts:0,questionCount:1,needsReview:[],unconfirmed:false,sourceHref:'/records/comparisons/question'}],summary:{total:2,practiced:1,unconfirmed:1}};
 const h=harness(value,'PreparationOverview');let markup=h.markup();
 assert.ok(markup.includes('활동 사실 확인')&&markup.includes('/armory?card=check'));
 const controls=nodes(h.render()).filter(node=>node.type==='button'&&node.props['aria-pressed']!==undefined);
 controls[2].props.onClick();markup=h.markup();
 assert.ok(markup.includes('아직 확인하지 않은 탐구')&&!markup.includes('직접 답한 질문'),'fact confirmation filter opens only unconfirmed evidence');
 controls[0].props.onClick();markup=h.markup();assert.ok(markup.includes('직접 답한 질문'),'all items are available again');
 // A question row from this school must not use its unscoped historical source URL.
 const questionRow=value.readiness.items[1];questionRow.id='question:practiced';
 markup=h.markup();assert.ok(markup.includes('href="/records/comparisons?activityId=question%3Apracticed&amp;targetId=a"'),'question card action keeps the exact question and selected school');
 assert.ok(!markup.includes('href="/records/comparisons/question"'),'unscoped question history is not a prominent action or a misleading source link');
 value.needsAvailability=true;assert.ok(h.markup().includes('학습 가능 시간을 설정해요.'));
}
console.log('Training hub passed: real period labels, capacity, missing data, manual tasks, server start/complete, stale school guards and unified activity evidence.');

// Today and readiness display the same canonical review state; historical help does not reopen it in the UI.
{
 const value=payload(),base={questionCount:1,mainAnswers:1,followupAnswers:1,textAttempts:1,audioAttempts:1,assistedAttempts:3,needsReview:[],unconfirmed:false};
 const question=(questionId,status,extra={})=>({questionKey:`a:personal:2:${questionId}`,targetId:'a',questionId,sourceType:'personal',sourceVersion:2,activityIds:[questionId],status,needsReview:status==='active',requestIds:['request-'+questionId],resolvedEvidenceIds:status==='resolved'?['answer-'+questionId]:[],reason:status==='active'?'같은 질문에 도움 없이 다시 답하기':'후속 답변으로 재확인했어요.',requestedAtUnknown:false,...extra});
 const active=question('active','active',{requestedAtUnknown:true}),secondActive=question('same-activity','active',{activityIds:['active']}),resolved=question('resolved','resolved'),other=question('other','active',{targetId:'b',questionKey:'b:personal:2:other',requestedAtUnknown:true});
 value.review={questions:[active,secondActive,resolved,other],requests:[]};
 value.readiness={items:[{...base,id:'active',kind:'activity',title:'확인할 탐구',reviewStatus:'active',reviewQuestionKeys:[active.questionKey,secondActive.questionKey],reviewReasons:[active.reason]},{...base,id:'resolved',kind:'activity',title:'재확인한 탐구',reviewStatus:'resolved',reviewQuestionKeys:[resolved.questionKey],reviewReasons:[]}],summary:{total:2,practiced:2,unconfirmed:0}};
 const today=harness(value).markup(),prep=harness(value,'PreparationOverview'),markup=prep.markup();
 const reviewSummary=html=>html.match(/<aside[^>]*aria-label="현재 지원처 보완 상태"[^>]*><span>([^<]*)<\/span>/)?.[1];
 assert.equal(reviewSummary(today),'보완 중 2개 질문 · 재확인 완료 1개 질문');
 assert.equal(reviewSummary(markup),reviewSummary(today),'both screens count the same selected-target questions, not activities or missing observations');
 assert.ok(!today.includes('보완 중 3개 질문'),'another support target cannot change this summary');
 for(const label of ['보완 중','재확인 완료'])assert.ok(today.includes(label)&&markup.includes(label),`${label} has the same meaning on both screens`);
 assert.equal((markup.match(/data-review-status="active"/g)||[]).length,1);
 assert.equal((markup.match(/data-review-status="resolved"/g)||[]).length,1);
 assert.equal((markup.match(/요청 시점 미확인/g)||[]).length,1,'only the linked active item receives the legacy-date note');
 assert.ok(markup.includes('같은 질문에 도움 없이 다시 답하기'));
 assert.ok(!markup.includes('숙달')&&!markup.includes('실력 완료'));
 const controls=nodes(prep.render()).filter(node=>node.type==='button'&&node.props['aria-pressed']!==undefined);
 assert.ok(renderToStaticMarkup(controls[1]).includes('확인할 항목</span><strong>1</strong>'),'one activity may contain multiple canonical recheck questions');
 controls[1].props.onClick();
 const filtered=prep.markup();assert.ok(filtered.includes('확인할 탐구')&&!filtered.includes('재확인한 탐구'),'active review remains filterable without missing-observation notes; old help alone does not include resolved items');
 value.review.questions=[resolved,{...active,status:'resolved',needsReview:false,requestedAtUnknown:false},{...secondActive,status:'resolved',needsReview:false}];
 value.readiness.items[0]={...value.readiness.items[0],reviewStatus:'resolved',reviewReasons:[],needsReview:['말하기 미확인']};
 const refreshedToday=harness(value).markup(),refreshedPrep=harness(value,'PreparationOverview').markup();
 assert.equal(reviewSummary(refreshedToday),'보완 중 0개 질문 · 재확인 완료 3개 질문');
 assert.equal(reviewSummary(refreshedPrep),reviewSummary(refreshedToday));
 assert.ok(!refreshedPrep.includes('data-review-status="active"')&&refreshedPrep.includes('말하기 미확인'),'remaining observation work is separate from the resolved review state');
 assert.ok(!refreshedPrep.includes('요청 시점 미확인'));
}

// The whole lesson row is the only interactive control inside the row; rapid taps are one request.
{
 let finish;const h=harness(payload([{...task},{...task,id:'review',kind:'review',title:'오늘 정리'},{...task,id:'rest',kind:'break',title:'휴식'}]),undefined,()=>new Promise(resolve=>{finish=resolve;}));
 const row=nodes(h.render()).find(node=>node.type==='button'&&node.props.className==='taskTrigger');
 assert.equal(nodes(row).filter(node=>node.type==='button').length,1);
 assert.ok(row.props['aria-label'].includes('내 역할 설명하기'));
 assert.ok(!h.markup().includes('휴식'));
 row.props.onClick();row.props.onClick();await flush();assert.equal(h.posts.length,1);
 finish({href:'/my/train?planId=plan'});await flush();assert.deepEqual(h.pushes,['/my/train?planId=plan']);
}

// A → B → A creates a new visit, so an old request cannot navigate it or unlock its new request.
{
 const finishes=[];const h=harness(payload(),undefined,()=>new Promise(resolve=>finishes.push(resolve)));
 const row=()=>nodes(h.render()).find(node=>node.type==='button'&&node.props.className==='taskTrigger');
 row().props.onClick();h.context.targetId='b';h.context.target={...target,id:'b'};h.render();h.context.targetId='a';h.context.target=target;h.render();row().props.onClick();
 assert.equal(h.posts.length,2);finishes[0]({href:'/my/train?planId=old'});await flush();assert.deepEqual(h.pushes,[]);assert.equal(row().props.disabled,true);
 finishes[1]({href:'/my/train?planId=current'});await flush();assert.deepEqual(h.pushes,['/my/train?planId=current']);
}
