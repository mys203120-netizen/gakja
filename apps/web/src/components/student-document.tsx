'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,Check,Download,FileText,LockKeyhole,RefreshCw,Upload} from 'lucide-react';
import {useApp} from './app-shell';
import {api,ActionButton,Alert,Spinner,type Item} from './shared';
import {ownedClassName} from './owned-class-name';
import styles from './student-document.module.css';
import {StudentDocumentReview} from './student-document-review';
import type {DocumentPage} from '@/lib/student-document-model';

type Detail={document:Item|null;analysis:Item|null;pages:DocumentPage[];history:Item[];preview?:Item|null;textRevision?:number;textVersions?:Item[]};
const consentVersion='student-record-2026-10-23';
const statuses:Record<string,string>={pending:'분석 대기',processing:'원문을 분석하고 있어요',completed:'분석 완료',failed:'분석을 다시 시도해 주세요',unconfigured:'자동 분석 연결 준비 중'};
export function StudentDocument({onboarding=false}:{onboarding?:boolean}){
  const {data,refresh}=useApp(),[detail,setDetail]=useState<Detail|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[file,setFile]=useState<File|null>(null),[consent,setConsent]=useState(false),[reload,setReload]=useState(0);
  const active=useRef(true),lastCompleted=useRef<number|null>(null);
  const [previewUrl,setPreviewUrl]=useState('');
  const [editing,setEditing]=useState(false),[replacing,setReplacing]=useState(false);
  useEffect(()=>{if(!file){setPreviewUrl('');return;}const url=URL.createObjectURL(new Blob([file],{type:'application/pdf'}));setPreviewUrl(url);return()=>URL.revokeObjectURL(url);},[file]);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{let alive=true;const controller=new AbortController();api<Detail>('/api/student-document',{cache:'no-store',signal:controller.signal}).then(result=>{if(alive){setDetail(result);if(result.document?.completed_revision&&lastCompleted.current!==result.document.completed_revision){lastCompleted.current=result.document.completed_revision;void refresh();}}}).catch(err=>{if(alive)setError((err as Error).message);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;controller.abort();};},[reload,refresh]);
  const running=detail?.document&&['pending','processing'].includes(detail.document.status),extracting=!!detail?.preview&&['pending','processing'].includes(detail.preview.status);
  useEffect(()=>{if(!running&&!extracting)return;const timer=setTimeout(()=>setReload(value=>value+1),4000);return()=>clearTimeout(timer);},[running,extracting,reload]);
  async function upload(event:FormEvent){event.preventDefault();if(!file||!consent||busy)return;setBusy(true);setError('');try{
    const form=new FormData();form.append('file',file);form.append('consent',consentVersion);
    const response=await fetch('/api/student-document',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw Error(result.error||'원본 등록을 완료하지 못했어요.');
    if(active.current){setFile(null);setConsent(false);setReplacing(false);setReload(value=>value+1);await refresh();}
  }catch(err){if(active.current)setError((err as Error).message);}finally{if(active.current)setBusy(false);}}
  async function retry(){setBusy(true);setError('');try{await api('/api/student-document',{method:'PATCH'});setReload(value=>value+1);await refresh();}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  async function update(body:Item){setBusy(true);setError('');try{await api('/api/student-document',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});setEditing(false);setReload(value=>value+1);await refresh();}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  if(loading)return <Spinner/>;
  if(!detail)return <div className={ownedClassName(styles.page,true)}><Alert>{error||'생기부를 불러오지 못했어요.'}</Alert><button className={ownedClassName('button')} onClick={()=>setReload(value=>value+1)}>다시 불러오기</button></div>;
  const document=detail.document,completed=detail.analysis;
  return <div className={ownedClassName(styles.page,true)}>
    <header className={ownedClassName(styles.heading,true)}><span className={ownedClassName(styles.mark,true)}><FileText size={26}/></span><div><p className={ownedClassName(styles.eyebrow,true)}>{onboarding?'나의 면접 준비 · 생기부 등록':'나의 원본과 분석'}</p><h1>생기부</h1><p>나의 활동에서 질문을 시작해요.</p></div></header>
    {error&&<Alert>{error}</Alert>}
    {!document&&detail.preview&&!replacing&&<>
      {detail.preview.status==='ready'?<StudentDocumentReview key={detail.preview.id} pages={detail.preview.pages} previewId={detail.preview.id} busy={busy} onSave={(pages)=>update({action:'confirm',previewId:detail.preview!.id,pages,consent:consentVersion})}/>:<section className={ownedClassName(styles.card,true)} aria-live="polite"><h2>{extracting?'페이지별 글자를 인식하고 있어요.':'PDF를 다시 확인해 주세요.'}</h2><p>{detail.preview.error_message||`${detail.preview.pages.filter((p:DocumentPage)=>p.ocrStatus!=='pending').length}/${detail.preview.pages.length||'?'}쪽 처리 · 한국어·영문 로컬 OCR`}</p><p>이 화면에 다시 오면 이어서 처리해요. 아직 원본이 고정되지 않았어요.</p></section>}
      {detail.preview.status==='ready'&&detail.preview.pages.some((p:DocumentPage)=>p.issue)&&<button className={ownedClassName('button')} disabled={busy} onClick={()=>update({action:'retry_ocr',previewId:detail.preview!.id})}>불확실한 페이지 다시 인식</button>}
      <button className={ownedClassName('button')} disabled={busy||extracting} onClick={()=>setReplacing(true)}>다른 PDF로 다시 선택</button>
      {onboarding&&<Link className={ownedClassName(styles.next)} href="/availability?onboarding=1">먼저 학습 시간 설정<ArrowRight size={15}/></Link>}
    </>}
    {!document?(detail.preview&&detail.preview.status!=='failed'&&!replacing?null:!(data?.targets?.length)?<section className={ownedClassName(styles.card,true)}><h2>지원 학과부터 알려주세요.</h2><p>등록한 학과를 기준으로 활동별 준비 우선도와 질문을 연결해요.</p><Link className={ownedClassName('button primary')} href="/schools/new?onboarding=1">학교·학과 등록<ArrowRight size={16}/></Link></section>:<form className={ownedClassName(styles.card,true)} onSubmit={upload}>
      <h2>학교생활기록부 PDF를 등록해 주세요.</h2>{replacing&&<button type="button" className={ownedClassName('button')} onClick={()=>setReplacing(false)}>기존 인식문 확인으로 돌아가기</button>}<p>문자 PDF·스캔 PDF 모두 가능 · 최대 10MB, 60쪽</p>
      <label className={ownedClassName(styles.upload,true)}><Upload size={28}/><strong>{file?file.name:'PDF 선택'}</strong><span>스캔 페이지는 한국어·영문을 로컬에서 인식해요.</span><input type="file" accept=".pdf,application/pdf" disabled={busy||extracting} onChange={event=>{setFile(event.target.files?.[0]||null);setConsent(false);setError('');}}/></label>
      {previewUrl&&<p><a className={ownedClassName('button')} href={previewUrl} target="_blank" rel="noreferrer">확정 전 PDF 페이지 미리보기</a></p>}
      <div className={ownedClassName(styles.notice,true)}><LockKeyhole size={18}/><p>확정 후 계정에는 이 원본 한 개가 연결돼요. 원본은 교체할 수 없고, 인식문 정정과 분석은 새 버전으로 남길 수 있어요. 파일이 본인의 전체 생기부인지 확인해 주세요.</p></div>
      <label className={ownedClassName(styles.consent,true)}><input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)}/><span>이 PDF의 임시 비공개 저장과 로컬 문자 인식에 동의해요. 페이지 확인 후 별도로 원본을 확정할게요.</span></label>
      <ActionButton type="submit" className={ownedClassName('button primary')} pending={busy} pendingLabel="PDF 전송 중" disabled={!file||!consent||extracting}>페이지 인식하고 확인<ArrowRight size={16}/></ActionButton>
    </form>):<>
      <section className={ownedClassName(styles.card,true)}><div className={ownedClassName(styles.cardTitle,true)}><h2><LockKeyhole size={18}/>등록한 원본</h2><span className={ownedClassName(styles.badge,true)}>고정됨</span></div><strong className={ownedClassName(styles.filename,true)}>{document.filename}</strong><p>{document.page_count}쪽 · {new Date(document.locked_at).toLocaleDateString('ko-KR')} 등록</p><a className={ownedClassName('button')} href="/api/student-document?download=original"><Download size={16}/>원본 PDF</a></section>
      <section className={ownedClassName(styles.card,true)} aria-live="polite"><div className={ownedClassName(styles.cardTitle,true)}><h2>{document.status==='completed'?<Check size={19}/>:<RefreshCw size={19}/>} {statuses[document.status]||'분석 준비'}</h2><span>{document.revision}차</span></div><p>{document.error_message||(running?'페이지별 원문 근거와 지원 학과를 연결하고 있어요. 다른 화면에 다녀와도 등록한 원본은 유지돼요.':'활동별 질문과 준비 우선도를 연결했어요. 원문과 AI 제안을 함께 확인해 주세요.')}</p>{running&&<p className={ownedClassName(styles.muted,true)}>5분 이상 멈춰 있다면 같은 원본으로 다시 요청할 수 있어요.</p>}
        {(!running||Date.now()-new Date(document.analysis_created_at).getTime()>300_000)&&<ActionButton className={ownedClassName('button')} pending={busy} onClick={retry}><RefreshCw size={16}/>{completed?'현재 지원처·지침으로 다시 분석':'같은 원본으로 다시 분석'}</ActionButton>}
        {completed&&<div className={ownedClassName(styles.actions,true)}><a className={ownedClassName('button')} href="/api/student-document?download=markdown"><Download size={16}/>분석 MD</a><Link className={ownedClassName('button primary')} href={onboarding?'/availability?onboarding=1':'/materials/activities'}>{onboarding?'학습 시간 설정':'활동과 질문 보기'}<ArrowRight size={16}/></Link></div>}
        {!completed&&onboarding&&<Link className={ownedClassName(styles.next)} href="/availability?onboarding=1">먼저 학습 시간 설정<ArrowRight size={15}/></Link>}
      </section>
      {completed&&<section className={ownedClassName(styles.card,true)}><h2>분석 {completed.revision}차</h2><p>준비 우선도는 면접 준비 순서에 관한 제안이에요. 능력 점수나 합격 가능성이 아니며, 개인 역할과 사실은 확인이 필요해요.</p>{completed.result.activities.map((activity:Item,index:number)=><details key={index} className={ownedClassName(styles.activity,true)}><summary><span>{activity.area} · {activity.grade}학년</span><strong>{activity.title}</strong></summary><p>{activity.summary}</p>{activity.priorities.map((priority:Item)=><p key={priority.targetId}><b>{completed.targets.find((target:Item)=>target.id===priority.targetId)?.department||'지원 학과'} · {priority.priority}</b> {priority.reason}</p>)}{activity.evidence.map((e:Item,i:number)=><blockquote key={i}><a href={`/api/student-document?page=${e.page}`} target="_blank" rel="noreferrer">원본 {e.page}쪽 보기</a><span> · 인식문 {completed.text_revision||1}차 인용</span><p>{e.quote}</p></blockquote>)}{activity.confirmations.length>0&&<ul>{activity.confirmations.map((text:string)=><li key={text}>확인 필요: {text}</li>)}</ul>}</details>)}{completed.result.limitations.length>0&&<ul className={ownedClassName(styles.muted,true)}>{completed.result.limitations.map((text:string)=><li key={text}>{text}</li>)}</ul>}</section>}
      {editing&&<StudentDocumentReview key={detail.textRevision} pages={detail.pages} busy={busy} onCancel={()=>setEditing(false)} onSave={(pages,reason)=>update({action:'correct_text',expectedRevision:detail.textRevision,pages,reason})}/>}
      <section className={ownedClassName(styles.card,true)}><h2>확인한 인식문 · {detail.textRevision||1}차</h2><p>원본에서 추출하거나 학생이 확인·정정한 텍스트예요. 정확한 배치와 표는 원본 PDF와 대조해 주세요.</p>{!editing&&<button className={ownedClassName('button')} onClick={()=>setEditing(true)}>인식 오류 정정</button>}{completed&&completed.text_revision!==detail.textRevision&&<p className={ownedClassName(styles.reviewWarning,true)}>현재 분석은 인식문 {completed.text_revision}차 기준이에요. 정정한 인식문으로 다시 분석해 주세요.</p>}{detail.pages.map(page=><details id={`page-${page.page}`} key={page.page} className={ownedClassName(styles.activity,true)}><summary>{page.page}쪽 원문</summary><pre className={ownedClassName(styles.source,true)}>{page.text}</pre></details>)}</section>
      {!!detail.textVersions?.length&&<details className={ownedClassName(styles.card,true)}><summary>인식문 버전 이력</summary>{detail.textVersions.map(version=><details key={version.revision} className={ownedClassName(styles.activity,true)}><summary>{version.revision}차 · {version.reason}</summary>{version.pages.map((page:DocumentPage)=><pre className={ownedClassName(styles.source,true)} key={page.page}>{page.page}쪽 · {page.extractionMethod||'PDF 문자 추출'}{page.studentReviewed?' · 학생 확인':''}{'\n'}{page.text}</pre>)}</details>)}</details>}
      {detail.history.length>1&&<details className={ownedClassName(styles.card,true)}><summary>분석 이력</summary><ul>{detail.history.map(run=><li key={run.id}>{run.revision}차 · {statuses[run.status]} · {new Date(run.created_at).toLocaleDateString('ko-KR')}</li>)}</ul></details>}
    </>}
  </div>;
}
