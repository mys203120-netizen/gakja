'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useApp } from './app-shell';
import { action, Alert } from './shared';
export function LearningPreferences(){const {data,refresh,toast}=useApp(),[busy,setBusy]=useState(false),[error,setError]=useState('');async function toggle(value:boolean){if(busy)return;setBusy(true);try{await action('preference',{notificationsEnabled:value});await refresh();setError('');toast(value?'앱 알림을 켰어요.':'앱 알림을 껐어요.');}catch(err){setError((err as Error).message);}finally{setBusy(false);}}return <section><h2>내 학습 기록</h2>{error&&<Alert>{error}</Alert>}<label className="learning-preferences-row"><div><strong>앱 알림</strong><p>자료와 과제 알림을 앱에서 확인해요.</p></div><input type="checkbox" aria-label="앱 알림" checked={data.preferences?.notificationsEnabled!==false} disabled={busy} onChange={e=>toggle(e.target.checked)}/></label><div className="learning-preferences-row"><div><strong>학습 기록 내보내기</strong><p>저장한 답변과 연습 이력을 가져갈 수 있어요.</p></div><Link className="text-link" href="/records">내 기록<ArrowUpRight size={15}/></Link></div></section>;}
