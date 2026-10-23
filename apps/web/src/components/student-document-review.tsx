'use client';
import {useState} from 'react';
import {ActionButton} from './shared';
import {ownedClassName as cls} from './owned-class-name';
import type {DocumentPage} from '@/lib/student-document-model';
import styles from './student-document.module.css';

export function StudentDocumentReview({pages,previewId,busy,onSave,onCancel}:{pages:DocumentPage[];previewId?:string;busy:boolean;onSave:(pages:{page:number;text:string;reviewed:boolean;blank:boolean}[],reason:string)=>Promise<void>;onCancel?:()=>void}){
  const [draft,setDraft]=useState(pages.map(p=>({page:p.page,text:p.text,reviewed:false,blank:!!p.blank}))),[index,setIndex]=useState(0),[consent,setConsent]=useState(false),[reason,setReason]=useState('');
  const current=draft[index],source=pages[index],reviewed=draft.filter(p=>p.reviewed).length;
  const change=(patch:Partial<typeof current>)=>setDraft(old=>old.map((p,i)=>i===index?{...p,...patch}:p));
  if(!current)return null;
  return <section className={cls(styles.card,true)}>
    <h2>{previewId?'원본을 보며 인식문을 확인해 주세요.':'원본은 유지하고 인식문만 정정해요.'}</h2>
    <p>표의 순서·활동명·숫자까지 대조해 주세요. OCR 신뢰도는 글자 인식의 참고값이며 문서의 진위나 본인 소유 여부를 인증하지 않아요.</p>
    <div className={cls(styles.reviewNav,true)}><label htmlFor="document-page-select">페이지 <select id="document-page-select" value={index} onChange={e=>setIndex(Number(e.target.value))}>{pages.map((p,i)=><option value={i} key={p.page}>{p.page}쪽 {draft[i].reviewed?'· 확인함':''}</option>)}</select></label><span aria-live="polite">{reviewed}/{pages.length}쪽 확인</span></div>
    <p className={cls(styles.muted,true)}>{source.extractionMethod==='pdf_text'?'PDF 문자 추출':source.extractionMethod==='mixed_ocr'?'문자·이미지 혼합 페이지 · 로컬 OCR':'로컬 OCR'}{typeof source.confidence==='number'?` · 인식 신뢰도 ${Math.round(source.confidence)}%`:''}</p>
    {source.issue&&<p className={cls(styles.reviewWarning,true)} role="note">{source.issue}</p>}
    <div className={cls(styles.reviewGrid,true)}>
      <a href={`/api/student-document?page=${current.page}${previewId?`&preview=${previewId}`:''}`} target="_blank" rel="noreferrer" aria-label={`${current.page}쪽 원본 크게 보기`}><img src={`/api/student-document?page=${current.page}${previewId?`&preview=${previewId}`:''}`} alt={`원본 PDF ${current.page}쪽`} loading="lazy"/><span>원본 크게 보기</span></a>
      <div><label htmlFor="document-page-text">{current.page}쪽 인식문 <textarea id="document-page-text" value={current.text} maxLength={30000} disabled={busy||current.blank} onChange={e=>change({text:e.target.value,reviewed:false})}/></label><label className={cls(styles.consent,true)}><input type="checkbox" checked={current.blank} disabled={busy} onChange={e=>change({blank:e.target.checked,text:e.target.checked?'':source.text,reviewed:false})}/><span>원본에 분석할 글자가 없는 페이지예요.</span></label><label className={cls(styles.consent,true)}><input type="checkbox" checked={current.reviewed} disabled={busy||(!current.blank&&current.text.replace(/\s/g,'').length<15)} onChange={e=>change({reviewed:e.target.checked})}/><span>이 페이지를 원본과 비교했고 필요한 글자를 정정했어요.</span></label></div>
    </div>
    <div className={cls(styles.actions,true)}><button className={cls('button')} disabled={index===0||busy} onClick={()=>setIndex(i=>i-1)}>이전 페이지</button><button className={cls('button')} disabled={index===pages.length-1||busy} onClick={()=>setIndex(i=>i+1)}>다음 페이지</button></div>
    {previewId?<label className={cls(styles.consent,true)}><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/><span>확인한 본인의 전체 PDF 한 개를 계정에 고정하고 비공개 저장하는 것에 동의해요. 자동 분석이 연결되면 확인한 인식문이 OpenAI로 전달되며 결과는 AI의 제안임을 확인했어요.</span></label>:<label className={cls(styles.reason,true)}>정정 이유<input value={reason} maxLength={500} disabled={busy} onChange={e=>setReason(e.target.value)} placeholder="예: 2쪽 활동명 인식 오류 정정"/></label>}
    <div className={cls(styles.actions,true)}><ActionButton className={cls('button primary')} pending={busy} disabled={reviewed!==pages.length||(previewId?!consent:!reason.trim())} onClick={()=>onSave(draft,reason)}>{previewId?'이 원본으로 확정하고 분석':'정정문을 새 버전으로 저장'}</ActionButton>{onCancel&&<button className={cls('button')} disabled={busy} onClick={onCancel}>취소</button>}</div>
    <p className={cls(styles.muted,true)}>{previewId?'확정 전 파일은 24시간 후 만료되며 다음 정리 작업에서 삭제돼요. 이 화면에서 작성 중인 정정문은 확정할 때 저장되며, 새로고침하면 미저장 내용은 사라져요.':'저장 후 새 인식문으로 다시 분석해 주세요. 이전 분석과 훈련 기록은 당시 텍스트 버전에 연결돼요.'}</p>
  </section>;
}
