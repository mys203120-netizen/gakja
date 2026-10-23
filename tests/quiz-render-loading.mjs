import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';
const {growthContextKey}=await tsImport('../apps/web/src/lib/learning-growth.ts',import.meta.url);
import {learningTargetIdentityMatches} from '../packages/content-contracts/src/workflows.ts';
import * as quizView from '../apps/web/src/lib/quiz-session-view.ts';
import {sendOnEnter} from '../apps/web/src/lib/client/enter-send.ts';

// Render the actual component through lightweight hook/JSX adapters. A populated
// question library matters: the loading regression previously crashed inside find().
// Effects are not run. Selected QuizHome handlers use an in-memory save adapter;
// this test touches no network, DB, AI or device.
const source = fs.readFileSync(new URL('../apps/web/src/components/quiz-v3.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const state = { values: [], hook: 0, calls: 0, query: '', allowStart: false, starts: [], navigations: [], resources: [], writes: [], refs: [] };
const data = {
  user: { id: 'synthetic-render-student', role: 'student' }, package: { active_version: 4 },
  targets: [],
  learning: {
    activities: [{id:'activity',title:'승인 당시 활동'}], support_targets: [], source_refs: [], answer_scripts: [],
    questions: [
      { id: 'personal-question', prompt: '내 역할을 설명해 주세요.', activity_ids: ['activity'], question_types: ['activity'] },
      { id: 'concept-question', prompt: '표면에 붙는 개념을 설명해 주세요.', activity_ids: ['activity'], question_types: ['concept'] },
    ],
    memory_items: [{ id: 'concept-memory', question_id: 'concept-question', activity_ids: ['activity'] }],
  },
};
const module = { exports: {} };
const actionButton = ({pending=false,pendingLabel,disabled,children,type='button',...props}) => ({type:'button',props:{...props,type,disabled:disabled||pending,'aria-busy':pending||undefined,children:pending?[{type:'LoaderCircle',props:{size:16,'aria-hidden':true}},pendingLabel??children]:children}});
vm.runInNewContext(output, {
  module, exports: module.exports, URLSearchParams,
  require(name) {if(name==='@/lib/privacy-policy')return {PRIVACY_POLICY_VERSION:'2026-10-22'};if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
    if(name==='@/lib/client/device-storage')return {setDeviceItem:()=>{}};
    if(name==='@/lib/client/draft-save')return {registerDraftSaver:()=>()=>{}};
    if(name==='@/lib/client/enter-send')return {sendOnEnter};
    if (name === 'react') return {
      useState(initial) { const index = state.hook++; return [index < state.values.length ? state.values[index] : typeof initial === 'function' ? initial() : initial, value => state.writes.push({index,value})]; },
      useRef: value => {const ref={current:value};state.refs.push(ref);return ref;}, useEffect: () => {}, useCallback: callback => callback,
    };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => type===actionButton?actionButton(props):({ type, props }), jsxs: (type, props) => type===actionButton?actionButton(props):({ type, props }), Fragment: 'Fragment' };
    if (name === 'next/link') return { __esModule: true, default: 'Link' };
    if (name === 'next/navigation') return { useRouter: () => ({ push: path => { if (!state.allowStart) throw new Error('Render must not navigate'); state.navigations.push(path); } }), useSearchParams: () => new URLSearchParams(state.query) };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
    if (name === './shared') return {
      api: () => { state.calls++; throw new Error('Render must not request data'); },
      post: async (path, payload) => { state.calls++; if (!state.allowStart) throw new Error('Render must not save data'); assert.equal(path, '/api/quiz'); state.starts.push(payload); return {session:{id:'synthetic-selected-mode'}}; },
      ActionButton:actionButton, Alert: 'Alert', Breadcrumb: 'Breadcrumb', Empty: 'Empty', PageTitle: 'PageTitle', Spinner: 'Spinner',
    };
    if (name === './app-shell') return { useApp: () => ({ data, refresh: () => { state.calls++; }, openResource: value => state.resources.push(value) }) };
    if (name === '@/lib/learning-growth') return { growthContextKey };
    if (name === '@gakja/content-contracts/workflows') return {learningTargetIdentityMatches};
    if (name === '@/lib/quiz-session-view') return quizView;
    if (name.endsWith('.module.css')) return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
    if (name === './practice-writing-help') return {PracticeWritingHelp:'PracticeWritingHelp'};
    if (name === './training-continuation') return {TrainingContinuation:'TrainingContinuation'};
      if (name === '@/lib/client/recording-recovery') return {readRecordingRecovery:async()=>null,installRecordingExitGuard:()=>()=>{}};
      if (name === './learning-help') return { LearningHelp: 'LearningHelp' };
    if (name === './audio-level-dot') return { AudioLevelDot: 'AudioLevelDot' };
    if (name === './playful-flow') return { animateStudyReceipt: () => { throw new Error('Render must not play a completion animation'); } };
    if (name === '@/lib/client/speech-recorder') return { startSpeechCapture: () => { throw new Error('Render must not start microphone capture'); } };
    if (name === '@/lib/client/realtime-transcription') return {connectLiveTranscription:()=>{throw Error('Render must not start live transcription');}};
    if (name === '@/lib/recording-upload-client') return { uploadRecording: () => { state.calls++; throw new Error('Render must not upload recordings'); } };
    throw new Error(`Unexpected import: ${name}`);
  },
});

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function render(component, values = []) {
  if(component==='QuizHome'&&values[0]&&!values[0].scope){render(component);values=[{scope:state.refs[0].current.scope,value:values[0]},...values.slice(1)];}
  state.values = values; state.hook = 0; state.refs=[];
  return module.exports[component](component === 'QuizSession' ? { id: 'synthetic-session' } : {});
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props?.children) : '';
}
function primary(tree) { return nodes(nodes(tree).find(node => node.type === 'section' && node.props.className === 'quiz-today')).find(node => node.type === 'button'); }
function dto(overrides = {}) {
  return { session: { id: 'synthetic-session', student_id: data.user.id, state: 'ready', mode: 'answer', current_index: 0, content_version: 2, items: [{ id: 'personal-memory', question_id: 'personal-question', prompt: '내 역할을 설명해 주세요.', activity_ids: ['activity'], kind: 'keyword_recall', practice_kind: 'personal', hasHint: false }], ...overrides }, learning:structuredClone(data.learning), responses: [], recordings: [] };
}

