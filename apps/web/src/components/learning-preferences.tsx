'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import {useRef,useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {useApp} from './app-shell';
import {action,Alert} from './shared';

export function LearningPreferences() {
  const {data,refresh,toast}=useApp();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const saving=useRef(false);
  async function toggle(key:'notificationsEnabled'|'helpEnabled'|'enterToSend',value:boolean) {
    if(saving.current)return;
    saving.current=true;setBusy(true);
    try {
      await action('preference',{[key]:value});await refresh();setError('');
      toast(key==='enterToSend'?(value?'Enter로 전송해요. Shift+Enter는 줄바꿈이에요.':'Enter는 줄바꿈, 연속 두 번 누르면 전송해요.'):key==='helpEnabled'?(value?'도움말을 표시해요.':'도움말을 숨겼어요.'):(value?'앱 알림을 켰어요.':'앱 알림을 껐어요.'));
    } catch(err) {setError((err as Error).message);}
    finally {saving.current=false;setBusy(false);}
  }
  return <section className={ownedClassName(undefined,true)}>
    <h2 className={ownedClassName(undefined,true)}>입력·화면·알림</h2>
    {error&&<Alert>{error}</Alert>}
    {([['enterToSend','Enter로 전송'],['helpEnabled','도움말 표시'],['notificationsEnabled','앱 알림']] as const).map(([key,label])=><label className={ownedClassName("learning-preferences-row",true)} key={key}>
      <strong className={ownedClassName(undefined,true)}>{label}</strong>
      <span className={ownedClassName("motion-toggle-field",true)}>
        <input className={ownedClassName("motion-toggle-input",true)} type="checkbox" role="switch" aria-label={label} checked={data.preferences?.[key]!==false} disabled={busy} onChange={event=>void toggle(key,event.target.checked)}/>
        <span className={ownedClassName("motion-toggle-track",true)} aria-hidden="true"><span className={ownedClassName("motion-toggle-thumb",true)}/></span>
      </span>
    </label>)}
    <div className={ownedClassName("learning-preferences-row",true)}><strong className={ownedClassName(undefined,true)}>학습 기록 내보내기</strong><Link className={ownedClassName("text-link")} href="/records">내 기록<ArrowUpRight size={15}/></Link></div>
  </section>;
}
