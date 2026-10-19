'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {ArrowRight,Check,Clock3} from 'lucide-react';
import {useApp} from './app-shell';
import {api,post,ActionButton,Alert,type Item} from './shared';
import {learningScopeIdentity} from '@/lib/learning-target-scope';
import {learningTargetIdentityMatches} from '@gakja/content-contracts/workflows';
import styles from './quick-start.module.css';

const keywords=['협업','문제 해결','탐구','실패와 배움','관심 전공','나의 강점'];
/** A short common-question session uses the same owned quiz answer receipts as normal practice. */
export function QuickStart(){
  const {data,refresh,target:currentTarget}=useApp(),params=useSearchParams(),requested=params.get('targetId');
  const general=params.get('general')==='1'||data.targets.length===0;
  const target=general?undefined:requested?data.targets.find(item=>item.id===requested):currentTarget;
  const scope=JSON.stringify([data.user.id,target?.id||null,target?learningScopeIdentity(target):null]);
  const key=`gakja-first-question:${data.user.id}:${target?.id||'common'}`;
  const [loaded,setLoaded]=useState(''),[question,setQuestion]=useState<Item|null>(null),[session,setSession]=useState<Item|null>(null),[selected,setSelected]=useState<string[]>([]),[answer,setAnswer]=useState(''),[started,setStarted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[draftState,setDraftState]=useState(''),[done,setDone]=useState(false);
  const heading=useRef<HTMLHeadingElement>(null),draftQueue=useRef<Promise<unknown>>(Promise.resolve()),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),pendingAnswer=useRef<{sessionId:string;response:string;requestId:string}|null>(null),latestAnswer=useRef(answer),scopeRef=useRef(scope);
  latestAnswer.current=answer;scopeRef.current=scope;
  useEffect(()=>{
    let alive=true;const controller=new AbortController();setLoaded('');setError('');setStarted(false);setDone(false);setAnswer('');setSession(null);setSelected([]);setBusy(false);setDraftState('');
    if(requested&&!target&&!general){setError('등록된 지원 학교를 선택해 주세요.');setLoaded(scope);return()=>controller.abort();}
    void(async()=>{
      try{
        // No target is sent before registration: this remains a common source, never a personal record.
        const result=await api('/api/quiz?sourceType=common'+(target?'&targetId='+encodeURIComponent(target.id):'&general=1'),{signal:controller.signal});
        const candidates=(result.library?.answer||[]).filter((item:Item)=>item.source_kind==='common');
        const first=candidates.find((item:Item)=>item.question_id==='common_motivation')||candidates[0];
        if(!first)throw new Error('공통 질문을 아직 준비하지 못했어요. 잠시 후 다시 열어 주세요.');
        if(!alive)return;setQuestion(first);
        let saved:Item|null=null;try{saved=JSON.parse(localStorage.getItem(key)||'null');}catch{}
        if(saved?.scope===scope&&saved.sessionId){
          try{
            const previous=await api('/api/quiz?sessionId='+encodeURIComponent(saved.sessionId),{signal:controller.signal});
            const value=previous.session,item=value?.items?.[0],snapshot=value?.metadata?.targetSnapshot;
            const sameTarget=target?value?.metadata?.targetId===target.id&&snapshot&&learningTargetIdentityMatches(learningScopeIdentity(snapshot),learningScopeIdentity(target)):!value?.metadata?.targetId&&!snapshot;
            if(alive&&value?.student_id===data.user.id&&value.items?.length===1&&item?.source_kind==='common'&&sameTarget){
              if(value.state==='ended')return;
              const receipt=previous.responses?.find((response:Item)=>response.item_index===0&&typeof response.response==='string');
              if(value.state==='completed'&&!receipt)return;
              setSession(value);setQuestion(item);setStarted(true);setDone(value.state==='completed');
              const draft=value.metadata?.drafts?.['0'],remote=typeof draft==='string'?draft:draft?.response||'';
              const localText=typeof saved.answer==='string'?saved.answer.slice(0,10000):undefined;
              const text=value.state==='completed'?receipt.response:remote&&Date.parse(String(draft?.updatedAt||''))>Date.parse(String(saved.updatedAt||''))?remote:localText??remote;
              setAnswer(text);setDraftState(remote?'초안 저장됨':'');
            }
          }catch{/* A stale local pointer may not block a fresh owned practice. */}
        }
      }catch(err){if(alive&&!controller.signal.aborted)setError((err as Error).message);}
      finally{if(alive)setLoaded(scope);}
    })();return()=>{alive=false;controller.abort();};
  },[scope,key,requested,general]);
  useEffect(()=>{if(started||done)heading.current?.focus();},[started,done]);
  useEffect(()=>{
    if(!session||done||loaded!==scope)return;
    try{
      const updatedAt=new Date().toISOString();localStorage.setItem(key,JSON.stringify({scope,sessionId:session.id,answer,updatedAt}));
      localStorage.setItem(`gakja-quiz:${data.user.id}:${session.id}:0`,answer);
      localStorage.setItem(`gakja-quiz-activity:${data.user.id}:${session.id}`,JSON.stringify({itemIndex:0,updatedAt,hasDraft:Boolean(answer.trim())}));
    }catch{}
    const remote=session.metadata?.drafts?.['0'],remoteText=typeof remote==='string'?remote:remote?.response||'';
    if(answer===remoteText)return;
    setDraftState('초안 저장 중');const capture=scope;
    const timer=setTimeout(()=>{
      draftQueue.current=draftQueue.current.catch(()=>{}).then(()=>post('/api/quiz',{action:'draft',sessionId:session.id,itemIndex:0,response:answer,requestId:crypto.randomUUID()}));
      void draftQueue.current.then(()=>{if(scopeRef.current===capture&&latestAnswer.current===answer)setDraftState('초안 저장됨');}).catch(()=>{if(scopeRef.current===capture)setDraftState('서버 저장 미확인 · 이 브라우저에 초안 보관 중');});
    },450);draftTimer.current=timer;return()=>clearTimeout(timer);
  },[answer,session,done,loaded,scope,key]);
  async function start(){
    if(!question||busy)return;const capture=scope;setBusy(true);setError('');
    try{
      const result=await post('/api/quiz',{action:'create',mode:'answer',focus:'free',sourceType:'common',targetId:target?.id||null,itemIds:[question.id]});
      if(scopeRef.current!==capture)return;
      const current=result.session.state==='active'?result.session:(await post('/api/quiz',{action:'start',sessionId:result.session.id,itemIndex:0})).session;
      if(scopeRef.current!==capture)return;
      const draft=current.metadata?.drafts?.['0'],text=typeof draft==='string'?draft:draft?.response||'';
      setSession(current);setQuestion(current.items[0]);setAnswer(text);setStarted(true);
      try{localStorage.setItem(key,JSON.stringify({scope,sessionId:current.id,answer:text,updatedAt:new Date().toISOString()}));}catch{}
    }catch(err){if(scopeRef.current===capture)setError((err as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}
  }
  async function submit(){
    if(!session||!answer.trim()||busy)return;const capture=scope;setBusy(true);setError('');if(draftTimer.current)clearTimeout(draftTimer.current);
    try{
      await draftQueue.current.catch(()=>{});
      if(session.state!=='active')await post('/api/quiz',{action:'start',sessionId:session.id,itemIndex:0});
      const response=answer.trim();
      if(!pendingAnswer.current||pendingAnswer.current.sessionId!==session.id||pendingAnswer.current.response!==response)pendingAnswer.current={sessionId:session.id,response,requestId:crypto.randomUUID()};
      let result:Item;
      try{result=await post('/api/quiz',{action:'answer',sessionId:session.id,itemIndex:0,response,recallStatus:'unchecked',requestId:pendingAnswer.current!.requestId});}
      catch(cause){
        // A lost HTTP response may follow a committed answer. An owned exact-item receipt is sufficient.
        const saved=await api('/api/quiz?sessionId='+encodeURIComponent(session.id));
        const receipt=saved.responses?.find((item:Item)=>item.item_index===0&&item.response===response);
        if(saved.session?.id!==session.id||saved.session.student_id!==data.user.id||saved.session.items?.[0]?.id!==session.items?.[0]?.id||!receipt)throw cause;
        result={...saved,response:receipt};
      }
      if(result.session?.state!=='completed'||result.response?.response!==response)throw new Error('답변 저장 상태를 확인하지 못했어요. 다시 확인해 주세요.');
      try{localStorage.removeItem(`gakja-quiz:${data.user.id}:${session.id}:0`);localStorage.removeItem(`gakja-quiz-activity:${data.user.id}:${session.id}`);}catch{}
      if(scopeRef.current!==capture)return;
      pendingAnswer.current=null;setSession(result.session);setDone(true);setDraftState('답변 저장됨');await refresh();
    }catch(err){if(scopeRef.current===capture)setError((err as Error).message);}finally{if(scopeRef.current===capture)setBusy(false);}
  }
  const loading=loaded!==scope;
  if(loading)return <section className={styles.page}><p role="status">첫 공통 질문을 불러오고 있어요.</p></section>;
  return <section className={styles.page} aria-labelledby="first-question-heading"><p className={styles.eyebrow}><Clock3 size={16}/>3분 · 공통 질문 한 개</p><h1 id="first-question-heading" tabIndex={-1} ref={heading}>{done?'첫 답을 저장했어요.':started?'한 문장이면 시작할 수 있어요.':'내 말로 답하는 첫 3분.'}</h1><p className={styles.intro}>{done?'질문 한 개를 끝까지 답했어요. 개인 자료를 연결하면 내 경험으로 더 구체적으로 연습할 수 있어요.':'생기부나 경험 카드를 먼저 작성할 필요 없어요. 준비되는 만큼 짧게 답해봐요.'}</p><p className={styles.source}>공통 연습 질문 · 개인 학생부에서 만든 질문이 아니에요.{target&&` · ${target.university} 지원처에 연결`}</p>
    {error&&<Alert>{error}</Alert>}{target&&!started&&<Link className={styles.schoolLink} href="/start?general=1">학교 연결 없이 공통 면접 질문으로 시작하기</Link>}
    {done?<><blockquote className={styles.savedAnswer}>{answer}</blockquote><p className={styles.status} role="status">서버에 답변 저장됨 · 실력이나 합격 가능성을 판정한 결과는 아니에요.</p><div className={styles.actions}><Link className="button primary" href={data.targets.length?'/my':'/schools/new?onboarding=1'}>{data.targets.length?'오늘의 학습으로':'학교와 일정 연결하기 (선택)'}<ArrowRight size={17}/></Link><button className="text-link" onClick={()=>{try{localStorage.removeItem(key);}catch{}setDone(false);setStarted(false);setSession(null);setAnswer('');}}>공통 질문 다시 답하기</button></div></>:started?<><div className={styles.question}><h2>{question?.prompt}</h2>{selected.length>0&&<p>떠올릴 키워드: {selected.join(' · ')} · 답에 꼭 넣지 않아도 돼요.</p>}</div><label className={styles.answer}>내가 하고 싶은 답 한 문장<textarea value={answer} disabled={busy} onChange={event=>setAnswer(event.target.value)} placeholder="저는 …한 경험에서 …을 배웠어요." maxLength={10000} rows={5}/></label><p className={styles.status} role="status">{draftState||'입력하면 초안을 보관해요.'}</p><ActionButton className="button primary" pending={busy} disabled={!answer.trim()} onClick={()=>void submit()}>한 문장 저장하고 완료<Check size={17}/></ActionButton></>:<><div className={styles.keywords}><h2>무엇부터 떠올려 볼까요? <small>선택 · 최대 3개</small></h2><div role="group" aria-label="첫 답변 키워드">{keywords.map(keyword=><button type="button" key={keyword} aria-pressed={selected.includes(keyword)} disabled={!selected.includes(keyword)&&selected.length>=3} onClick={()=>setSelected(previous=>previous.includes(keyword)?previous.filter(value=>value!==keyword):[...previous,keyword])}>{keyword}</button>)}</div><p>키워드는 생각을 돕는 메모예요. 개인 경험이나 사실로 저장하지 않아요.</p></div><div className={styles.actions}><ActionButton className="button primary" pending={busy||loading} disabled={!question} onClick={()=>void start()}>질문 한 개 답해보기<ArrowRight size={17}/></ActionButton><button className="text-link" disabled={busy||loading||!question} onClick={()=>{setSelected([]);void start();}}>키워드 건너뛰고 시작</button></div></>}
    {!done&&<Link className={styles.schoolLink} href={data.targets.length?'/my':'/schools/new?onboarding=1'}>{data.targets.length?'오늘로 돌아가기':'학교부터 등록할게요'}</Link>}
  </section>;
}
