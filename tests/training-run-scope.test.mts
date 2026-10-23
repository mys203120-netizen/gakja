import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as trainingFlow from '../apps/web/src/lib/training-flow';
import * as targetScope from '../apps/web/src/lib/learning-target-scope';

const code=ts.transpileModule(readFileSync('apps/web/src/components/training-run.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value:any):string=>typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';
function deferred(){let resolve!:(value:any)=>void,reject!:(error:Error)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

function harness({diagnostic=false,existing=false,pendingAction='start',kind='focus',pressure=false,dayTasks=[] as any[],deferNext=false,failNext=false,diagnostics=undefined as any}={}){
  const hooks:any[]=[],effects:any[]=[],pending:Function[]=[],requests:any[]=[],pushes:string[]=[];
  let cursor=0,dirty=true,tree:any,target='school-a',student='student-a',plan='plan-a',refreshes=0,department='환경공학과',version=1;
  const deferreds:ReturnType<typeof deferred>[]=[],nextReads:ReturnType<typeof deferred>[]=[],planReads:string[]=[];let reads=0,planReadOverride:((url:string)=>Promise<any>)|null=null;
  const task=()=>({id:plan,minutes:25,kind,pressure,targetId:target,questionId:'question-'+target,sourceType:'fixture',sourceVersion:1,title:'집중 보완 · 나의 활동',practice:kind==='quiz'?{kind:'quiz',mode:'answer',itemIds:['item-a']}:{kind:'assignment',assignmentId:'assignment-a'},href:'/quiz/assignments/assignment-a?trainingPlanId='+plan,...(existing?{sessionId:'session-'+target}:{})});
  const react={Suspense:'Suspense',useCallback:(fn:Function)=>fn,useState(initial:any){const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],(value:any)=>{const next=typeof value==='function'?value(hooks[index]):value;if(!Object.is(next,hooks[index])){hooks[index]=next;dirty=true;}}];},useRef(initial:any){return hooks[cursor++]??={current:initial};},useEffect(fn:Function,deps:any[]){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){effects[index]={deps};pending.push(()=>{previous?.cleanup?.();effects[index].cleanup=fn();});}}};
  const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,AbortController,URLSearchParams,crypto:{randomUUID},window:{location:{assign:(path:string)=>pushes.push(path)}},require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
    if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;
    if(name==='next/link')return {default:'Link'};if(name==='next/navigation')return {useRouter:()=>({push:(path:string)=>pushes.push(path)}),useSearchParams:()=>new URLSearchParams({planId:plan})};
    if(name==='@/lib/training-flow')return trainingFlow;
    if(name==='@/lib/learning-target-scope')return targetScope;
    if(name==='lucide-react')return {ArrowRight:'ArrowRight',Check:'Check'};
    if(name==='./app-shell')return {useApp:()=>({targetId:target,target:{id:target,university:'시험대학교',department,admission_year:2027,campus:'본교',admission_type:'학생부종합'},data:{user:{id:student},package:{id:'package',active_version:version}},refresh:async()=>{refreshes++;},learningRevision:1})};
    if(name==='./shared')return {Alert:'Alert',Spinner:'Spinner',ActionButton:'ActionButton',InfoTip:'InfoTip',api:async(url:string)=>{if(new URLSearchParams(url.split('?')[1]).has('planId')){planReads.push(url);if(planReadOverride)return planReadOverride(url);}if(!new URLSearchParams(url.split('?')[1]).has('planId')){reads++;if(failNext)throw new Error('다음 계획 통신 오류');if(deferNext){const response=deferred();nextReads.push(response);return response.promise;}}return {today:{date:'2026-10-21',tasks:dayTasks},selectedTask:task(),dayReview:{date:'2026-10-21',targetId:null,answers:2,quizAnswers:1,assistedAnswers:1,remainingReview:1,questions:[{key:'scope-'+target,id:'question-'+target,targetId:target,title:'오늘 답한 질문 '+target,assisted:true}]},diagnostics:typeof diagnostics==='function'?diagnostics(target):diagnostics,diagnosticInput:{targetId:target,sourceType:'fixture',questionCount:1},diagnosticQuestions:[{id:'question-'+target,title:'진단 질문'}],readiness:{items:[{id:'activity-'+target,title:'활동 '+target}]}};},post:async(url:string,input:any)=>{
      requests.push({url,input});
      if(input.action===pendingAction){const response=deferred();deferreds.push(response);return response.promise;}
      if(input.action==='task_start')return {task:task()};
      return {};
    }};
    if(name==='./interview')return {InterviewSession:'InterviewSession'};
    if(name==='./question-experience-picker')return {QuestionExperiencePicker:'QuestionExperiencePicker'};
    if(name==='./markdown-message')return {MarkdownMessage:'MarkdownMessage'};
    if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
    throw Error(name);
  }});
  const run=module.exports.TrainingRun({diagnostic}).props.children;
  async function flush(){for(let i=0;i<16;i++){if(dirty){dirty=false;cursor=0;tree=run.type(run.props);while(pending.length)pending.shift()!();}await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;}throw Error('Render loop');}
  const action=(label:string)=>nodes(tree).find(node=>node.type==='ActionButton'&&text(node).includes(label));
  const interview=()=>nodes(tree).find(node=>node.type==='InterviewSession');
  const completion=(school=target)=>({session:{state:'completed',data:{trainingProgress:{allRootsAnswered:true},context:{questions:[{id:'question-'+school,activity_ids:['activity-'+school]}]}}},turns:[{id:'turn-'+school,rootQuestionId:'question-'+school,question:'활동 설명 '+school,answer:'저장 답변 '+school}]});
  return {flush,action,interview,completion,deferreds,nextReads,requests,pushes,planReads,setPlanReadOverride(value:(url:string)=>Promise<any>){planReadOverride=value;},get reads(){return reads;},get tree(){return tree;},get refreshes(){return refreshes;},changePlan(value:string){plan=value;dirty=true;},changeContent(){version++;dirty=true;},changeDepartment(value:string){department=value;dirty=true;},changeScope(school:string,user='student-a'){target=school;student=user;plan='plan-'+school;dirty=true;}};
}

