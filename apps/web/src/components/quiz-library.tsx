'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import {useEffect,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {ArrowUpRight,Clock3,Play} from 'lucide-react';
import {useApp} from './app-shell';
import {api,Alert,Breadcrumb,Empty,PageTitle,Spinner,type Item} from './shared';

/** The library and quiz start screen use the same server-validated practice pool. */
export function QuizLibrary(){
  const {targetId:appTargetId}=useApp(),params=useSearchParams();
  const targetId=params.get('targetId')||appTargetId;
  const sourceType=['common','personal'].includes(params.get('sourceType')||'')?params.get('sourceType'):null;
  const sourceVersion=sourceType?params.get('sourceVersion'):null;
  const context=new URLSearchParams({...targetId?{targetId}:{},...sourceType?{sourceType}:{},...sourceVersion?{sourceVersion}:{}}).toString();
  const [loaded,setLoaded]=useState<Item|null>(null),[error,setError]=useState(''),[filter,setFilter]=useState('all'),[reload,setReload]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoaded(null);setError('');setFilter('all');
    api('/api/quiz'+(context?'?'+context:''),{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setLoaded({...value,scope:context});}).catch(err=>{if(!controller.signal.aborted)setError((err as Error).message);});
    return()=>controller.abort();
  },[context,reload]);
  const dto=loaded?.scope===context?loaded:null;
  const items:Item[]=[...new Map<string,Item>([...(dto?.library?.answer||[]).map((item:Item)=>({...item,mode:'answer'})),...(dto?.library?.choice||[]).map((item:Item)=>({...item,mode:'choice'}))].filter((item:Item)=>!sourceType||(item.source_kind==='common'?'common':'personal')===sourceType).map((item:Item)=>[item.id,item])).values()];
  // Prefer the choice mode for a reviewed MCQ; its Q&A variant remains available on the start screen.
  const filtered=items.filter(item=>filter==='all'||item.mode===filter);
  const quizHref='/quiz'+(context?'?'+context:'');
  function practiceHref(item:Item){
    const query=new URLSearchParams({memoryItemId:item.id,focus:'free',mode:item.mode,sourceType:item.source_kind==='common'?'common':'personal'});
    const savedTarget=item.target_id||targetId;
    if(savedTarget)query.set('targetId',savedTarget);
    const version=item.source_kind==='common'?item.common_revision:dto?.contentVersion;
    if(version)query.set('sourceVersion',String(version));
    return '/quiz?'+query.toString();
  }
  const scopeName=[dto?.target?.university,dto?.target?.department||dto?.target?.major].filter(Boolean).join(' · ');
  return <div className={ownedClassName("training-view memory-library",true)}>
    <Breadcrumb items={[{label:'퀴즈',href:quizHref},{label:'전체 복습 항목'}]}/>
    <PageTitle title="전체 복습 항목" aside={dto&&<span className={ownedClassName("training-count",true)}>{items.length}개 항목</span>}/>
    {error&&<><Alert>{error}</Alert><button className={ownedClassName("button secondary",true)} onClick={()=>setReload(value=>value+1)}>다시 불러오기</button></>}
    {!dto&&!error?<Spinner/>:dto&&<>
      {scopeName&&<p className={ownedClassName("quiz-note",true)}>{scopeName}</p>}
      {!!items.length&&<section className={ownedClassName("training-recall-intro",true)}><div className={ownedClassName(undefined,true)}><h2 className={ownedClassName(undefined,true)}>질문을 골라 복습해요</h2></div><Link className={ownedClassName("button primary")} href={practiceHref(items[0])}><Play size={15} fill="currentColor"/>복습 시작</Link></section>}
      {!!items.length&&<div className={ownedClassName("training-filters",true)} aria-label="훈련 유형">{[['all','전체'],['choice','10초 퀴즈'],['answer','Q&A']].filter(([key])=>key==='all'||items.some(item=>item.mode===key)).map(([key,label])=><button className={ownedClassName(filter===key?'active':'',true)} aria-pressed={filter===key} onClick={()=>setFilter(key)} key={key}>{label}</button>)}</div>}
      <div className={ownedClassName("training-memory-list",true)}>{filtered.map(item=><Link className={ownedClassName("training-memory-row")} key={item.id} href={practiceHref(item)}><span className={ownedClassName("training-memory-kind",true)}>{item.source_kind==='common'?'학교·공통 질문':'내 교재'}</span><h3 className={ownedClassName(undefined,true)}>{item.prompt}</h3><span className={ownedClassName("training-memory-time",true)}>{item.mode==='choice'?<><Clock3 size={15} strokeWidth={1.5}/>10초</>:'Q&A'}</span><ArrowUpRight size={21} strokeWidth={1.5}/></Link>)}</div>
      {!items.length?<Empty title="지금 복습할 항목이 없어요" href={quizHref} label="퀴즈로 돌아가기"/>:!filtered.length&&<p className={ownedClassName("training-empty-filter",true)}>해당하는 훈련 항목이 없어요.</p>}
    </>}
  </div>;
}
