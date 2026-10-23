'use client';
import {Download,LoaderCircle} from 'lucide-react';
import {useState} from 'react';
import styles from './report-download.module.css';

export function ReportDownload({reportId,studyId,date}:{reportId?:string;studyId?:string;date?:string}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function download(){
    if(busy)return;setBusy(true);setError('');
    try{const params=new URLSearchParams(reportId?{reportId}:studyId?{studyId}:{date:date||''});const response=await fetch('/api/report-export?'+params,{cache:'no-store'});if(!response.ok){const result=await response.json();throw new Error(result.error||'리포트를 내려받지 못했어요.');}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`각자ON-${date||'훈련'}-리포트.html`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  return <div className={styles.download}><button type="button" onClick={()=>void download()} disabled={busy} aria-label={date?`${date} 리포트 다운로드`:'훈련 리포트 다운로드'}>{busy?<LoaderCircle size={16} className={styles.loading}/>:<Download size={16}/>}<span>{busy?'준비 중':'리포트 다운로드'}</span></button>{error&&<p role="alert">{error}</p>}</div>;
}
