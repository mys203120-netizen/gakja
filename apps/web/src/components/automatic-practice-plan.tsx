'use client';
import {useRef,useState} from 'react';
import {Sparkles,ArrowLeft} from 'lucide-react';
import {useApp} from './app-shell';
import {Modal,Alert,ActionButton,api,post,targetName,type Item} from './shared';
import {koreaToday,shiftPlanDay} from '@/lib/planner-model';
import {practiceDeadline} from '@/lib/automatic-practice';
import styles from './automatic-practice-plan.module.css';

export function AutomaticPracticePlan({plans,onPlans,configuration=[],onConfiguration}:{plans:Item[];onPlans:(plans:Item[])=>void;configuration?:Item[];onConfiguration?:(items:Item[])=>void}){
  const {target,targetId,toast}=useApp();const [open,setOpen]=useState(false);
  const configured=configuration.find(item=>item.targetId===targetId);
  const settings=configured?{interviewDate:configured.date,dailyMinutes:configured.dailyMinutes,enabled:configured.enabled}:plans.filter(plan=>plan.target?.targetId===targetId&&plan.target?.automaticPractice).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]?.target.automaticPractice;
  return <><button className="button secondary" onClick={()=>setOpen(true)}><Sparkles size={16}/>면접일까지 자동 계획</button>{open&&<Modal title="면접일까지, 하루 한 걸음" onClose={()=>setOpen(false)}>{target?<PlanForm key={targetId} target={target} settings={settings} onSaved={(plans,configuration,paused)=>{onPlans(plans);onConfiguration?.(configuration);toast(paused?'자동 계획을 중지했어요. 기존 연습 기록은 그대로 남겨요.':'면접일까지의 연습 계획을 캘린더에 담았어요.');setOpen(false);}}/>:<p>지원 학교를 먼저 등록해 주세요. <a href="/schools">지원 학교로 이동</a></p>}</Modal>}</>;
}
function PlanForm({target,settings,onSaved}:{target:Item;settings?:Item;onSaved:(plans:Item[],configuration:Item[],paused?:boolean)=>void}){
  const deadline=practiceDeadline(target,settings),savedDate=deadline?.date,today=koreaToday();
  const [date,setDate]=useState(savedDate?(savedDate.includes('T')?koreaToday(new Date(savedDate)):savedDate):'');
  const [minutes,setMinutes]=useState(settings?.dailyMinutes||20),[preview,setPreview]=useState<Item|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  async function submit(){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{
      const result=await post('/api/planner/automatic',{action:preview?'save':'preview',targetId:target.id,interviewDate:date,minutes,...(preview?{previewToken:preview.previewToken}:{})});
      if(preview){const refreshed=await api('/api/planner',{cache:'no-store'});onSaved(refreshed.plans,refreshed.automaticPractice||[]);}
      else setPreview(result);
    }catch(e){setError((e as Error).message);if(preview)setPreview(null);}finally{lock.current=false;setBusy(false);}
  }
  async function pause(){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{await post('/api/planner/automatic',{action:'pause',targetId:target.id});const refreshed=await api('/api/planner',{cache:'no-store'});onSaved(refreshed.plans,refreshed.automaticPractice||[],true);}
    catch(error){setError((error as Error).message);}finally{lock.current=false;setBusy(false);}
  }
  return <div className={styles.form}>
    <div className={styles.intro}><span>{targetName(target)} · {target.department||target.major}</span><p>질문 익히기부터 답변 리허설까지.<br/>남은 날짜에 맞춰 연습을 나눠 드려요.</p></div>
    {!preview?<><label>{deadline?.source==='public_day'?'학교 공개 면접일':deadline?.source==='personal'?'개별 면접일':'준비 목표일'}<input type="date" value={date} disabled={Boolean(deadline&&deadline.source!=='goal')} min={shiftPlanDay(today,1)} max={shiftPlanDay(today,180)} onChange={e=>setDate(e.target.value)}/><small>{deadline&&deadline.source!=='goal'?'등록된 면접일을 기준으로 준비해요. 날짜가 달라지면 학교 일정에서 수정해 주세요.':'개별 응시일이 미정이라면 준비 목표일을 정할 수 있어요. 학교의 공식 일정은 변경되지 않아요.'}</small></label><fieldset><legend>하루에 얼마나 연습할까요?</legend><div className={styles.choices}>{[10,20,30].map(value=><button type="button" key={value} aria-pressed={minutes===value} onClick={()=>setMinutes(value)}>{value}분</button>)}</div></fieldset><p className={styles.note}>앞으로 최대 7일의 계획을 만들고, 접속할 때 남은 날짜와 연습 기록에 맞춰 조정해요. 여러 학교와 직접 만든 계획도 하루 분량을 나눠 써요. 면접 전날은 10분만 가볍게 마무리해요.</p></>:<><div className={styles.summary}><strong>{new Set(preview.plans.map((plan:Item)=>plan.date)).size}일 · {preview.plans.length}개 연습</strong><span>하루 최대 {minutes}분 · {date} 면접 준비</span></div><ol className={styles.list}>{preview.plans.map((plan:Item,index:number)=><li key={index}><span>{plan.date} · 약 {plan.minutes}분</span><strong>{plan.title}</strong><small>{plan.reason}</small></li>)}</ol><p className={styles.note}>{preview.replaceCount?`진행 전 자동 계획 ${preview.replaceCount}개를 새 계획으로 조정해요. `:''}밀린 자동 과제는 새 계획에 반영하고, 직접 만든 계획과 완료·연습 기록은 보존해요.</p><button className="text-link" disabled={busy} onClick={()=>{setPreview(null);setError('');}}><ArrowLeft size={15}/>날짜·시간 다시 설정</button></>}
    {error&&<Alert>{error}</Alert>}
    <ActionButton className="button primary" pending={busy} pendingLabel={preview?'계획 저장 중':'계획 만드는 중'} disabled={!date} onClick={submit}>{preview?'캘린더에 계획 저장':'나의 계획 미리보기'}</ActionButton>
    {settings&&settings.enabled!==false&&<button type="button" className="text-link" disabled={busy} onClick={pause}>자동 계획 중지</button>}
  </div>;
}