let tree = render('QuizSession');
check(nodes(tree).some(node => node.type === 'Spinner'), 'initial session render shows loading with an already populated question library');
check(!nodes(tree).some(node => node.type === 'LearningHelp'), 'loading does not invent a current question');
tree = render('QuizSession', [null, '기록을 불러오지 못했어요.']);
check(nodes(tree).some(node => node.type === 'Alert' && node.props.children === '기록을 불러오지 못했어요.'), 'failed initial request remains a renderable error');
check(!nodes(tree).some(node => node.type === 'Spinner'), 'request failure does not hide behind a permanent spinner');

for (const status of ['ready', 'paused']) {
  tree = render('QuizSession', [dto({ state: status })]);
  check(nodes(tree).some(node => node.type === 'button' && typeof node.props.onClick === 'function'), `${status} session with no responses has an accessible start control`);
  check(!nodes(tree).some(node => node.type === 'Link' && String(node.props.children).includes('이 질문 면접')), `${status} session does not derive a next question from an absent answer`);
}
for (const status of ['ended', 'completed']) {
  tree = render('QuizSession', [dto({ state: status, current_index: 1 })]);
  check(nodes(tree).some(node => node.type === 'h2' && node.props.children === '다음에 다시 준비해요.'), `${status} session with no submitted answers renders its empty result`);
  check(nodes(tree).some(node => node.type === 'Link' && node.props.href === '/quiz'), `${status} empty result still returns to the quiz library`);
}

const personal = dto({ state: 'completed', current_index: 1 });
personal.responses = [{ id: 'personal-response', item_index: 0, response: '실제로 맡은 역할을 설명했습니다.', outcome: null, data: {} }];
tree = render('QuizSession', [personal]);
check(nodes(tree).some(node => node.type === 'Link' && node.props.href.includes('questionId=personal-question') && node.props.href.includes('sourceVersion=2')), 'completed personal answer keeps its own question and original source version');