test('changing school while starting unlocks the new scope and a late old start cannot replace or unlock the next start',async()=>{
  const h=harness();await h.flush();h.action('훈련 시작').props.onClick();await h.flush();assert.equal(h.action('훈련 시작').props.pending,true);
  h.changeScope('school-b');await h.flush();assert.equal(h.action('훈련 시작').props.pending,false,'new school can start without waiting for the old school');
  h.action('훈련 시작').props.onClick();await h.flush();assert.equal(h.deferreds.length,2);
  h.deferreds[0].resolve({session:{id:'old-session'}});await h.flush();assert.equal(h.action('훈련 시작').props.pending,true);assert.equal(h.interview(),undefined);
  h.deferreds[1].resolve({session:{id:'new-session'}});await h.flush();assert.equal(h.interview().props.id,'new-session');
});

test('returning to the same school still rejects the previous visit response',async()=>{
  const h=harness();await h.flush();h.action('훈련 시작').props.onClick();await h.flush();
  h.changeScope('school-b');await h.flush();h.changeScope('school-a');await h.flush();
  h.action('훈련 시작').props.onClick();await h.flush();h.deferreds[0].resolve({session:{id:'old-visit'}});await h.flush();
  assert.equal(h.action('훈련 시작').props.pending,true);assert.equal(h.interview(),undefined);
  h.deferreds[1].resolve({session:{id:'current-visit'}});await h.flush();assert.equal(h.interview().props.id,'current-visit');
});

