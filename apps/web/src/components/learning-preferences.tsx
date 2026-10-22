'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import {useRef,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {useApp} from './app-shell';
import {action,Alert} from './shared';
import {MotionSwitch} from './sliding-choice';

export function LearningPreferences() {
  const {data,refresh,toast}=useApp();
  const [error,setError]=useState<{owner:string;message:string}|null>(null);
  const [pending,setPending]=useState<{owner:string;key:string;value:boolean}|null>(null);
  const saving=useRef<{owner:string}|null>(null),currentOwner=useRef(data.user.id);currentOwner.current=data.user.id;
  const busy=pending?.owner===data.user.id;
  async function toggle(key:'notificationsEnabled'|'helpEnabled'|'enterToSend',value:boolean) {
    if(saving.current?.owner===data.user.id)return;
    const owner=data.user.id,attempt={owner};saving.current=attempt;setPending({owner,key,value});
    try {
      await action('preference',{[key]:value});if(currentOwner.current!==owner)return;await refresh();if(currentOwner.current!==owner)return;setError(null);
      toast(key==='enterToSend'?(value?'Enter로 전송해요. Shift+Enter는 줄바꿈이에요.':'Enter는 줄바꿈, 연속 두 번 누르면 전송해요.'):key==='helpEnabled'?(value?'도움말을 표시해요.':'도움말을 숨겼어요.'):(value?'앱 알림을 켰어요.':'앱 알림을 껐어요.'));
    } catch(err) {if(currentOwner.current===owner)setError({owner,message:(err as Error).message});}
    finally {if(saving.current===attempt){saving.current=null;setPending(null);}}
  }
  return <section className={ownedClassName(undefined,true)}>
    <h2 className={ownedClassName(undefined,true)}>입력·화면·알림</h2>
    {error&&error.owner===data.user.id&&<Alert>{error.message}</Alert>}
    {([['enterToSend','Enter로 전송'],['helpEnabled','도움말 표시'],['notificationsEnabled','앱 알림']] as const).map(([key,label])=><div className={ownedClassName("learning-preferences-row",true)} key={key}>
      <strong className={ownedClassName(undefined,true)}>{label}</strong>
      <MotionSwitch label={label} checked={pending&&pending.owner===data.user.id&&pending.key===key?pending.value:data.preferences?.[key]!==false} disabled={busy} onChange={value=>void toggle(key,value)}/>
    </div>)}
    <div className={ownedClassName("learning-preferences-row",true)}><strong className={ownedClassName(undefined,true)}>학습 기록 내보내기</strong><Link className={ownedClassName("text-link")} href="/records">내 기록<ArrowUpRight size={15}/></Link></div>
  </section>;
}
