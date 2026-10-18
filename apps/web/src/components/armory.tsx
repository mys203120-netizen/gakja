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
const empty=():Experience=>({title:'',category:'협업',situation:'',action:'',result:'',confirmed:false,pinned:false,sourceNote:'학생이 직접 작성한 경험'});
const categories=['협업','실패','강점','탐구'] as const;
const categoryHints:Record<Experience['category'],string>={협업:'함께 문제를 풀었던 일',실패:'뜻대로 되지 않아 바꿔본 일',강점:'내 역할이 도움이 되었던 일',탐구:'궁금한 것을 직접 확인한 일'};
export function Armory(){
 const {data,targetId}=useApp();const params=useSearchParams();const router=useRouter();const editorHeading=useRef<HTMLHeadingElement>(null);const openedCard=useRef('');
 const target=data.targets.find(item=>item.id===targetId);
 const questionSource=target&&interviewSupportForTarget(target).supported===false?'personal':'common';
 const [cards,setCards]=useState<ExperienceCard[]>([]),[sessions,setSessions]=useState<Item[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState(params.get('card')||''),[editing,setEditing]=useState(false),[draft,setDraft]=useState<Experience>(empty),[draftId,setDraftId]=useState(''),[revision,setRevision]=useState(0),[step,setStep]=useState(0),[tab,setTab]=useState('questions'),[search,setSearch]=useState(''),[questions,setQuestions]=useState<Item[]>([]),[questionId,setQuestionId]=useState(''),[questionError,setQuestionError]=useState('');
 const [saved,setSaved]=useState('');
 const [validation,setValidation]=useState(''),[questionLoading,setQuestionLoading]=useState(true),[questionRetry,setQuestionRetry]=useState(0);
 useEffect(()=>{if(editing)editorHeading.current?.focus();},[editing,step]);
 function nextStep(){if(step<2&&!draft[experienceSteps[step].key].trim()){setValidation(step===0?'어떤 상황이었는지 한 문장만 적어주세요.':'내가 직접 한 행동을 한 문장만 적어주세요.');return;}setValidation('');setStep(step+1);}
 function selectCard(id:string){setSelected(id);setQuestionId('');setTab(cards.find(c=>c.id===id)?.data.confirmed?'questions':'experience');setSaved('');router.replace(id?'/armory?card='+encodeURIComponent(id):'/armory',{scroll:false});}
 const [recoverable,setRecoverable]=useState(false);const draftKey='armory-draft:'+data.user.id;
 useEffect(()=>{try{setRecoverable(Boolean(sessionStorage.getItem(draftKey)));}catch{}},[draftKey]);
 useEffect(()=>{if(editing){try{sessionStorage.setItem(draftKey,JSON.stringify({draft,draftId,revision,step}));}catch{}}},[editing,draft,draftId,revision,step,draftKey]);
 function recover(){try{const stored=JSON.parse(sessionStorage.getItem(draftKey)||'null');if(stored){setDraft(stored.draft);setDraftId(stored.draftId);setRevision(stored.revision);setStep(stored.step);setEditing(true);setRecoverable(false);}}catch{setError('임시 초안을 불러오지 못했어요.');}}
 async function load(){setLoading(true);setError('');try{const r=await api('/api/armory');setCards(r.cards);setSessions(r.sessions);}catch(e){setError((e as Error).message);}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 useEffect(()=>{setSelected(params.get('card')||'');},[params]);
 useEffect(()=>{let active=true;setQuestions([]);setQuestionId('');setQuestionError('');setQuestionLoading(true);api('/api/interviews?preview=1&sourceType='+questionSource+(targetId?'&targetId='+encodeURIComponent(targetId):'')).then(r=>{if(active){const sourceType=r.sourceKind==='common'?'common':'personal';setQuestions((r.questions||[]).filter((question:Item)=>sourceType==='common'?Boolean(question.common_revision):!question.common_revision&&Number(r.contentVersion)>0).map((question:Item)=>({...question,armorySourceType:sourceType,armorySourceVersion:sourceType==='common'?question.common_revision:r.contentVersion,armoryPracticeNotice:r.practiceNotice||null})));}}).catch(e=>{if(active)setQuestionError(e.message);}).finally(()=>{if(active)setQuestionLoading(false);});return()=>{active=false;};},[targetId,questionSource,questionRetry,data.package?.active_version]);
 useEffect(()=>{if(!editing)return;const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[editing]);
 const card=cards.find(c=>c.id===selected);const history=sessions.filter(s=>s.card?.id===selected);
 useEffect(()=>{if(!card){openedCard.current='';return;}if(openedCard.current!==card.id){openedCard.current=card.id;setTab(card.data.confirmed?'questions':'experience');}},[card?.id,card?.data.confirmed]);
 function begin(category:Experience['category']='협업',activity?:Item){setDraft({...empty(),category,title:activity?.title||'',sourceNote:activity?`참고한 발행 활동: ${activity.title} · 내용은 학생이 직접 확인`:'학생이 직접 작성한 경험'});setDraftId(crypto.randomUUID());setRevision(0);setStep(0);setValidation('');setEditing(true);setError('');setSaved('');}
 function edit(){if(!card)return;setDraft({...card.data,confirmed:false});setDraftId(card.id);setRevision(card.revision);setStep(0);setValidation('');setEditing(true);setSaved('');}
 async function save(confirmed:boolean){setBusy(true);setError('');try{const r=await api('/api/armory',{method:'POST',body:JSON.stringify({id:draftId,revision,data:{...draft,title:draft.title.trim()||`${draft.category} 경험`,confirmed}})});setCards(prev=>[r.card,...prev.filter(c=>c.id!==r.card.id)]);try{sessionStorage.removeItem(draftKey);}catch{}setRecoverable(false);setRevision(r.card.revision);selectCard(r.card.id);setEditing(false);setTab(confirmed?'questions':'experience');setSaved(confirmed?'내 경험 카드가 준비됐어요. 질문을 골라 연습해 보세요.':'초안을 저장했어요. 나중에 이어서 작성할 수 있어요.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function pin(){if(!card)return;setBusy(true);try{const r=await api('/api/armory',{method:'POST',body:JSON.stringify({id:card.id,revision:card.revision,data:{...card.data,pinned:!card.data.pinned}})});setCards(prev=>prev.map(c=>c.id===card.id?r.card:c));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 function href(kind:'chat'|'video'){const question=questions.find(item=>item.id===questionId)!;return interviewSetupHref(kind,new URLSearchParams({questionId,sourceType:question.armorySourceType,sourceVersion:String(question.armorySourceVersion),experienceCardId:card!.id,experienceRevision:String(card!.revision)}),{targetId,count:1});}
 const filteredCards=[...cards].sort((a,b)=>Number(b.data.pinned)-Number(a.data.pinned)).filter(c=>[c.data.title,c.data.category,c.data.situation,c.data.action,c.data.result].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
 const currentStep=experienceSteps[step];const pickedQuestion=questions.find(q=>q.id===questionId);
 const activeSession=sessions.find(s=>s.state==='active')||data.interviews?.find(s=>s.state==='active');
 if(loading&&selected)return <div className={styles.page}><PageTitle title="나의 무기고"/><p role="status">경험을 불러오고 있어요.</p></div>;
 return <div className={styles.page}>
  <PageTitle title="나의 무기고">내가 직접 한 일을 정리하고, 면접에서 꺼내 쓸 이야기로 준비해요.</PageTitle>
  {error&&<Alert>{error}<button className="text-link" onClick={load}>목록 다시 불러오기</button></Alert>}
  {saved&&<p role="status" className={styles.notice}>{saved}</p>}
  {editing?<section className={styles.editor} aria-label="경험 카드 만들기">
   <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>내 이야기 정리</span><h2 ref={editorHeading} tabIndex={-1}>{revision?'경험 보완하기':'작은 경험부터 적어보세요'}</h2></div><span className={styles.stepCount}>{step+1} / 4</span></div>
   <ol className={styles.steps}>{['상황','내 행동','결과·배운 점','확인'].map((label,index)=><li key={label} aria-current={index===step?'step':undefined}><span>{index+1}</span>{label}</li>)}</ol>
   {step===0&&<><label>경험 이름<input maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} placeholder="예: 조별 과제 자료를 정리한 경험"/></label><div className={styles.chips} aria-label="경험 유형">{categories.map(category=><button type="button" aria-pressed={draft.category===category} key={category} onClick={()=>setDraft({...draft,category})}>{category}</button>)}</div></>}
   {currentStep?<div className={styles.writingStep}>
    <h3>{currentStep.question}</h3><p id="experience-hint" className={styles.hint}>{currentStep.hint}</p>
    <label><span className="sr-only">{currentStep.label}</span><textarea aria-invalid={Boolean(validation)} aria-describedby="experience-hint experience-validation" key={currentStep.key} rows={6} maxLength={2000} value={draft[currentStep.key]} onChange={e=>{setDraft({...draft,[currentStep.key]:e.target.value});if(validation)setValidation('');}}/></label>
    {step===0&&<p className={styles.hint}>조별 과제, 동아리, 학교 행사에서 맡았던 작은 역할도 좋아요.</p>}
   </div>:<><h3>실제로 내가 한 일인지 확인해 주세요</h3>{experienceSteps.map(item=><label key={item.key}>{item.label}<textarea rows={3} maxLength={2000} value={draft[item.key]} onChange={e=>setDraft({...draft,[item.key]:e.target.value})}/></label>)}<p className={styles.hint}>상황과 내 행동은 필수예요. 결과·배운 점은 나중에 보완해도 괜찮아요.<br/>{draft.sourceNote}<br/>빈 항목은 미확인으로 남아요. 학생 확인은 공식 자료 검수를 뜻하지 않아요.</p></>}
   <p id="experience-validation" role="status" className={styles.validation}>{validation}</p>
   <div className={styles.editorActions}><button className="button ghost" disabled={busy} onClick={()=>void save(false)}>초안 저장 후 나가기</button><div>{step>0&&<button className="button ghost" disabled={busy} onClick={()=>{setValidation('');setStep(step-1);}}>이전</button>}{step<3?<button className="button primary" disabled={busy} onClick={nextStep}>{step===2?'확인하기':'다음'}<ArrowRight size={16}/></button>:<button className="button primary" disabled={busy||!draft.situation.trim()||!draft.action.trim()} onClick={()=>void save(true)}>{busy?'저장 중…':'내 경험 확인하고 저장'}</button>}</div></div>
  </section>:card?<>
   <button className={styles.backLink} onClick={()=>selectCard('')}><ArrowLeft size={16}/>내 경험 목록</button>
   <section className={styles.detail} aria-labelledby="experience-title">
    <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>{card.data.category} · {card.data.confirmed?'내 경험 확인 완료':'작성 중'}</span><h2 id="experience-title">{card.data.title}</h2></div><button className="button ghost" disabled={busy} aria-pressed={card.data.pinned} onClick={pin}><Bookmark size={16} fill={card.data.pinned?'currentColor':'none'}/>{card.data.pinned?'고정 해제':'면접용 고정'}</button></div>
    <div className={styles.detailLayout}>
     <div className={styles.detailMain}>
      <div className={styles.tabs} aria-label="경험 보기">{[['experience','내 이야기'],['questions','면접에 활용'],['history','연습 기록']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}{id==='history'&&history.length>0&&<span>{history.length}</span>}</button>)}</div>
      {tab==='experience'?<div className={styles.tabContent}>
       {experienceSteps.map(item=><div key={item.key} className={styles.fact}><h3>{item.label}</h3><p>{card.data[item.key]||'아직 확인하지 않았어요.'}</p></div>)}
       <p className={styles.hint}>{card.data.sourceNote}</p>
       <div className={styles.actions}><button className="button ghost" onClick={edit}>이야기 보완하기</button>{card.data.confirmed&&<button className="button primary" onClick={()=>setTab('questions')}>면접 질문에 연결하기<ArrowRight size={16}/></button>}</div>
      </div>:tab==='history'?<div className={styles.tabContent}>
       {history.length?history.map(session=><article className={styles.historyItem} key={session.id}><div className={styles.row}><Link className="text-link" href={`/interview/${session.id}?kind=${session.kind}`}>{session.kind==='video'?'말로 한 면접':'글로 한 면접'} · {new Date(session.created_at).toLocaleDateString('ko-KR')}<ArrowRight size={15}/></Link><small>{session.state==='active'?'이어서 연습':'연습 보기'}</small></div><small>시작 당시 경험 v{session.card.revision}</small>{session.answers.map((answer:Item,index:number)=><div className={styles.historyAnswer} key={index}><h3>{answer.question}</h3><p>{answer.answer}</p>{answer.feedback?.content&&<p className={styles.hint}>{answer.feedback.content}</p>}</div>)}</article>):<div className={styles.empty}><h3>아직 이 경험으로 연습하지 않았어요</h3><p>질문을 골라 답하면 이곳에서 답변과 피드백을 다시 볼 수 있어요.</p><button className="button primary" onClick={()=>setTab('questions')}>연습할 질문 고르기<ArrowRight size={16}/></button></div>}
      </div>:<div className={styles.tabContent}>
       <h3>이 경험을 어떤 질문에 써볼까요?</h3><p className={styles.hint}>{questionSource==='personal'?'내 자료에 발행된 질문으로 경험을 말하는 일반 연습이에요. 선택한 전형의 실제 면접을 재현하지 않아요.':'공통 면접 질문 중 내 경험과 연결되는 질문을 골라주세요.'}</p>
       {questionError&&<Alert>{questionError}</Alert>}
       {questionLoading?<p role="status">연습할 질문을 불러오고 있어요.</p>:questionError?<button className="button ghost" onClick={()=>setQuestionRetry(n=>n+1)}>질문 다시 불러오기</button>:!questions.length?<p role="status">이 지원처에 연결된 질문이 아직 없어요. 상단에서 지원처를 확인해 주세요.</p>:<fieldset className={styles.questionList}><legend className="sr-only">연습할 질문 선택</legend>{questions.map(question=><label key={question.id} className={questionId===question.id?styles.chosenQuestion:undefined}><input type="radio" name="armory-question" value={question.id} checked={questionId===question.id} onChange={()=>setQuestionId(question.id)}/><span>{question.prompt}</span></label>)}</fieldset>}
       {pickedQuestion&&<div className={styles.outline}><span className={styles.eyebrow}>답변 준비</span><h3>{pickedQuestion.prompt}</h3><p><strong>말할 순서</strong><br/>{experienceOutline(card.data.category,pickedQuestion.prompt)}</p><p><strong>내가 한 행동</strong><br/>{card.data.action}</p><small>질문에 맞지 않는 부분은 빼고, 실제로 한 일만 말해보세요.</small></div>}
       {!card.data.confirmed?<div className={styles.confirmPrompt}><p>상황과 내 행동을 확인하면 면접 연습을 시작할 수 있어요.</p><button className="button primary" onClick={edit}>내 경험 확인하기</button></div>:pickedQuestion?<div className={styles.practiceActions}><div className={styles.actions}><Link className="button primary" href={href('chat')}><MessagesSquare size={17}/>글로 면접 연습</Link><Link className="button ghost" href={href('video')}><Camera size={17}/>말로 면접 연습</Link></div><p className={styles.hint}>현재 저장된 경험과 선택한 질문을 함께 가져가요.</p></div>:<p className={styles.selectionHint}>질문을 선택하면 글이나 말로 연습할 수 있어요.</p>}
      </div>}
     </div>
     <aside className={styles.detailAside} aria-label="경험 준비 도구">
      <h3>내 이야기의 핵심</h3><p className={styles.experienceSummary}>{card.data.action||'내가 직접 한 행동을 적어보세요.'}</p><button className="text-link" onClick={edit}>{card.data.confirmed?'경험 보완하기':'이어서 정리하기'}<ArrowRight size={15}/></button>
      <details className={styles.assistDisclosure}><summary>AI로 문장 정리하기<ChevronDown size={16}/></summary><ArmoryAssist key={card.id+':'+card.revision+':'+targetId} card={card} targetId={targetId} onApply={fields=>{edit();setDraft({...card.data,...fields,confirmed:false});setStep(3);}}/></details>
      <p className={styles.hint}>AI 제안은 직접 확인한 뒤 저장해요. 실제로 하지 않은 일은 넣지 않아요.</p>
     </aside>
    </div>
   </section>
  </>:<>
   <ol className={styles.journey} aria-label="무기고 이용 순서"><li><span>1</span><div><strong>경험 찾기</strong><small>내가 직접 한 일을 떠올려요</small></div></li><li><span>2</span><div><strong>내 이야기로 정리</strong><small>상황 · 행동 · 배운 점을 적어요</small></div></li><li><span>3</span><div><strong>면접에 활용</strong><small>질문에 연결해 답해봐요</small></div></li></ol>
   {recoverable&&<div className={styles.notice}><span>작성 중이던 경험이 있어요.</span><button className="text-link" onClick={recover}>임시 초안 이어쓰기<ArrowRight size={15}/></button></div>}
   {activeSession&&<div className={styles.notice}><span>진행 중인 면접이 있어요.</span><Link className="text-link" href={`/interview/${activeSession.id}?kind=${activeSession.kind}`}>이어서 연습하기<ArrowRight size={15}/></Link></div>}
   <div className={styles.workspace}>
    <section className={styles.starter} aria-labelledby="find-experience-title">
     <div className={styles.sectionHeading}><h2 id="find-experience-title">새 경험 찾기</h2><Plus size={18} aria-hidden="true"/></div><p className={styles.hint}>큰 성과가 없어도 괜찮아요.<br/>가까운 주제 하나부터 골라보세요.</p>
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