for(const fail of [false,true])test(`late diagnostic reflection ${fail?'failure':'success'} does not mark another account saved or show its error`,async()=>{
  const h=harness({diagnostic:true,existing:true,pendingAction:'diagnostic_reflection'});await h.flush();
  const oldUpdate=h.interview().props.onTrainingUpdate;oldUpdate(h.completion());await h.flush();
  h.action('선택한 부분').props.onClick();await h.flush();assert.equal(h.action('선택한 부분').props.pending,true);
  assert.ok(nodes(h.tree).filter(node=>node.type==='fieldset').every(node=>node.props.disabled),'selections cannot change during their save');
  h.changeScope('school-b','student-b');await h.flush();oldUpdate(h.completion('school-a'));await h.flush();
  assert.equal(text(h.tree).includes('저장 답변 school-a'),false,'late session callback is also ignored');
  h.interview().props.onTrainingUpdate(h.completion());await h.flush();
  if(fail)h.deferreds[0].reject(new Error('old-account-error'));else h.deferreds[0].resolve({});await h.flush();
  assert.equal(text(h.tree).includes('보완할 부분 저장됨'),false);assert.equal(text(h.tree).includes('old-account-error'),false);assert.equal(h.action('선택한 부분').props.pending,false);assert.equal(h.refreshes,0);
});

test('late activity save cannot mark a new school draft saved or reset its receipt',async()=>{
  const h=harness({diagnostic:true,existing:true,pendingAction:'activity_note'});await h.flush();h.interview().props.onTrainingUpdate(h.completion());await h.flush();
  const edit=async(body:string)=>{nodes(h.tree).find(node=>node.type==='select').props.onChange({target:{value:body.startsWith('A')?'activity-school-a':'activity-school-b'}});nodes(h.tree).find(node=>node.type==='textarea'&&node.props.maxLength===1500).props.onChange({target:{value:body}});await h.flush();};
  await edit('A saved facts');h.action('내가 한 일').props.onClick();await h.flush();
  h.changeScope('school-b');await h.flush();h.interview().props.onTrainingUpdate(h.completion());await h.flush();await edit('B new draft');
  h.action('내가 한 일').props.onClick();await h.flush();
  h.deferreds[0].resolve({});await h.flush();assert.equal(h.action('내가 한 일').props.pending,true,'the old save cannot unlock the current save');assert.equal(text(h.tree).includes('활동에 반영됨'),false);
  h.deferreds[1].resolve({});await h.flush();assert.equal(text(h.tree).includes('활동에 반영됨'),true);assert.equal(nodes(h.tree).find(node=>node.type==='textarea'&&node.props.maxLength===1500).props.value,'B new draft');
  const saves=h.requests.filter(item=>item.input.action==='activity_note');assert.notEqual(saves[0].input.requestId,saves[1].input.requestId);
});


test('finishing an old school review does not navigate away from the next school',async()=>{
  const h=harness({kind:'review',pendingAction:'day_reflection'});await h.flush();h.action('오늘 정리 저장').props.onClick();await h.flush();
  h.changeScope('school-b');await h.flush();assert.equal(h.action('오늘 정리 저장').props.pending,false);
  h.deferreds[0].resolve({});await h.flush();assert.deepEqual(h.pushes,[]);assert.equal(h.refreshes,0);
});

test('diagnostic topic pills support multiple independent choices and save only the remaining selections',async()=>{
  const h=harness({diagnostic:true,existing:true,pendingAction:'diagnostic_reflection'});await h.flush();
  h.interview().props.onTrainingUpdate(h.completion());await h.flush();
  const pill=(label:string)=>nodes(h.tree).find(node=>node.type==='button'&&text(node)===label);
  assert.ok(pill('내 활동 설명'));assert.equal(pill('내 활동 설명').props['aria-pressed'],false);
  assert.equal(nodes(nodes(h.tree).find(node=>node.props?.className==='topicButtons')).some(node=>node.type==='input'||node.type==='Check'),false);
  pill('내 활동 설명').props.onClick();await h.flush();
  pill('전공 개념·이유').props.onClick();await h.flush();
  assert.equal(pill('내 활동 설명').props['aria-pressed'],true);assert.equal(pill('전공 개념·이유').props['aria-pressed'],true);
  pill('내 활동 설명').props.onClick();await h.flush();
  assert.equal(pill('내 활동 설명').props['aria-pressed'],false);assert.equal(pill('전공 개념·이유').props['aria-pressed'],true);
  h.action('선택한 부분').props.onClick();await h.flush();
  const saved=h.requests.find(row=>row.input.action==='diagnostic_reflection');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.input.focusCategories)),['major']);
  h.deferreds[0].resolve({});await h.flush();assert.ok(h.action('보완할 부분 저장됨'));assert.equal(h.refreshes,1);
});

