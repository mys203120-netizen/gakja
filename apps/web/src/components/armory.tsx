'use client';
import Link from 'next/link';
import {useEffect,useState,useRef} from 'react';
import {useSearchParams,useRouter} from 'next/navigation';
import {Plus,ArrowRight,ArrowLeft,Bookmark,MessagesSquare,Camera,Search,ChevronDown} from 'lucide-react';
import {useApp} from './app-shell';
import {api,Alert,PageTitle,type Item} from './shared';
import {experienceSteps,experienceOutline,type Experience,type ExperienceCard} from '@/lib/armory-model';
import {interviewSetupHref} from '@/lib/interview-flow';
import {interviewSupportForTarget} from '@/lib/school-interview-scope';
import styles from './armory.module.css';
import {ArmoryAssist} from './armory-assist';
import {ExperienceTextClassifier} from './experience-text-classifier';
import {experienceQuestionSuggestions} from '@/lib/armory-recommendations';
import {chooseExperienceDraftVersion,createExperienceDraftSync,draftMatchesSource,experienceDraftContent,migrateExperienceDraft,preserveExperienceDraftVersions,readExperienceDraftBackups,readExperienceDrafts,removeExperienceDraft,writeExperienceDraft,type ExperienceDraft,type ExperienceDraftBackup} from '@/lib/armory-drafts';
const empty=():Experience=>({title:'',category:'협업',situation:'',action:'',result:'',confirmed:false,pinned:false,sourceNote:'학생이 직접 작성한 경험'});
const categories=['협업','실패','강점','탐구'] as const;
const categoryHints:Record<Experience['category'],string>={협업:'함께 문제를 풀었던 일',실패:'뜻대로 되지 않아 바꿔본 일',강점:'내 역할이 도움이 되었던 일',탐구:'궁금한 것을 직접 확인한 일'};
type ArmoryQuestion=Item&{id:string;prompt:string};
type DraftConflict={local:ExperienceDraft;remote:ExperienceDraft|null;card:ExperienceCard|null;backedUp:boolean;error:string};
const versionText=(record:ExperienceDraft)=>[['경험 이름',record.draft.title||'(제목 없음)'],['유형',record.draft.category],['상황',record.draft.situation],['내 행동',record.draft.action],['결과·배운 점',record.draft.result],['붙여넣은 원문',record.draft.originalText||'']].map(([label,value])=>label+'\n'+value).join('\n\n');
export function Armory(){
 const {data,targetId}=useApp();const params=useSearchParams();const router=useRouter();const editorHeading=useRef<HTMLHeadingElement>(null);const openedCard=useRef('');
 const target=data.targets.find(item=>item.id===targetId);
 const questionSource=target&&interviewSupportForTarget(target).supported===false?'personal':'common';
 const [cards,setCards]=useState<ExperienceCard[]>([]),[sessions,setSessions]=useState<Item[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState(params.get('card')||''),[editing,setEditing]=useState(false),[draft,setDraft]=useState<Experience>(empty),[draftId,setDraftId]=useState(''),[revision,setRevision]=useState(0),[step,setStep]=useState(0),[tab,setTab]=useState('questions'),[search,setSearch]=useState(''),[questions,setQuestions]=useState<ArmoryQuestion[]>([]),[questionId,setQuestionId]=useState(''),[questionError,setQuestionError]=useState('');
 const [saved,setSaved]=useState('');
 const [validation,setValidation]=useState(''),[questionLoading,setQuestionLoading]=useState(true),[questionRetry,setQuestionRetry]=useState(0);
 useEffect(()=>{if(editing)editorHeading.current?.focus();},[editing,step]);
 function nextStep(){if(step<2&&!draft[experienceSteps[step].key].trim()){setValidation(step===0?'어떤 상황이었는지 한 문장만 적어주세요.':'내가 직접 한 행동을 한 문장만 적어주세요.');return;}setValidation('');setStep(step===1?3:step+1);}
 function selectCard(id:string){setSelected(id);setQuestionId('');setTab(cards.find(c=>c.id===id)?.data.confirmed?'questions':'experience');setSaved('');router.replace(id?'/armory?card='+encodeURIComponent(id):'/armory',{scroll:false});}
 const [localDrafts,setLocalDrafts]=useState<ExperienceDraft[]>([]),[draftStatus,setDraftStatus]=useState(''),[showAllQuestions,setShowAllQuestions]=useState(false);
 const [conflict,setConflict]=useState<DraftConflict|null>(null),[backups,setBackups]=useState<ExperienceDraftBackup[]>([]),[copyStatus,setCopyStatus]=useState('');
 const conflictRef=useRef<DraftConflict|null>(null),conflictLoading=useRef(false);
 const draftSnapshot=useRef<ExperienceDraft|null>(null),saveLock=useRef(false),autosaveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const sync=useRef(createExperienceDraftSync(async record=>(await api('/api/armory/drafts',{method:'PUT',body:JSON.stringify(record)})).draft));
 useEffect(()=>{try{migrateExperienceDraft(localStorage,sessionStorage,data.user.id);setLocalDrafts(readExperienceDrafts(localStorage,data.user.id));setBackups(readExperienceDraftBackups(localStorage,data.user.id));}catch{setDraftStatus('이 기기의 저장 공간을 확인해 주세요. 서버 저장 상태를 확인하며 작성해 주세요.');}
  let active=true;api('/api/armory/drafts').then(result=>{if(!active)return;const remoteDrafts=(result.drafts||[]) as ExperienceDraft[];try{const local=readExperienceDrafts(localStorage,data.user.id);for(const remote of remoteDrafts)if(!local.some(item=>item.id===remote.id))writeExperienceDraft(localStorage,data.user.id,remote);}catch{}setLocalDrafts(previous=>[...previous,...remoteDrafts.filter(remote=>!previous.some(item=>item.id===remote.id))]);}).catch(()=>{if(active)setDraftStatus('서버 초안을 불러오지 못했어요. 이 기기에 보관한 초안은 계속 쓸 수 있어요.');});return()=>{active=false;};},[data.user.id]);
 async function syncRecord(record:ExperienceDraft){
  let acknowledged:ExperienceDraft;try{acknowledged=await sync.current.sync(record);}catch(reason){if((reason as Error).name!=='DraftSyncCancelled')void inspectDraftVersions(record);throw reason;}
  if(conflictRef.current?.local.id===record.id)throw Object.assign(Error('버전을 비교하는 동안 이전 초안 저장을 멈췄어요.'),{name:'DraftSyncCancelled'});
  // Persist the acknowledgement even if navigation unmounted the editor meanwhile.
  try{const latest=readExperienceDrafts(localStorage,data.user.id).find(item=>item.id===record.id);if(latest)writeExperienceDraft(localStorage,data.user.id,{...latest,serverRevision:acknowledged.serverRevision});}catch{}
  setLocalDrafts(previous=>previous.map(item=>item.id===record.id?{...item,serverRevision:acknowledged.serverRevision}:item));
  if(draftSnapshot.current?.id===record.id){draftSnapshot.current={...draftSnapshot.current,serverRevision:acknowledged.serverRevision};if(experienceDraftContent(draftSnapshot.current)===experienceDraftContent(record))setDraftStatus('자동 저장됨 · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false}));}
  return acknowledged;
 }
 function preserveConflictVersions(value:DraftConflict){
  const records:ExperienceDraftBackup[]=[{id:crypto.randomUUID(),label:'이 기기의 초안 · 비교 전 원문',record:value.local},...(value.remote?[{id:crypto.randomUUID(),label:'서버 초안 · 비교 전 원문',record:value.remote}]:[]),...(value.card?[{id:crypto.randomUUID(),label:`저장된 경험 v${value.card.revision} · 비교 전 원문`,record:{...value.local,draft:{...value.card.data,confirmed:false},revision:value.card.revision,step:0}}]:[])];
  preserveExperienceDraftVersions(localStorage,data.user.id,records);setBackups(readExperienceDraftBackups(localStorage,data.user.id));
 }
 async function inspectDraftVersions(record=draftSnapshot.current,force=false){
  if(!record||conflictLoading.current||draftSnapshot.current?.id!==record.id)return;conflictLoading.current=true;
  try{const [pending,current]=await Promise.all([api('/api/armory/drafts'),api('/api/armory')]);
   if(draftSnapshot.current?.id!==record.id)return;
   const local=draftSnapshot.current,remote=(pending.drafts as ExperienceDraft[]).find(item=>item.id===record.id)||null,source=(current.cards as ExperienceCard[]).find(item=>item.id===record.id)||null;
   const changedSource=!draftMatchesSource(local,source),changedDraft=remote&&remote.serverRevision!==local.serverRevision&&experienceDraftContent(remote)!==experienceDraftContent(local);
   if(!force&&!changedSource&&!changedDraft)return;
   if(autosaveTimer.current)clearTimeout(autosaveTimer.current);sync.current.forget(record.id);
   let value:DraftConflict={local,remote,card:source,backedUp:false,error:''};
   try{preserveConflictVersions(value);value={...value,backedUp:true};}catch{value={...value,error:'두 버전을 이 기기에 보관하지 못했어요. 아래 글을 복사해 두거나 저장 공간을 확보한 뒤 다시 시도해 주세요.'};}
   conflictRef.current=value;setConflict(value);setCards(current.cards);setDraftStatus('버전이 달라 자동 저장을 잠시 멈췄어요. 내용을 비교하고 이어 쓸 글을 선택해 주세요.');
  }catch{if(force)setError('최신 버전을 불러오지 못했어요. 이 기기의 글을 유지하고 있어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.');}finally{conflictLoading.current=false;}
 }
 function selectDraftVersion(choice:'local'|'remote'|'card'|'copy'){
  const value=conflictRef.current;if(!value||!value.backedUp)return;
  try{const chosen=chooseExperienceDraftVersion(value.local,value.remote,value.card,choice,choice==='copy'?crypto.randomUUID():undefined);writeExperienceDraft(localStorage,data.user.id,chosen);sync.current.forget(value.local.id);conflictRef.current=null;setConflict(null);setCopyStatus('');recover(chosen);setLocalDrafts(readExperienceDrafts(localStorage,data.user.id));setError('');}catch(reason){setConflict({...value,error:(reason as Error).message});}
 }
 async function copyVersion(record:ExperienceDraft){try{await navigator.clipboard.writeText(versionText(record));setCopyStatus('선택한 버전을 복사했어요.');}catch{setCopyStatus('자동 복사를 사용할 수 없어요. 아래 글 전체를 선택해 복사해 주세요.');}}
 useEffect(()=>{if(!editing||!draftId||conflictRef.current)return;const record:ExperienceDraft={id:draftId,draft:{...draft,confirmed:false},revision,step,updatedAt:new Date().toISOString(),serverRevision:draftSnapshot.current?.id===draftId?draftSnapshot.current.serverRevision:0};draftSnapshot.current=record;
  try{writeExperienceDraft(localStorage,data.user.id,record);setDraftStatus('이 기기에 보관됨 · 서버 저장 대기');}catch{setDraftStatus('이 기기에 보관하지 못했어요 · 서버 저장 대기');}
  setLocalDrafts(previous=>[record,...previous.filter(item=>item.id!==record.id)]);
  autosaveTimer.current=setTimeout(()=>{setDraftStatus('자동 저장 중…');void syncRecord(record).catch(reason=>{if(reason.name!=='DraftSyncCancelled')setDraftStatus('자동 저장 실패 · '+reason.message);});},1000);
  return()=>{if(autosaveTimer.current)clearTimeout(autosaveTimer.current);};
 },[editing,draft,draftId,revision,step,data.user.id,conflict]);
 function recover(stored:ExperienceDraft){conflictRef.current=null;setConflict(null);setDraft(stored.draft);setDraftId(stored.id);setRevision(stored.revision);setStep(stored.step);draftSnapshot.current=stored;setValidation('');setEditing(true);setError('');setSaved('');}
 async function keepDraftAndExit(){
  if(saveLock.current||conflictRef.current)return;const record=draftSnapshot.current;if(!record||record.id!==draftId){setError('초안을 준비하고 있어요. 잠시 후 다시 시도해 주세요.');return;}
  try{writeExperienceDraft(localStorage,data.user.id,record);setLocalDrafts(previous=>[record,...previous.filter(item=>item.id!==record.id)]);selectCard('');setEditing(false);setError('');return;}catch{}
  // If this device cannot keep the text, wait for a server receipt before leaving it.
  saveLock.current=true;setBusy(true);setError('');if(autosaveTimer.current)clearTimeout(autosaveTimer.current);
  try{await syncRecord(record);selectCard('');setEditing(false);}catch{setError('초안을 보관하지 못했어요. 입력한 글은 이 화면에 남아 있어요. 연결이나 기기 저장 공간을 확인한 뒤 다시 시도해 주세요.');}finally{saveLock.current=false;setBusy(false);}
 }
 function recoverBackup(backup:ExperienceDraftBackup){try{const copy=chooseExperienceDraftVersion(backup.record,null,null,'copy',crypto.randomUUID());writeExperienceDraft(localStorage,data.user.id,copy);setLocalDrafts(readExperienceDrafts(localStorage,data.user.id));recover(copy);}catch{setError('보관한 버전을 새 초안으로 저장하지 못했어요. 기기 저장 공간을 확인해 주세요.');}}
 async function load(){setLoading(true);setError('');try{const r=await api('/api/armory');setCards(r.cards);setSessions(r.sessions);}catch(e){setError((e as Error).message);}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 useEffect(()=>{setSelected(params.get('card')||'');},[params]);
 useEffect(()=>{let active=true;setQuestions([]);setQuestionId('');setQuestionError('');setQuestionLoading(true);api('/api/interviews?preview=1&sourceType='+questionSource+(targetId?'&targetId='+encodeURIComponent(targetId):'')).then(r=>{if(active){const sourceType=r.sourceKind==='common'?'common':'personal';setQuestions((r.questions||[]).filter((question:Item)=>sourceType==='common'?Boolean(question.common_revision):!question.common_revision&&Number(r.contentVersion)>0).map((question:Item)=>({...question,armorySourceType:sourceType,armorySourceVersion:sourceType==='common'?question.common_revision:r.contentVersion,armoryPracticeNotice:r.practiceNotice||null})));}}).catch(e=>{if(active)setQuestionError(e.message);}).finally(()=>{if(active)setQuestionLoading(false);});return()=>{active=false;};},[targetId,questionSource,questionRetry,data.package?.active_version]);
 useEffect(()=>{if(!editing)return;const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[editing]);
 const card=cards.find(c=>c.id===selected);const history=sessions.filter(s=>s.card?.id===selected);
 useEffect(()=>{if(!card){openedCard.current='';return;}if(openedCard.current!==card.id){openedCard.current=card.id;setTab(card.data.confirmed?'questions':'experience');}},[card?.id,card?.data.confirmed]);
 function begin(category:Experience['category']='협업',activity?:Item){conflictRef.current=null;setConflict(null);setDraft({...empty(),category,title:activity?.title||'',sourceNote:activity?`참고한 발행 활동: ${activity.title} · 내용은 학생이 직접 확인`:'학생이 직접 작성한 경험'});setDraftId(crypto.randomUUID());setRevision(0);setStep(0);setValidation('');setEditing(true);setError('');setSaved('');}
 function edit(){if(!card)return;const pending=localDrafts.find(item=>item.id===card.id);if(pending){recover(pending);return;}setDraft({...card.data,confirmed:false});setDraftId(card.id);setRevision(card.revision);setStep(0);draftSnapshot.current=null;setValidation('');setEditing(true);setSaved('');}
 async function save(confirmed:boolean){
  if(saveLock.current||conflictRef.current)return;saveLock.current=true;setBusy(true);setError('');if(autosaveTimer.current)clearTimeout(autosaveTimer.current);
  try{const record=draftSnapshot.current;if(!record||record.id!==draftId)throw new Error('초안을 준비하고 있어요. 잠시 후 다시 저장해 주세요.');const acknowledged=await syncRecord(record);
   const r=await api('/api/armory',{method:'POST',body:JSON.stringify({id:draftId,revision,draftRevision:acknowledged.serverRevision,data:{...draft,title:draft.title.trim()||`${draft.category} 경험`,confirmed}})});
   setCards(prev=>[r.card,...prev.filter(c=>c.id!==r.card.id)]);try{removeExperienceDraft(localStorage,data.user.id,draftId);}catch{}setLocalDrafts(previous=>previous.filter(item=>item.id!==draftId));sync.current.forget(draftId);draftSnapshot.current=null;setRevision(r.card.revision);selectCard(r.card.id);setEditing(false);setTab(confirmed?'questions':'experience');setSaved(confirmed?'내 경험 카드가 준비됐어요. 질문을 골라 연습해 보세요.':'초안을 저장했어요. 나중에 이어서 작성할 수 있어요.');
  }catch(e){void inspectDraftVersions();let localCopy=false;try{const current=draftSnapshot.current;localCopy=Boolean(current&&readExperienceDrafts(localStorage,data.user.id).some(item=>item.id===draftId&&experienceDraftContent(item)===experienceDraftContent(current)));}catch{}setError((e as Error).message+(localCopy?' 입력한 글은 이 기기의 초안에 보관했어요.':' 입력한 글은 현재 편집 화면에 남아 있어요. 저장이 완료될 때까지 화면을 유지해 주세요.'));}finally{saveLock.current=false;setBusy(false);}
 }
 async function pin(){if(!card)return;setBusy(true);try{const r=await api('/api/armory',{method:'POST',body:JSON.stringify({id:card.id,revision:card.revision,data:{...card.data,pinned:!card.data.pinned}})});setCards(prev=>prev.map(c=>c.id===card.id?r.card:c));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 function href(kind:'chat'|'video'){const question=questions.find(item=>item.id===questionId)!;return interviewSetupHref(kind,new URLSearchParams({questionId,sourceType:question.armorySourceType,sourceVersion:String(question.armorySourceVersion),experienceCardId:card!.id,experienceRevision:String(card!.revision)}),{targetId,count:1});}
 const filteredCards=[...cards].sort((a,b)=>Number(b.data.pinned)-Number(a.data.pinned)).filter(c=>[c.data.title,c.data.category,c.data.situation,c.data.action,c.data.result].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
 const currentStep=experienceSteps[step];const pickedQuestion=questions.find(q=>q.id===questionId);const questionSuggestions=card?experienceQuestionSuggestions(card.data,questions):[];
 useEffect(()=>{setShowAllQuestions(false);},[selected,targetId]);
 const activeSession=sessions.find(s=>s.state==='active')||data.interviews?.find(s=>s.state==='active');
 if(loading&&selected)return <div className={styles.page}><PageTitle title="나의 무기고"/><p role="status">경험을 불러오고 있어요.</p></div>;
 return <div className={styles.page}>
  {!editing&&<PageTitle title="나의 무기고">내가 직접 한 일을 정리하고, 면접에서 꺼내 쓸 이야기로 준비해요.</PageTitle>}
  {error&&<Alert>{error}<button className="text-link" onClick={load}>목록 다시 불러오기</button></Alert>}
  {saved&&<p role="status" className={styles.notice}>{saved}</p>}
  {!editing&&draftStatus.includes('못했')&&<p role="status" className={styles.hint}>{draftStatus}</p>}
  {editing&&conflict&&<section className={styles.conflict} aria-labelledby="draft-conflict-title"><h2 id="draft-conflict-title">초안의 버전이 달라요</h2><p>자동 저장을 멈췄어요. 아래 글을 비교하고 이어 쓸 버전을 선택해 주세요. 비교 전 원문은 이 기기의 ‘비교한 버전 보관함’에서 다시 열 수 있어요.</p>
   {!draftMatchesSource(conflict.local,conflict.card)&&<p className={styles.hint}>저장된 경험도 바뀌었어요. 이 기기 글은 새 경험으로 이어 쓸 수 있어요. 최신 경험을 보완하려면 저장된 경험을 선택해 주세요.</p>}
   <div className={styles.versionGrid}>{[{label:'이 기기의 초안',record:conflict.local,choice:'local' as const},...(conflict.remote?[{label:`서버 초안 v${conflict.remote.serverRevision}`,record:conflict.remote,choice:'remote' as const}]:[]),...(conflict.card?[{label:`저장된 경험 v${conflict.card.revision}`,record:{...conflict.local,draft:conflict.card.data,revision:conflict.card.revision,step:0},choice:'card' as const}]:[])].map(version=><article key={version.choice}><h3>{version.label}</h3><label><span className="sr-only">{version.label} 원문</span><textarea readOnly rows={11} value={versionText(version.record)}/></label><button type="button" className="button ghost" onClick={()=>void copyVersion(version.record)}>{version.label} 복사</button><button type="button" className="button primary" disabled={!conflict.backedUp||!draftMatchesSource(version.record,conflict.card)} onClick={()=>selectDraftVersion(version.choice)}>{version.choice==='card'?'저장된 경험부터 보완':version.choice==='remote'?'서버 초안으로 계속':'이 기기 초안으로 계속'}</button></article>)}</div>
   {copyStatus&&<p role="status">{copyStatus}</p>}{conflict.error&&<p role="alert">{conflict.error}</p>}
   <div className={styles.actions}><button className="button ghost" disabled={!conflict.backedUp} onClick={()=>selectDraftVersion('copy')}>이 기기 글을 새 경험으로</button><button className="button ghost" onClick={()=>void inspectDraftVersions(draftSnapshot.current,true)}>최신 버전 다시 확인</button><button className="button ghost" onClick={()=>{conflictRef.current=null;setConflict(null);setEditing(false);}}>선택은 나중에 · 목록으로</button></div>
  </section>}
  {editing?<section className={styles.editor} aria-label="경험 카드 만들기"><fieldset className={styles.editorFields} disabled={busy||Boolean(conflict)}><legend className="sr-only">경험 카드 편집</legend>
   <h2 ref={editorHeading} tabIndex={-1} className={styles.editorQuestion}>{step===0?'어떤 일이 있었나요?':currentStep?currentStep.question:'두 문장을 확인해 주세요'}</h2>
   {currentStep?<div className={styles.writingStep}>
    <p id="experience-hint" className={styles.hint}>{step===0?'함께한 활동이나 기억나는 상황을 한 문장만 적어주세요.':currentStep.hint}</p>
    <label><span className="sr-only">{currentStep.label}</span><textarea disabled={busy} aria-invalid={Boolean(validation)} aria-describedby="experience-hint experience-validation" key={currentStep.key} rows={5} maxLength={2000} value={draft[currentStep.key]} onChange={e=>{setDraft({...draft,[currentStep.key]:e.target.value});if(validation)setValidation('');}} placeholder={step===0?'예: 조별 발표를 준비하면서 역할이 잘 나뉘지 않았어요.':undefined}/></label>
   </div>:<>{experienceSteps.slice(0,2).map(item=><label key={item.key}>{item.label}<textarea disabled={busy} rows={3} maxLength={2000} value={draft[item.key]} onChange={e=>setDraft({...draft,[item.key]:e.target.value})}/></label>)}<details className={styles.optionalResult} open={draft.result.trim()?true:undefined}><summary>결과·배운 점 (선택)<ChevronDown size={16}/></summary><label>그 뒤 달라진 점이나 배운 점<textarea disabled={busy} rows={3} maxLength={2000} value={draft.result} onChange={e=>setDraft({...draft,result:e.target.value})}/></label><p className={styles.hint}>아직 떠오르지 않으면 비워두고 나중에 보완해도 괜찮아요.</p></details>{draft.originalText&&<details><summary>붙여넣은 원문 비교</summary><p>{draft.originalText}</p></details>}<p className={styles.hint}>실제로 내가 한 일인지 확인해 주세요. 결과·배운 점은 나중에 보완해도 괜찮아요.<br/>{draft.sourceNote}<br/>빈 항목은 미확인으로 남아요. 학생 확인은 공식 자료 검수를 뜻하지 않아요.</p>{revision>0&&<p className={styles.hint}>아래 확인·저장을 누르면 저장된 경험 v{revision}을 이 내용으로 보완해요. 이전 면접에서 사용한 경험과 답변은 그대로 남아요.</p>}</>}
   <p id="experience-validation" role="status" className={styles.validation}>{validation}</p>
   <div className={styles.editorActions}>{step>0&&<button className="button ghost" disabled={busy} onClick={()=>{setValidation('');setStep(step===3?1:step-1);}}>이전</button>}{step<3?<button className="button primary" disabled={busy} onClick={nextStep}>{step===1?'두 문장 확인하기':step===2?(draft.result.trim()?'확인하기':'나중에 보완하고 확인'):'다음'}<ArrowRight size={16}/></button>:<button className="button primary" disabled={busy||!draft.situation.trim()||!draft.action.trim()} onClick={()=>void save(true)}>{busy?'저장 중…':'내 경험 확인하고 저장'}</button>}</div>
   {step===0&&<p className={styles.startHint}>상황과 내가 한 일, 두 문장이면 시작할 수 있어요.</p>}
   <details className={styles.editorTools}><summary>제목·유형 및 작성 도구<ChevronDown size={16}/></summary><label>경험 이름 (선택)<input disabled={busy} maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} placeholder={`${draft.category} 경험`}/><span className={styles.hint}>비워두면 ‘{draft.category} 경험’으로 저장돼요. 나중에 바꿀 수 있어요.</span></label><div className={styles.chips} aria-label="경험 유형">{categories.map(category=><button disabled={busy} type="button" aria-pressed={draft.category===category} key={category} onClick={()=>setDraft({...draft,category})}>{category}</button>)}</div>{step===0&&<ExperienceTextClassifier onApply={fields=>setDraft({...draft,...fields,confirmed:false})}/>}</details>
   <div className={styles.editorFooter}><p role="status" className={styles.hint}>{draftStatus}</p>{draftStatus.includes('실패')&&<button type="button" className="text-link" onClick={()=>void inspectDraftVersions(draftSnapshot.current,true)}>서버 초안 확인·비교</button>}<div><button className={styles.backLink} disabled={busy} onClick={()=>void keepDraftAndExit()}>초안 보관하고 목록으로</button><button className="text-link" disabled={busy} onClick={()=>void save(false)}>초안 저장 후 나가기</button></div></div>
  </fieldset></section>:card?<>
   <button className={styles.backLink} onClick={()=>selectCard('')}><ArrowLeft size={16}/>내 경험 목록</button>
   <section className={styles.detail} aria-labelledby="experience-title">
    <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>{card.data.category} · {card.data.confirmed?'내 경험 확인 완료':'작성 중'}</span><h2 id="experience-title">{card.data.title}</h2></div><button className="button ghost" disabled={busy} aria-pressed={card.data.pinned} onClick={pin}><Bookmark size={16} fill={card.data.pinned?'currentColor':'none'}/>{card.data.pinned?'고정 해제':'면접용 고정'}</button></div>
    <div className={styles.detailLayout}>
     <div className={styles.detailMain}>
      <div className={styles.tabs} aria-label="경험 보기">{[['experience','내 이야기'],['questions','면접에 활용'],['history','연습 기록']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}{id==='history'&&history.length>0&&<span>{history.length}</span>}</button>)}</div>
      {tab==='experience'?<div className={styles.tabContent}>
       {experienceSteps.map(item=><div key={item.key} className={styles.fact}><h3>{item.label}</h3><p>{card.data[item.key]||'아직 확인하지 않았어요.'}</p></div>)}
       {card.data.originalText&&<details className={styles.pasteTool}><summary>붙여넣은 원문 보기</summary><p>{card.data.originalText}</p></details>}
       <p className={styles.hint}>{card.data.sourceNote}</p>
       <div className={styles.actions}><button className="button ghost" onClick={edit}>이야기 보완하기</button>{card.data.confirmed&&<button className="button primary" onClick={()=>setTab('questions')}>면접 질문에 연결하기<ArrowRight size={16}/></button>}</div>
      </div>:tab==='history'?<div className={styles.tabContent}>
       {history.length?history.map(session=><article className={styles.historyItem} key={session.id}><div className={styles.row}><Link className="text-link" href={`/interview/${session.id}?kind=${session.kind}`}>{session.kind==='video'?'말로 한 면접':'글로 한 면접'} · {new Date(session.created_at).toLocaleDateString('ko-KR')}<ArrowRight size={15}/></Link><small>{session.state==='active'?'이어서 연습':'연습 보기'}</small></div><small>시작 당시 경험 v{session.card.revision}</small>{session.answers.map((answer:Item,index:number)=><div className={styles.historyAnswer} key={index}><h3>{answer.question}</h3><p>{answer.answer}</p>{answer.feedback?.content&&<p className={styles.hint}>{answer.feedback.content}</p>}</div>)}</article>):<div className={styles.empty}><h3>아직 이 경험으로 연습하지 않았어요</h3><p>질문을 골라 답하면 이곳에서 답변과 피드백을 다시 볼 수 있어요.</p><button className="button primary" onClick={()=>setTab('questions')}>연습할 질문 고르기<ArrowRight size={16}/></button></div>}
      </div>:<div className={styles.tabContent}>
       <h3>이 경험을 어떤 질문에 써볼까요?</h3><p className={styles.hint}>{questionSource==='personal'?'내 자료에 발행된 질문으로 경험을 말하는 일반 연습이에요. 선택한 전형의 실제 면접을 재현하지 않아요.':'공통 면접 질문 중 내 경험과 연결되는 질문을 골라주세요.'}</p>
       {questionError&&<Alert>{questionError}</Alert>}
       {questionLoading?<p role="status">연습할 질문을 불러오고 있어요.</p>:questionError?<button className="button ghost" onClick={()=>setQuestionRetry(n=>n+1)}>질문 다시 불러오기</button>:!questions.length?<p role="status">이 지원처에 연결된 질문이 아직 없어요. 상단에서 지원처를 확인해 주세요.</p>:<><p className={styles.hint}>{showAllQuestions?'현재 지원처에서 연습할 수 있는 질문이에요.':'경험 유형·단어가 연결되는 질문을 최대 3개 골랐어요. AI의 적합성 평가가 아니에요.'}</p>{!showAllQuestions&&!questionSuggestions.length&&<p role="status">뚜렷하게 연결되는 질문을 찾지 못했어요. 아래에서 다른 질문을 직접 골라도 괜찮아요.</p>}<fieldset className={styles.questionList}><legend className="sr-only">연습할 질문 선택</legend>{(showAllQuestions?questions.map(question=>({question,reason:''})):questionSuggestions).map(({question,reason})=><label key={question.id} className={questionId===question.id?styles.chosenQuestion:undefined}><input type="radio" name="armory-question" value={question.id} checked={questionId===question.id} onChange={()=>setQuestionId(question.id)}/><span>{question.prompt}{reason&&<small className={styles.matchReason}>{reason}</small>}</span></label>)}</fieldset><button className="text-link" onClick={()=>{setQuestionId('');setShowAllQuestions(!showAllQuestions);}}>{showAllQuestions?'연결되는 질문 3개로 돌아가기':'해당 없음 · 다른 질문 고르기'}</button></>}
       {pickedQuestion&&<div className={styles.outline}><span className={styles.eyebrow}>답변 준비</span><h3>{pickedQuestion.prompt}</h3><p><strong>말할 순서</strong><br/>{experienceOutline(card.data.category,pickedQuestion.prompt)}</p><p><strong>내가 한 행동</strong><br/>{card.data.action}</p><small>질문에 맞지 않는 부분은 빼고, 실제로 한 일만 말해보세요.</small></div>}
       {!card.data.confirmed?<div className={styles.confirmPrompt}><p>상황과 내 행동을 확인하면 면접 연습을 시작할 수 있어요.</p><button className="button primary" onClick={edit}>내 경험 확인하기</button></div>:pickedQuestion?<div className={styles.practiceActions}><div className={styles.actions}><Link className="button primary" href={href('chat')}><MessagesSquare size={17}/>글로 면접 연습</Link><Link className="button ghost" href={href('video')}><Camera size={17}/>말로 면접 연습</Link></div><p className={styles.hint}>현재 저장된 경험과 선택한 질문을 함께 가져가요.</p></div>:<p className={styles.selectionHint}>질문을 선택하면 글이나 말로 연습할 수 있어요.</p>}
      </div>}
     </div>
     <aside className={styles.detailAside} aria-label="경험 준비 도구">
      <h3>내 이야기의 핵심</h3><p className={styles.experienceSummary}>{card.data.action||'내가 직접 한 행동을 적어보세요.'}</p><button className="text-link" onClick={edit}>{card.data.confirmed?'경험 보완하기':'이어서 정리하기'}<ArrowRight size={15}/></button>
      <details className={styles.assistDisclosure}><summary>AI로 내 글에서 상황·행동 나누기<ChevronDown size={16}/></summary><ArmoryAssist key={card.id+':'+card.revision+':'+targetId} card={card} targetId={targetId} onApply={fields=>{edit();setDraft({...card.data,...fields,confirmed:false});setStep(3);}}/></details>
      <p className={styles.hint}>AI 제안은 직접 확인한 뒤 저장해요. 실제로 하지 않은 일은 넣지 않아요.</p>
     </aside>
    </div>
   </section>
  </>:<>
   <ol className={styles.journey} aria-label="무기고 이용 순서"><li><span>1</span><div><strong>경험 찾기</strong><small>내가 직접 한 일을 떠올려요</small></div></li><li><span>2</span><div><strong>내 이야기로 정리</strong><small>상황 · 행동 · 배운 점을 적어요</small></div></li><li><span>3</span><div><strong>면접에 활용</strong><small>질문에 연결해 답해봐요</small></div></li></ol>
   {localDrafts.length>0&&<section className={styles.draftList} aria-label="작성 중인 경험 초안"><h2>작성 중인 경험 <span className={styles.count}>{localDrafts.length}</span></h2><p className={styles.hint}>새 경험을 만들어도 이전 초안은 그대로 보관해요. 저장한 카드는 확인·저장할 때까지 바뀌지 않아요.</p><div className={styles.draftCards}>{localDrafts.map(item=><button key={item.id} className={styles.card} onClick={()=>recover(item)}><span className={styles.cardContent}><strong className={styles.cardTitle}>{item.draft.title||`${item.draft.category} 경험 초안`}</strong><span className={styles.cardExcerpt}>{item.draft.action||item.draft.situation||'빈 초안 · 작은 기억부터 이어서 적어보세요.'}</span><small>{item.serverRevision?'서버 저장 이력 있음':'이 기기에 보관 중'} · {new Date(item.updatedAt).toLocaleDateString('ko-KR')}</small></span><span className={styles.cardAction}>초안 이어쓰기<ArrowRight size={16}/></span></button>)}</div></section>}
   {backups.length>0&&<details className={styles.draftList}><summary>비교한 버전 보관함 · {backups.length}</summary><p className={styles.hint}>버전을 선택하기 전의 원문이에요. 열면 별도의 새 경험 초안으로 이어 쓸 수 있어요.</p>{backups.map(item=><button key={item.id} className={styles.card} onClick={()=>recoverBackup(item)}><span className={styles.cardContent}><strong className={styles.cardTitle}>{item.record.draft.title||`${item.record.draft.category} 경험 초안`}</strong><span className={styles.cardExcerpt}>{item.record.draft.action||item.record.draft.situation||'빈 초안'}</span><small>{item.label}</small></span><span className={styles.cardAction}>새 초안으로 열기<ArrowRight size={16}/></span></button>)}</details>}
   {activeSession&&<div className={styles.notice}><span>진행 중인 면접이 있어요.</span><Link className="text-link" href={`/interview/${activeSession.id}?kind=${activeSession.kind}`}>이어서 연습하기<ArrowRight size={15}/></Link></div>}
   <div className={styles.workspace}>
    <section className={styles.starter} aria-labelledby="find-experience-title">
     <div className={styles.sectionHeading}><h2 id="find-experience-title">새 경험 찾기</h2><Plus size={18} aria-hidden="true"/></div><p className={styles.hint}>상황과 내가 한 일, 두 문장이면 시작할 수 있어요.<br/>큰 성과가 없어도 괜찮아요.</p>
     <div className={styles.categoryList}>{categories.map(category=><button key={category} onClick={()=>begin(category)}><span><strong>{category}</strong><small>{categoryHints[category]}</small></span><ArrowRight size={16}/></button>)}</div>
     <button className={styles.blankStart} onClick={()=>begin()}><Plus size={16}/>주제 없이 직접 적기</button>
     {(data.learning?.activities||[]).length>0&&<details className={styles.sourceDisclosure} open={cards.length===0}><summary>내 학습 자료에서 찾기<ChevronDown size={16}/></summary><p className={styles.hint}>발행된 활동은 기억을 떠올리는 단서예요. 실제 내 역할은 직접 확인해 주세요.</p>{(data.learning?.activities||[]).slice(0,3).map((activity:Item)=><button className={styles.sourceItem} key={activity.id} onClick={()=>begin('탐구',activity)}><span>{activity.title}</span><ArrowRight size={15}/></button>)}</details>}
    </section>
    <section className={styles.library} aria-labelledby="my-experiences-title">
     <div className={styles.sectionHeading}><div><h2 id="my-experiences-title">저장한 경험 <span className={styles.count}>{cards.length}</span></h2><p className={styles.hint}>{cards.length?`내 경험 확인 ${cards.filter(item=>item.data.confirmed).length}개 · 면접용 고정 ${cards.filter(item=>item.data.pinned).length}개`:'정리한 경험을 모아두고, 질문에 맞게 꺼내 써요.'}</p></div><label className={styles.search}><Search size={16} aria-hidden="true"/><span className="sr-only">경험 검색</span><input type="search" placeholder="경험·키워드 검색" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
     {loading?<p role="status">경험을 불러오고 있어요.</p>:filteredCards.length?<div className={styles.experienceList}>{filteredCards.map(item=>{const practiced=sessions.some(session=>session.card?.id===item.id&&session.answers.length);return <button key={item.id} className={styles.card} onClick={()=>selectCard(item.id)}><span className={styles.cardContent}><span className={styles.cardMeta}><span>{item.data.category}</span>{item.data.pinned&&<span className={styles.pinned}><Bookmark size={12} fill="currentColor"/>면접용 고정</span>}<span>{!item.data.confirmed?'작성 중':practiced?'연습 기록 있음':'확인 완료'}</span></span><strong className={styles.cardTitle}>{item.data.title}</strong><span className={styles.cardExcerpt}>{item.data.action||'어떤 행동을 했는지 이어서 적어보세요.'}</span></span><span className={styles.cardAction}>{item.data.confirmed?'질문에 연결':'이어서 정리'}<ArrowRight size={16}/></span></button>;})}</div>:<div className={styles.empty} role="status"><h3>{cards.length?'검색 결과가 없어요':'첫 경험을 정리해 보세요'}</h3><p>{cards.length?'경험 이름이나 행동에 들어간 다른 단어로 찾아보세요.':'조별 과제에서 맡은 역할, 궁금해서 찾아본 일처럼 작은 기억이면 충분해요.'}</p>{cards.length?<button className="button ghost" onClick={()=>setSearch('')}>검색 초기화</button>:<button className="button primary" onClick={()=>begin()}><Plus size={16}/>첫 경험 적기</button>}</div>}
    </section>
   </div>
  </>}
 </div>;
}