const concept = dto({ state: 'completed', current_index: 1, items: [{ id: 'concept-memory', question_id: 'concept-question', linked_question_id: 'personal-question', prompt: '표면에 붙는 개념은?', practice_prompt: '표면에 붙는 개념을 설명해 주세요.', practice_kind: 'concept', kind: 'choice', activity_ids: ['activity'], options: [{ id: 'option-a', text: '흡착' }] }] });
concept.responses = [{ id: 'concept-response', item_index: 0, selected_option_id: 'option-a', response: '', outcome: true, data: { correct_answer: '흡착' } }];
tree = render('QuizSession', [concept]);
nodes(tree).find(node=>node.type==='button'&&text(node)==='질문과 원문').props.onClick();check(state.resources.at(-1).id==='concept-question','completed concept answer keeps its archived concept resource');

const review = dto({ state: 'completed', current_index: 2 });
review.session.items = [personal.session.items[0], concept.session.items[0]];
review.responses = [
  { id: 'review-first', item_index: 0, response: '다시 설명해 보고 싶은 답변입니다.', outcome: null, rating: 'again', data: {} },
  { id: 'saved-last', item_index: 1, response: '내 말로 설명한 답변입니다.', outcome: null, rating: 'good', data: {} },
];
tree = render('QuizSession', [review]);
check(nodes(tree).filter(node=>node.type==='article'&&node.props.className==='quiz-result-answer')[0].props['aria-labelledby']==='quiz-result-review-first','collapsed results place review answers before saved answers');
check(nodes(tree).some(node => node.type === 'dt' && node.props.children === '미채점 저장'), 'ungraded written answers are not presented as scored correctness');

tree = render('QuizHome');
check(nodes(tree).some(node => node.type === 'Spinner'), 'quiz home initially shows loading');
const home={contentVersion:4,library:{choice:[{id:'choice-one',question_id:'question-one'},{id:'choice-two',question_id:'question-two',linked_question_id:'question-one'}],answer:[],oral:[]},sessions:[],recommendation:{count:2,reason:'오늘 다시 떠올릴 질문'}};
tree=render('QuizHome',[{...home,library:{choice:[]}}]);
check(text(tree).includes('정답과 근거가 확인된 객관식 문항을 준비하고 있어요.')&&!primary(tree),'an empty verified library never offers a fabricated quiz start');
check(state.calls===0,'render makes no API, save or refresh requests');
state.allowStart=true;
for(const query of ['', 'mode=oral','mode=answer','mode=unexpected','focus=free']) {
 state.query=query;tree=render('QuizHome',[home]);
 check(text(primary(tree))==='퀴즈 시작'&&text(tree).includes('문제마다 10초, 정답은 네 보기 중 하나예요.'),'all new quiz entry paths explain the four-choice ten-second format');
 check(!nodes(tree).some(node=>node.type==='fieldset'||node.props?.className==='quiz-mode-row'),'removed mode and unlimited-timer controls are absent');
 primary(tree).props.onClick();await new Promise(resolve=>setImmediate(resolve));
 check(state.starts.at(-1).mode==='choice'&&state.starts.at(-1).timed===true,'new sessions are always timed choice quizzes');
 check(state.navigations.at(-1)==='/quiz/session/synthetic-selected-mode','explicit start navigates to its created session');
}
state.query='questionId=question-one';tree=render('QuizHome',[home]);primary(tree).props.onClick();await new Promise(resolve=>setImmediate(resolve));
check(JSON.stringify(state.starts.at(-1).itemIds)===JSON.stringify(['choice-one','choice-two']),'question-scoped starts retain both direct and source-linked quiz items');
state.query='questionId=removed';tree=render('QuizHome',[home]);check(!primary(tree),'removed question does not launch unrelated quiz items');