test('diagnostic reflection restores canonical active selections and never revives resolved legacy choices',async()=>{
  const h=harness({diagnostic:true,existing:true,pendingAction:'diagnostic_reflection',diagnostics:{needsReviewQuestionIds:['question-school-a'],focusCategories:['major'],activeNeedsReviewQuestionIds:[],activeFocusCategories:[]}});
  await h.flush();h.interview().props.onTrainingUpdate(h.completion());await h.flush();
  const checkbox=nodes(h.tree).find(node=>node.type==='input'&&node.props.type==='checkbox');
  const major=nodes(h.tree).find(node=>node.type==='button'&&text(node)==='전공 개념·이유');
  assert.equal(checkbox.props.checked,false,'empty active selections are authoritative after resolution');assert.equal(major.props['aria-pressed'],false);
  h.action('선택한 부분').props.onClick();await h.flush();
  const saved=h.requests.find(row=>row.input.action==='diagnostic_reflection');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.input.needsReviewQuestionIds)),[]);assert.deepEqual(JSON.parse(JSON.stringify(saved.input.focusCategories)),[]);
  h.deferreds[0].resolve({});await h.flush();
});

test('older diagnostic payloads restore legacy choices only while active fields are absent',async()=>{
  for(const canonical of [false,true]){
    const h=harness({diagnostic:true,existing:true,diagnostics:{needsReviewQuestionIds:['question-school-a'],focusCategories:['major'],...(canonical?{activeNeedsReviewQuestionIds:['question-school-a'],activeFocusCategories:['talent']}: {})}});
    await h.flush();h.interview().props.onTrainingUpdate(h.completion());await h.flush();
    assert.equal(nodes(h.tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,true);
    const selected=(label:string)=>nodes(h.tree).find(node=>node.type==='button'&&text(node)===label).props['aria-pressed'];
    assert.equal(selected('전공 개념·이유'),!canonical);assert.equal(selected('학교·학과와의 연결'),canonical);
  }
});

test('switching target or changing its content resets reflection selections and rejects old session callbacks',async()=>{
  const h=harness({diagnostic:true,existing:true,diagnostics:(school:string)=>({activeNeedsReviewQuestionIds:school==='school-a'?['question-school-a']:[],activeFocusCategories:school==='school-a'?['major']:[]})});
  await h.flush();const oldUpdate=h.interview().props.onTrainingUpdate;oldUpdate(h.completion());await h.flush();
  assert.equal(nodes(h.tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,true);
  h.changeScope('school-b');await h.flush();const update=h.interview().props.onTrainingUpdate;update(h.completion());await h.flush();
  assert.equal(nodes(h.tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
  assert.ok(nodes(h.tree).filter(node=>node.type==='button'&&node.props['aria-pressed']!==undefined).every(node=>!node.props['aria-pressed']));
  h.changeContent();await h.flush();update(h.completion());await h.flush();
  assert.equal(text(h.tree).includes('저장 답변 school-b'),false,'a prior content version cannot restore its completed summary');
  assert.ok(h.interview(),'the current content opens a fresh active session view');
  const currentUpdate=h.interview().props.onTrainingUpdate;
  h.changeDepartment('다른 학과');await h.flush();currentUpdate(h.completion());await h.flush();
  assert.equal(text(h.tree).includes('저장 답변 school-b'),false,'a changed target identity also invalidates the old callback');
});


test('a completed lesson refreshes the real plan and opens its next lesson rather than returning to the dashboard',async()=>{
 const h=harness({existing:true,dayTasks:[{id:'plan-a',kind:'focus',title:'마친 질문',minutes:25},{id:'review',kind:'review',title:'오늘 정리',minutes:10},{id:'next-focus',kind:'focus',title:'학교와 활동 연결',minutes:30}]});await h.flush();
 assert.equal(h.reads,0,'continuation is never requested before a confirmed completed session');
 h.interview().props.onTrainingUpdate(h.completion());await h.flush();
 assert.equal(h.reads,1);const next=nodes(h.tree).find(node=>node.type==='a'&&node.props.href==='/my/train?planId=next-focus');
 assert.ok(next);assert.ok(text(next).includes('학교와 활동 연결'));assert.equal(h.requests.some(row=>['task_complete','start'].includes(row.input.action)),false,'suggestion does not fabricate completion or create another interview');
});

test('ending after one diagnostic response preserves the record but does not skip the unfinished lesson',async()=>{
 const h=harness({diagnostic:true,existing:true,dayTasks:[{id:'plan-a',kind:'diagnostic',title:'남은 진단 질문',minutes:20},{id:'next',kind:'focus',title:'다음 훈련',minutes:25}]});await h.flush();
 const info=h.completion();info.session.data.trainingProgress={allRootsAnswered:false};h.interview().props.onTrainingUpdate(info);await h.flush();
 assert.match(text(h.tree),/차시는 완료로 표시하지 않고/);assert.ok(nodes(h.tree).some(node=>node.type==='a'&&node.props.href==='/my/train?planId=plan-a'));
 assert.equal(text(h.tree).includes('오늘 계획을 모두 마쳤어요.'),false);assert.equal(text(h.tree).includes('훈련 완료'),false);
 const restart=nodes(h.tree).find(node=>node.type==='button'&&text(node)==='답변 연습 다시 시작');assert.ok(restart);restart.props.onClick();await h.flush();assert.ok(h.action('답변 연습 시작'));assert.equal(h.interview(),undefined,'retry returns to a fresh start instead of reopening the ended room');
});

test('a partial diagnostic from a previous visit opens a fresh start instead of looping its ended room',async()=>{
 const h=harness({diagnostic:true,existing:true,diagnostics:{state:'partial',sessionId:'session-school-a'}});await h.flush();assert.equal(h.interview(),undefined);assert.ok(h.action('답변 연습 시작'));
});

test('the final lesson leads to daily reflection and reflection confirmation ends the day without a blank interview',async()=>{
 const h=harness({existing:true,dayTasks:[{id:'plan-a',kind:'focus',title:'마친 질문',minutes:25},{id:'review',kind:'review',title:'오늘 정리',minutes:10}]});await h.flush();h.interview().props.onTrainingUpdate(h.completion());await h.flush();
 assert.ok(text(h.tree).includes('마지막 순서'));assert.ok(nodes(h.tree).some(node=>node.type==='a'&&node.props.href==='/my/train?planId=review'));
 const review=harness({kind:'review',pendingAction:'day_reflection',dayTasks:[{id:'plan-a',kind:'review',title:'오늘 정리',minutes:10}]});await review.flush();review.action('오늘 정리 저장').props.onClick();await review.flush();
 assert.ok(!text(review.tree).includes('오늘 정리 완료'),'completion waits for the server acknowledgement');review.deferreds[0].resolve({completed:true});await review.flush();
 assert.ok(text(review.tree).includes('오늘 정리 완료'));assert.ok(text(review.tree).includes('오늘 계획을 모두 마쳤어요.'));assert.equal(review.interview(),undefined);assert.deepEqual(review.pushes,[]);
});

test('a delayed next-plan response cannot reveal or navigate into the previous school',async()=>{
 const h=harness({existing:true,deferNext:true});await h.flush();const old=h.interview().props.onTrainingUpdate;old(h.completion());await h.flush();assert.equal(h.nextReads.length,1);
 h.changeScope('school-b');await h.flush();h.nextReads[0].resolve({today:{tasks:[{id:'private-old-plan',kind:'focus',title:'이전 학교 질문',minutes:25}]}});await h.flush();
 assert.equal(text(h.tree).includes('이전 학교 질문'),false);assert.equal(nodes(h.tree).some(node=>node.props?.href?.includes('private-old-plan')),false);
});

test('a next-plan load failure stays retryable and cannot masquerade as a completed day',async()=>{
 const h=harness({existing:true,failNext:true});await h.flush();h.interview().props.onTrainingUpdate(h.completion());await h.flush();assert.ok(text(h.tree).includes('다음 계획 다시 확인'));assert.equal(text(h.tree).includes('오늘 계획을 모두 마쳤어요.'),false);
});


test('changing only planId after completion unmounts the old interview and opens a fresh same-school lesson',async()=>{
 const h=harness({dayTasks:[{id:'plan-a',kind:'focus',title:'마친 질문',minutes:25},{id:'next-focus',kind:'focus',title:'다음 활동 질문',minutes:25},{id:'review',kind:'review',title:'오늘 정리',minutes:10}]});
 await h.flush();h.action('훈련 시작').props.onClick();await h.flush();h.deferreds[0].resolve({session:{id:'first-session'}});await h.flush();
 const oldUpdate=h.interview().props.onTrainingUpdate;oldUpdate(h.completion());await h.flush();assert.equal(h.interview(),undefined,'completed summary removes the InterviewSession that owns LiveSession listeners');
 const next=nodes(h.tree).find(node=>node.type==='a'&&node.props.href==='/my/train?planId=next-focus');assert.ok(next,'completed Live continuation uses a native anchor with a real plan URL');assert.equal(next.props.onClick,undefined,'no client router interception can retain the completed document');
 h.changePlan('next-focus');await h.flush();assert.ok(h.action('훈련 시작'));assert.equal(text(h.tree).includes('훈련 완료'),false);assert.equal(h.interview(),undefined,'the old session is never reused by a new query-only plan');
 oldUpdate(h.completion());await h.flush();assert.equal(text(h.tree).includes('훈련 완료'),false,'a late callback from the completed plan cannot restore its summary');
 h.action('훈련 시작').props.onClick();await h.flush();assert.equal(h.requests.filter(call=>call.input.action==='task_start').at(-1).input.planId,'next-focus');
 h.deferreds[1].resolve({session:{id:'next-session'}});await h.flush();assert.equal(h.interview().props.id,'next-session');
});

test('connected interviews enable the existing capped follow-up chain while diagnosis stays unaided',async()=>{
 for(const [kind,diagnostic,followups] of [['mixed',false,true],['focus',false,true],['diagnostic',true,false]] as const){
  const h=harness({kind,diagnostic});await h.flush();h.action(diagnostic?'답변 연습 시작':'훈련 시작').props.onClick();await h.flush();
  const started=h.requests.find(request=>request.url==='/api/interviews'&&request.input.action==='start');assert.equal(started.input.followups,followups);assert.equal(started.input.questionCount,kind==='mixed'?4:1);assert.equal(started.input.sessionMode,kind==='mixed'?'real':'practice');assert.equal(started.input.feedbackTiming,kind==='mixed'||diagnostic?'end':'turn');
  h.deferreds[0].resolve({session:{id:'session'}});await h.flush();
 }
});

test('daily reflection displays saved work and persists one improvement with exact scoped revisit choices',async()=>{
 const h=harness({kind:'review',pendingAction:'day_reflection'});await h.flush();assert.match(text(h.tree),/본질문 답변2개푼 퀴즈1개제출한 과제0개도움 사용1개남은 보완1개/);
 const input=nodes(h.tree).find(node=>node.type==='textarea'&&node.props.placeholder?.startsWith('예: 활동'));input.props.onChange({target:{value:'내가 한 행동을 먼저 말했다.'}});
 const choice=nodes(h.tree).find(node=>node.type==='button'&&text(node).includes('오늘 답한 질문'));choice.props.onClick();await h.flush();assert.equal(nodes(h.tree).find(node=>node.type==='button'&&text(node).includes('오늘 답한 질문')).props['aria-pressed'],true);
 h.action('오늘 정리 저장').props.onClick();await h.flush();const saved=h.requests.find(request=>request.input.action==='day_reflection').input;
 assert.equal(saved.improvement,'내가 한 행동을 먼저 말했다.');assert.deepEqual(JSON.parse(JSON.stringify(saved.revisitQuestionKeys)),['scope-school-a']);assert.equal(typeof saved.requestId,'string');
 h.deferreds[0].resolve({completed:true});await h.flush();assert.match(text(h.tree),/고른 질문 1개를 다음 계획에 반영했어요/);
});

test('quiz and assignment lessons dispatch their real tools with the original plan and no interview session',async()=>{
 const quiz=harness({kind:'quiz',pendingAction:'create'});await quiz.flush();quiz.action('퀴즈 시작').props.onClick();await quiz.flush();
 const created=quiz.requests.find(request=>request.input.action==='create');assert.equal(created.url,'/api/quiz');assert.equal(created.input.trainingPlanId,'plan-a');assert.deepEqual(JSON.parse(JSON.stringify(created.input.itemIds)),['item-a']);
 quiz.deferreds[0].resolve({session:{id:'quiz-a'}});await quiz.flush();assert.deepEqual(quiz.pushes,['/quiz/session/quiz-a?trainingPlanId=plan-a']);assert.equal(quiz.interview(),undefined);assert.equal(quiz.requests.some(request=>request.url==='/api/interviews'),false);
 const assignment=harness({kind:'assignment'});await assignment.flush();assignment.action('과제 시작').props.onClick();await assignment.flush();assert.deepEqual(assignment.pushes,['/quiz/assignments/assignment-a?trainingPlanId=plan-a']);assert.equal(assignment.requests.filter(request=>request.input.action==='task_start').length,1);
 const actualStart=assignment.requests.find(request=>request.url==='/api/learning');assert.equal(actualStart.input.action,'assignment_start');assert.equal(actualStart.input.assignmentId,'assignment-a');assert.match(actualStart.input.requestId,/^[0-9a-f-]{36}$/i);
});

test('assignment handoff waits for the validated start and retries a failed start with the same receipt',async()=>{
 const h=harness({kind:'assignment',pendingAction:'assignment_start'});await h.flush();h.action('과제 시작').props.onClick();await h.flush();
 assert.deepEqual(h.pushes,[],'the assignment page does not open before the server accepts its current snapshot');assert.equal(h.action('과제 시작').props.pending,true);
 const first=h.requests.find(request=>request.input.action==='assignment_start').input;h.deferreds[0].reject(Error('과제 자료를 다시 확인해 주세요.'));await h.flush();
 assert.deepEqual(h.pushes,[]);assert.match(text(h.tree),/과제 자료를 다시 확인해 주세요/);assert.equal(h.action('과제 시작').props.pending,false);
 h.action('과제 시작').props.onClick();await h.flush();const retried=h.requests.filter(request=>request.input.action==='assignment_start').at(-1).input;assert.equal(retried.requestId,first.requestId);assert.equal(retried.assignmentId,first.assignmentId);
 h.deferreds[1].resolve({assignment:{id:'assignment-a',state:'in_progress'}});await h.flush();assert.deepEqual(h.pushes,['/quiz/assignments/assignment-a?trainingPlanId=plan-a']);
});

test('a late assignment start acknowledgement never navigates back into the previous school',async()=>{
 const h=harness({kind:'assignment',pendingAction:'assignment_start'});await h.flush();h.action('과제 시작').props.onClick();await h.flush();h.changeScope('school-b');await h.flush();
 h.deferreds[0].resolve({assignment:{id:'assignment-a',state:'in_progress'}});await h.flush();assert.deepEqual(h.pushes,[]);assert.equal(h.action('과제 시작').props.pending,false);
});


test('saved daily reflection reloads its all-school review plan before displaying the latest remaining requests',async()=>{
 const h=harness({kind:'review',pendingAction:'day_reflection'});await h.flush();const gate=deferred();h.setPlanReadOverride(()=>gate.promise);
 h.action('오늘 정리 저장').props.onClick();await h.flush();h.deferreds[0].resolve({completed:true});await h.flush();
 assert.equal(h.planReads.at(-1),'/api/training?planId=plan-a','refresh uses the review plan so its dayReview covers every school');assert.equal(text(h.tree).includes('오늘 정리 완료'),false,'the old counts are not shown as the saved result');
 gate.resolve({selectedTask:{id:'plan-a',kind:'review',completed:true},today:{tasks:[]},dayReview:{date:'2026-10-21',targetId:null,answers:7,quizAnswers:3,assignmentAnswers:2,assistedAnswers:4,remainingReview:5,questions:[{key:'school-b-question',targetId:'school-b',title:'다른 학교에서 답한 질문'}]}});await h.flush();
 assert.match(text(h.tree),/오늘 정리 완료/);assert.match(text(h.tree),/본질문 답변7개푼 퀴즈3개제출한 과제2개도움 사용4개남은 보완5개/);assert.equal(h.refreshes,1);
});

test('a late daily-review projection cannot replace the new account or school after save',async()=>{
 const h=harness({kind:'review',pendingAction:'day_reflection'});await h.flush();const gate=deferred();let oldRead=true;h.setPlanReadOverride(async()=>oldRead?gate.promise:{selectedTask:{id:'plan-school-b',kind:'review'},dayReview:{targetId:null,answers:1,questions:[]}});
 h.action('오늘 정리 저장').props.onClick();await h.flush();h.deferreds[0].resolve({completed:true});await h.flush();oldRead=false;h.changeScope('school-b','student-b');await h.flush();
 gate.resolve({selectedTask:{id:'plan-a',kind:'review',completed:true},dayReview:{targetId:null,answers:987,remainingReview:654,questions:[]}});await h.flush();
 assert.equal(text(h.tree).includes('987'),false);assert.equal(text(h.tree).includes('654'),false);assert.equal(text(h.tree).includes('오늘 정리 완료'),false);assert.equal(h.refreshes,0);assert.equal(h.action('오늘 정리 저장').props.pending,false);
});


test('real training lets the student choose pressure while practice follows the saved quest',async()=>{
 const real=harness({kind:'mixed'});await real.flush();
 let radios=nodes(real.tree).filter(node=>node.type==='input'&&node.props.name==='training-pressure');assert.equal(radios.length,2);assert.equal(radios[0].props.checked,true);
 radios[1].props.onChange();await real.flush();real.action('훈련 시작').props.onClick();await real.flush();
 assert.equal(real.requests.find(request=>request.url==='/api/interviews').input.pressure,true);
 real.changeScope('school-b');await real.flush();radios=nodes(real.tree).filter(node=>node.type==='input'&&node.props.name==='training-pressure');assert.equal(radios[0].props.checked,true,'new school starts with ordinary interview mode');
 for(const pressure of [false,true]){const practice=harness({kind:'focus',pressure});await practice.flush();assert.equal(nodes(practice.tree).filter(node=>node.type==='input'&&node.props.name==='training-pressure').length,0);practice.action('훈련 시작').props.onClick();await practice.flush();assert.equal(practice.requests.find(request=>request.url==='/api/interviews').input.pressure,pressure);}
});
