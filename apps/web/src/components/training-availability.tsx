'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowRight,CalendarDays,Clock3,Plus,X} from 'lucide-react';
import {useApp} from './app-shell';
import {api,post,ActionButton,Alert,FloatingNotice,InfoTip,Spinner} from './shared';
import {availabilityInput,availabilityInputSchema,availabilityMinutesForDate,validAvailabilityDate,type TrainingAvailability,type TrainingAvailabilityInput} from '@/lib/training-availability';
import {MinuteWheel} from './minute-wheel';
import styles from './training-availability.module.css';

type PreferencesResponse={availability:TrainingAvailability|null;registeredAt:string;startDate:string};
type Props={onboarding?:boolean;schoolLabel?:string;interviewLabel?:string};
const koreaToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const displayMinutes=(value:number)=>value>=60?`${Math.floor(value/60)}시간${value%60?` ${value%60}분`:''}`:`${value}분`;
const shortDate=(value:string)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',weekday:'short'}).format(new Date(`${value}T00:00:00Z`));
const defaults=():TrainingAvailabilityInput=>({weekdayMinutes:120,weekendMinutes:120,blockedDates:[],overrides:{}});

/** The initial values are an editable proposal. Nothing is persisted until the student presses save. */
export function TrainingAvailability({onboarding=false,schoolLabel,interviewLabel}:Props){
  const {refresh}=useApp(),router=useRouter(),id=useId(),heading=useRef<HTMLHeadingElement>(null);
  const [today]=useState(koreaToday),[settings,setSettings]=useState<TrainingAvailabilityInput>(()=>defaults());
  const [remote,setRemote]=useState<PreferencesResponse|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[retry,setRetry]=useState(0);
  const [blockedDate,setBlockedDate]=useState(''),[overrideDate,setOverrideDate]=useState(''),[overrideMinutes,setOverrideMinutes]=useState(120);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    api<PreferencesResponse>('/api/training/preferences',{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted)return;setRemote(result);setSettings(result.availability?availabilityInput(result.availability,today):defaults());setSaved(false);
    }).catch(err=>{if(!controller.signal.aborted)setError((err as Error).message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[retry,today]);
  useEffect(()=>{if(!loading)heading.current?.focus();},[loading]);
  function update<K extends keyof TrainingAvailabilityInput>(key:K,value:TrainingAvailabilityInput[K]){setSettings(previous=>({...previous,[key]:value}));setSaved(false);}
  function addBlockedDate(){
    if(!validAvailabilityDate(blockedDate)){setError('쉬는 날짜를 선택해 주세요.');return;}
    update('blockedDates',[...new Set([...settings.blockedDates,blockedDate])].sort());setBlockedDate('');setError('');
  }
  function addOverride(){
    if(!validAvailabilityDate(overrideDate)||!Number.isInteger(overrideMinutes)||overrideMinutes<0||overrideMinutes>480){setError('날짜와 0~480분 사이의 시간을 입력해 주세요.');return;}
    update('overrides',{...settings.overrides,[overrideDate]:overrideMinutes});setOverrideDate('');setError('');
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||!remote)return;
    if(!availabilityInputSchema.safeParse(settings).success){setError('시간은 0~480분으로 입력하고 날짜를 확인해 주세요.');return;}
    setBusy(true);setError('');setSaved(false);
    try{
      const result=await post('/api/training/preferences',{expectedRevision:remote.availability?.revision??0,availability:settings});
      setRemote(previous=>previous?{...previous,availability:result.availability}:previous);setSettings(availabilityInput(result.availability,today));setSaved(true);
      await refresh();
      if(onboarding)router.push('/my');
    }catch(err){setError((err as Error).message);}
    finally{setBusy(false);}
  }
  if(loading)return <Spinner/>;
  if(!remote)return <div className={ownedClassName(styles.page,true)}><Alert>{error||'학습 시간 설정을 불러오지 못했어요.'}</Alert><button className={ownedClassName("button",true)} onClick={()=>setRetry(value=>value+1)}>다시 불러오기</button></div>;
  const preview:TrainingAvailability={...settings,version:2,startDate:remote.startDate,revision:remote.availability?.revision??1,savedAt:remote.availability?.savedAt??new Date().toISOString()};
  const days=Array.from({length:7},(_,index)=>{const date=new Date(`${today}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+index);return date.toISOString().slice(0,10);});
  const total=days.reduce((sum,date)=>sum+availabilityMinutesForDate(preview,date),0);
  return <div className={ownedClassName(styles.page,true)}>
    <header className={ownedClassName(styles.header,true)}><h1 ref={heading} tabIndex={-1} className={ownedClassName(undefined,true)}>학습 시간 설정</h1></header>
    {schoolLabel&&<div className={ownedClassName(styles.school,true)}><CalendarDays size={19}/><div className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{schoolLabel}</strong>{interviewLabel&&<span className={ownedClassName(undefined,true)}>{interviewLabel}</span>}</div><span className={ownedClassName(styles.schoolStatus,true)}>지원 학교 등록됨</span></div>}
    <form className={ownedClassName(styles.workspace,true)} onSubmit={submit}>
      <fieldset disabled={busy} className={ownedClassName(styles.fields,true)}>
        <section className={ownedClassName(styles.section,true)} aria-labelledby={`${id}-base`}><div className={ownedClassName(styles.sectionHeading,true)}><span className={ownedClassName(undefined,true)}>01</span><div className={ownedClassName(undefined,true)}><h2 id={`${id}-base`} className={ownedClassName(undefined,true)}>하루 학습 시간<InfoTip label="하루 학습 시간 입력 안내">0분인 날에는 훈련을 배치하지 않아요. 하루 최대 480분까지 설정할 수 있어요.</InfoTip></h2></div></div><div className={ownedClassName(styles.timeGrid,true)}><MinuteField disabled={busy} inlineLabel label="평일" value={settings.weekdayMinutes} onChange={value=>update('weekdayMinutes',value)}/><MinuteField disabled={busy} inlineLabel label="주말" value={settings.weekendMinutes} onChange={value=>update('weekendMinutes',value)}/></div></section>
        <section className={ownedClassName(styles.section,true)} aria-labelledby={`${id}-blocked`}><div className={ownedClassName(styles.sectionHeading,true)}><span className={ownedClassName(undefined,true)}>02</span><div className={ownedClassName(undefined,true)}><h2 id={`${id}-blocked`} className={ownedClassName(undefined,true)}>쉬는 날·날짜별 시간<InfoTip label="쉬는 날과 날짜별 시간 적용 안내">쉬는 날에는 훈련을 배치하지 않아요. 쉬는 날 설정이 날짜별 시간보다 우선하며, 날짜별 시간은 평일·주말 설정보다 우선해요.</InfoTip></h2></div></div><div className={ownedClassName(styles.dateEntry,true)}><label className={ownedClassName(undefined,true)}><span className={ownedClassName("sr-only",true)}>쉬는 날짜</span><input type="date" value={blockedDate} min={today} onChange={event=>setBlockedDate(event.target.value)} className={ownedClassName(undefined,true)}/></label><button type="button" className={ownedClassName("button",true)} onClick={addBlockedDate} disabled={!blockedDate}><Plus size={16}/>날짜 추가</button></div>{settings.blockedDates.length>0?<ul className={ownedClassName(styles.chips,true)}>{settings.blockedDates.map(date=><li key={date} className={ownedClassName(undefined,true)}><time dateTime={date} className={ownedClassName(undefined,true)}>{date}</time><button type="button" aria-label={`${date} 쉬는 날 해제`} onClick={()=>update('blockedDates',settings.blockedDates.filter(item=>item!==date))} className={ownedClassName(undefined,true)}><X size={14}/></button></li>)}</ul>:null}
          <details className={ownedClassName(styles.overrides,true)}><summary className={ownedClassName(undefined,true)}>특정 날짜만 시간을 다르게 설정</summary><div className={ownedClassName(styles.overrideEntry,true)}><label className={ownedClassName(undefined,true)}>날짜<input type="date" value={overrideDate} min={today} onChange={event=>setOverrideDate(event.target.value)} className={ownedClassName(undefined,true)}/></label><MinuteField disabled={busy} label="가능한 시간" value={overrideMinutes} onChange={setOverrideMinutes}/><button type="button" className={ownedClassName("button",true)} onClick={addOverride} disabled={!overrideDate}>적용</button></div>{Object.entries(settings.overrides).sort(([left],[right])=>left.localeCompare(right)).map(([date,minutes])=><div className={ownedClassName(styles.overrideRow,true)} key={date}><span className={ownedClassName(undefined,true)}>{date}</span><strong className={ownedClassName(undefined,true)}>{displayMinutes(minutes)}{settings.blockedDates.includes(date)?' · 쉬는 날 우선':''}</strong><button type="button" aria-label={`${date} 개별 시간 삭제`} onClick={()=>{const next={...settings.overrides};delete next[date];update('overrides',next);}} className={ownedClassName(undefined,true)}><X size={15}/></button></div>)}</details>
        </section>
      </fieldset>
      <aside className={ownedClassName(styles.preview,true)} aria-label="학습 가능 시간 미리보기"><div className={ownedClassName(styles.previewTitle,true)}><Clock3 size={19}/><span className={ownedClassName(undefined,true)}>앞으로 7일</span><InfoTip label="학습 시간 미리보기 안내">전체 계획은 등록한 면접일까지 배치해요. 여기서는 앞으로 7일의 설정 시간을 미리 보여줘요.</InfoTip></div><p className={ownedClassName(styles.total,true)}>{displayMinutes(total)}</p><ul className={ownedClassName(styles.days,true)}>{days.map(date=>{const minutes=availabilityMinutesForDate(preview,date);return <li key={date} data-rest={minutes===0} className={ownedClassName(undefined,true)}><time dateTime={date} className={ownedClassName(undefined,true)}>{shortDate(date)}</time><strong className={ownedClassName(undefined,true)}>{minutes?displayMinutes(minutes):'쉬는 날'}</strong></li>;})}</ul></aside>
      <div className={ownedClassName(styles.footer,true)}>{error&&<div className={ownedClassName(styles.error,true)}><Alert>{error}</Alert><button type="button" className={ownedClassName("text-link",true)} disabled={busy} onClick={()=>setRetry(value=>value+1)}>최신 설정 다시 불러오기</button></div>}{saved&&!onboarding&&<FloatingNotice onDismiss={()=>setSaved(false)}>학습 시간을 저장했어요.</FloatingNotice>}<div className={ownedClassName(styles.actions,true)}><ActionButton type="submit" className={ownedClassName("button primary")} pending={busy} pendingLabel="학습 시간 저장 중">저장하기<ArrowRight size={17}/></ActionButton></div>{!onboarding&&<Link className={ownedClassName(styles.return)} href="/training">오늘 훈련으로 돌아가기</Link>}</div>
    </form>
  </div>;
}

function MinuteField({label,value,onChange,disabled=false,inlineLabel=false}:{label:string;value:number;onChange:(value:number)=>void;disabled?:boolean;inlineLabel?:boolean}){
  const id=useId();
  return <div className={ownedClassName(`${styles.minuteField}${inlineLabel?' '+styles.inlineMinuteField:''}`,true)}><label htmlFor={id} className={ownedClassName(undefined,true)}>{label}</label><span className={ownedClassName(styles.desktopMinutes,true)}><input id={id} aria-label={label} type="number" min={0} max={480} step={1} required inputMode="numeric" value={value} disabled={disabled} onChange={event=>onChange(Number(event.target.value))} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}>분 / 하루</span></span><div className={ownedClassName(styles.mobileMinutes,true)}><MinuteWheel label={label} value={value} onChange={onChange} disabled={disabled}/></div></div>;
}
