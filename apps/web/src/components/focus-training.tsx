'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {api,post,Alert,ActionButton,type Item} from './shared';
import styles from './armory.module.css';
export function FocusTraining({targetId}:{targetId:string}){
  const [result,setResult]=useState<Item|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[retry,setRetry]=useState(0);const lock=useRef(false);
  useEffect(()=>{const abort=new AbortController();setResult(null);setError('');setSaved(false);if(targetId)api('/api/practice/focus?targetId='+encodeURIComponent(targetId),{signal:abort.signal,cache:'no-store'}).then(setResult).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[targetId,retry]);
  async function save(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await post('/api/practice/focus',{targetId,token:result?.token});setSaved(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);lock.current=false;}}
  if(!targetId)return null;
  return <section className={styles.detail} aria-label="약점 집중 훈련"><h2>한 번 더 연습할 부분</h2><p className={styles.hint}>현재 지원처의 최근 오답·시간 초과·도움 사용 기록으로 고른 질문이에요. 도움 사용은 실력 평가가 아니에요.</p>{error&&<Alert>{error}<button className="text-link" onClick={()=>setRetry(n=>n+1)}>다시 불러오기</button></Alert>}{!result&&!error?<p role="status">연습 기록을 살펴보고 있어요.</p>:result?.items?.length?<><p>오늘 떠올리기 → 내일 말하기 → 3일 뒤 다시 확인</p>{result.items.map((item:Item)=><article className={styles.fact} key={item.id}><small>{item.reason}</small><h3>{item.title}</h3><div className={styles.actions}><Link className="text-link" href={item.quizHref}>다시 떠올리기</Link><Link className="text-link" href={item.interviewHref}>꼬리질문 연습</Link><Link className="text-link" href={item.comparisonHref}>답변 비교</Link></div></article>)}{saved?<p role="status">집중 훈련을 저장했어요. <Link href="/my#dashboard-planner">캘린더에서 확인하기 →</Link></p>:<ActionButton className="button primary" pending={busy} pendingLabel="훈련 저장 중" onClick={save}>3단계 집중 훈련을 캘린더에 담기</ActionButton>}</>:result&&<p>아직 집중 훈련이 필요한 기록이 없어요. 퀴즈나 면접을 연습하면 여기에 모아드려요.</p>}</section>;
}