// Publication can change the same logical question/activity IDs. A stored quiz
// must still use its own published resources and never borrow the latest rubric.
data.learning.questions[0].prompt='새 발행본의 다른 질문';
data.learning.activities[0].title='새 발행본의 다른 활동';
tree=render('QuizSession',[personal]);
const oldInterview=nodes(tree).find(node=>node.type==='Link'&&text(node).includes('다시 연습'));
check(new URLSearchParams(oldInterview.props.href.split('?')[1]).get('sourceType')==='personal'&&new URLSearchParams(oldInterview.props.href.split('?')[1]).get('sourceVersion')==='2','old personal interview keeps explicit personal namespace and original version after republication');
const originalResource=nodes(tree).find(node=>node.type==='button'&&text(node)==='질문과 원문');
originalResource.props.onClick();
check(state.resources.at(-1).snapshot.learning.questions[0].prompt==='내 역할을 설명해 주세요.'&&state.resources.at(-1).snapshot.learning.activities[0].title==='승인 당시 활동','original evidence control opens fixed approved question/activity rather than the newer same IDs');
const legacy={...personal,learning:null,originalSourceUnavailable:true};
tree=render('QuizSession',[legacy]);
check(!nodes(tree).some(node=>node.type==='Link'&&text(node).includes('다시 연습')),'missing historical sources cannot be silently replaced with current question metadata');
check(nodes(tree).some(node=>node.type==='p'&&text(node).includes('저장 당시 근거를 불러올 수 없어요')),'missing original sources leave the saved answer readable with an explicit source status');

state.query='sourceType=personal&sourceVersion=2';
tree=render('QuizHome',[{...home,contentVersion:2}]);primary(tree).props.onClick();await new Promise(resolve=>setImmediate(resolve));
check(state.starts.at(-1).sourceType==='personal'&&state.starts.at(-1).sourceVersion===2,'quiz create pins the historical library version actually displayed');
state.query='';tree=render('QuizHome',[home]);primary(tree).props.onClick();await new Promise(resolve=>setImmediate(resolve));
check(state.starts.at(-1).sourceType==='personal'&&state.starts.at(-1).sourceVersion===4,'ordinary create pins the displayed publication');

const historicTarget={id:'synthetic-target',university:'원래 학교',department:'환경공학과',campus:'본교',admission_year:2027,admission_type:'학생부종합'};
const targetChanged={...personal,session:{...personal.session,metadata:{targetId:historicTarget.id,targetSnapshot:historicTarget}},learning:{...personal.learning,support_targets:[historicTarget]}};
data.targets=[{...historicTarget,department:'다른 학과'}];
tree=render('QuizSession',[targetChanged]);
check(nodes(tree).some(node=>node.type==='Link'&&text(node).includes('다시 연습')&&new URLSearchParams(node.props.href.split('?')[1]).get('targetId')===historicTarget.id),'historical personal practice retains the original target snapshot through its published version even after registration changes');
const wrongTarget={...targetChanged,learning:{...targetChanged.learning,support_targets:[data.targets[0]]}};
tree=render('QuizSession',[wrongTarget]);
check(!nodes(tree).some(node=>node.type==='Link'&&text(node).includes('다시 연습')),'a missing original school snapshot cannot be reinterpreted as the current school');

const currentSchool={id:'scope-current',university:'서울시립대학교',department:'환경공학부',admission_year:2027,admission_type:'학생부종합',campus:'서울'};
const differentSchool={...currentSchool,id:'scope-other',university:'다른 대학교'};
data.targets=[currentSchool,differentSchool];
state.query='targetId=scope-current';
const openSession=(id,metadata)=>({id,metadata,state:'paused',mode:'choice',timed:true,topicLabel:'현재 질문',current_index:1,total:3,created_at:'2026-10-15T00:00:00Z'});
const sessions=[openSession('changed',{targetId:currentSchool.id,targetSnapshot:{...currentSchool,department:'이전 학과'}}),openSession('current',{targetId:currentSchool.id,targetSnapshot:currentSchool}),openSession('other',{targetId:differentSchool.id,targetSnapshot:differentSchool}),openSession('unspecified',{})];
tree=render('QuizHome',[{...home,target:currentSchool,sessions}]);
check(nodes(tree).filter(node=>node.type==='Link'&&node.props.href.startsWith('/quiz/session/')).map(node=>node.props.href).join(',')==='/quiz/session/current','primary resume excludes other, unknown and changed school identities');
check(nodes(tree).some(node=>node.type==='details'&&!node.props.open&&text(node).includes('새 퀴즈 시작')),'new quiz action stays in a disclosure when current work can resume');
check(nodes(tree).some(node=>node.type==='Link'&&node.props.href==='/records/history'),'all past and other-context sessions remain reachable through history');
for(const legacy of [openSession('id-only',{targetId:currentSchool.id}),{...sessions[1],timed:false}]){
 tree=render('QuizHome',[{...home,target:currentSchool,sessions:[legacy]}]);
 check(!nodes(tree).some(node=>node.type==='Link'&&node.props.href.startsWith('/quiz/session/')),'unverified identity and historical untimed sessions do not masquerade as current timed quiz');
}
state.query='targetId=scope-other';tree=render('QuizHome',[{...home,target:differentSchool,sessions}]);
check(nodes(tree).some(node=>node.type==='Link'&&node.props.href==='/quiz/session/other'),'changing selected school changes primary resume');
// A completed cleanup can outlive a dropped response or an intentionally blank
// local draft. Recovery must be explicit and must never copy another item/audio.
const cleanedAudio={id:'saved-audio',session_id:'synthetic-session',item_index:0,display_transcript:'정리된 답변입니다.',transcript_cleanup:{status:'completed'},url:'/private/audio'};
function transcriptValues({answer='직접 고친 초안',audio=cleanedAudio,busy=false,phase='idle',pending=null,processing=false,index=0}={}) {
  const values=[];values[0]=dto({state:'active',mode:'oral',current_index:index});values[2]=busy;values[4]=answer;values[9]=audio;values[11]=phase;values[17]=pending;values[18]=processing;return values;
}
const recoveryButton=tree=>nodes(tree).find(node=>node.type==='button'&&text(node)==='정리된 전사 사용');
for(const answer of ['', '직접 고친 초안']) {
  state.writes=[];tree=render('QuizSession',transcriptValues({answer}));
  const button=recoveryButton(tree);
  check(button&&!button.props.disabled,'completed current audio offers explicit recovery for empty or edited drafts');
  check(!state.writes.some(write=>write.index===4),'render never overwrites the empty or edited draft');
  button.props.onClick();
  check(state.writes.some(write=>write.index===4&&write.value===cleanedAudio.display_transcript),'explicit recovery copies only the cleaned current recording');
}
tree=render('QuizSession',transcriptValues({answer:cleanedAudio.display_transcript}));
check(!recoveryButton(tree),'already applied transcript does not show redundant recovery');
for(const audio of [{...cleanedAudio,item_index:1},{...cleanedAudio,id:null},{...cleanedAudio,session_id:'another-session'},{...cleanedAudio,transcript_cleanup:{status:'processing'}},{...cleanedAudio,display_transcript:'   '}]) {
  tree=render('QuizSession',transcriptValues({audio}));
  check(!recoveryButton(tree),'other item/session, missing ID, unfinished or empty cleanup cannot be offered as recovery');
}
for(const options of [{busy:true},{phase:'recording'},{phase:'uploading'},{pending:{index:0,durationMs:50}},{processing:true}]) {
  state.writes=[];tree=render('QuizSession',transcriptValues(options));
  const button=recoveryButton(tree);
  check(button?.props.disabled,'recovery is disabled while busy, recording, uploading, pending audio or transcript processing');
  button.props.onClick();
  check(!state.writes.some(write=>write.index===4),'disabled recovery also guards the handler from changing the answer');
}
state.writes=[];tree=render('QuizSession',transcriptValues());
const staleAudioButton=recoveryButton(tree);
state.refs.find(ref=>ref.current===cleanedAudio).current={...cleanedAudio,id:'replacement-audio'};
staleAudioButton.props.onClick();
check(!state.writes.some(write=>write.index===4),'stale recovery cannot apply a recording replaced by a newer recording');
state.writes=[];tree=render('QuizSession',transcriptValues());
const staleItemButton=recoveryButton(tree),sessionRef=state.refs.find(ref=>ref.current?.session?.id==='synthetic-session');
sessionRef.current={...sessionRef.current,session:{...sessionRef.current.session,current_index:1}};
staleItemButton.props.onClick();
check(!state.writes.some(write=>write.index===4),'stale recovery cannot copy a previous item transcript after the current item changes');
console.log(`PASS ${checks} quiz render/selected-mode handler checks (actual component; external API, DB, AI and device calls 0).`);
