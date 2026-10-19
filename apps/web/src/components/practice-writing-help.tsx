'use client';
import {useEffect,useId,useState} from 'react';
import {ANSWER_DIRECTIONS,appendStudentSentence,speakingSuggestions,isSafeSpeakingSuggestion,speakingToneChanges} from '@/lib/practice-writing';
import styles from './practice-writing-help.module.css';

type Props={value:string;maxLength:number;rawTranscript?:string;draftKey?:string;disabled?:boolean;onApply:(text:string)=>void;onAssisted:()=>Promise<void>;evidence?:string[]};
export function PracticeWritingHelp({value,maxLength,rawTranscript,draftKey,disabled,onApply,onAssisted,evidence=[]}:Props){
  const id=useId();
  const [mode,setMode]=useState<'direction'|'speaking'|null>(null),[baseline,setBaseline]=useState(''),[choice,setChoice]=useState(''),[sentence,setSentence]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function open(next:'direction'|'speaking'){
    setBusy(true);setError('');try{await onAssisted();setBaseline(value);setChoice('');setSentence('');setConfirmed(false);setMode(next);}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  const [previous,setPrevious]=useState<{before:string;after:string}|null>(null);
  useEffect(()=>{if(!draftKey)return;try{const saved=JSON.parse(localStorage.getItem(draftKey)||'null');if(typeof saved?.before==='string'&&typeof saved?.after==='string')setPrevious(saved);}catch{/* Saving a proposal still checks storage before replacing an edited draft. */}},[draftKey]);
  const variants=speakingSuggestions(baseline),selected=variants.find(option=>option.id===choice);
  const proposed=mode==='speaking'?selected?.text||'':appendStudentSentence(baseline,sentence);
  const overLimit=proposed.length>maxLength;
  const limitMessage=`적용할 글이 ${proposed.length.toLocaleString('ko-KR')}자예요. 답변은 ${maxLength.toLocaleString('ko-KR')}자까지 저장할 수 있어요. ${Math.max(0,proposed.length-maxLength).toLocaleString('ko-KR')}자를 줄여 주세요. 원문은 그대로 보관해요.`;
  function apply(){if(value!==baseline){setError('작성한 글이 바뀌었어요. 닫고 최신 글에서 다시 열어 주세요.');return;}if(overLimit){setError(limitMessage);return;}if(mode==='speaking'&&!isSafeSpeakingSuggestion(baseline,proposed)){setError('허용한 어미·줄바꿈 이외의 변경이 있어 적용하지 않았어요.');return;}const snapshot={before:baseline,after:proposed};try{if(draftKey)localStorage.setItem(draftKey,JSON.stringify(snapshot));}catch{setError('기존 수정본을 보관하지 못해 적용하지 않았어요. 저장 공간을 확인해 주세요.');return;}setPrevious(snapshot);onApply(proposed);setMode(null);}
  return <div className={styles.help}>
    <div className={styles.actions}><button type="button" className="button ghost small" disabled={disabled||busy} onClick={()=>void open('direction')}>답변이 막혀요</button>{(rawTranscript||value.trim())&&<button type="button" className="button ghost small" disabled={disabled||busy} onClick={()=>void open('speaking')}>말하기 좋게 다듬기</button>}</div>
    {error&&<p role="alert">{error}</p>}
    {previous&&value===previous.after&&<button type="button" className="text-link" disabled={disabled} onClick={()=>{onApply(previous.before);setPrevious(null);}}>적용 전 초안으로 되돌리기</button>}
    {mode&&<section className={styles.panel} aria-label={mode==='direction'?'답변 방향 고르기':'원문과 연습용 글 비교'}>
      <h3>{mode==='direction'?'무엇을 더 말할까요?':'내 사실을 유지하며 말투 다듬기'}</h3>
      <p>이 도움은 보조받은 연습으로 기록해요. 적용해도 새 답변을 완료하거나 원음·원전사를 바꾸지 않아요.</p>
      {mode==='direction'?<>
        {evidence.length>0&&<details><summary>연결한 내 자료 확인</summary>{evidence.map((text,index)=><p key={index}>{text}</p>)}</details>}
        <fieldset><legend>답변 방향 3개 중 선택</legend>{ANSWER_DIRECTIONS.map(option=><label key={option.id}><input type="radio" name={id} checked={choice===option.id} onChange={()=>{setChoice(option.id);setConfirmed(false);}}/>{option.label}<small>{option.prompt}</small></label>)}<label><input type="radio" name={id} checked={choice==='none'} onChange={()=>{setChoice('none');setConfirmed(false);}}/>해당 없음 · 직접 쓰기</label></fieldset>
        {choice&&<label htmlFor={id+'-sentence'}>내가 실제로 한 행동이나 생각 한 문장<textarea id={id+'-sentence'} value={sentence} maxLength={2000} onChange={event=>{setSentence(event.target.value);setConfirmed(false);}}/></label>}
        <p>질문 방향을 고르는 작성 도우미예요. AI가 새 사실이나 완성 답안을 생성하지 않아요.</p>
      </>:<><p>정해진 규칙으로 문장 끝의 존댓말과 호흡을 제안해요. 내용·수치·부정·불확실한 표현은 유지해요.</p><fieldset><legend>연습할 말투 선택</legend>{variants.map(option=><label key={option.id}><input type="radio" name={id} checked={choice===option.id} onChange={()=>{setChoice(option.id);setConfirmed(false);}}/>{option.label}</label>)}</fieldset>{choice.startsWith('polite')&&<div><h4>바뀌는 어미</h4>{speakingToneChanges(baseline).length?speakingToneChanges(baseline).map((change,index)=><p key={index}><del>{change.before}</del> → <ins>{change.after}</ins></p>):<p>이미 면접에서 사용할 수 있는 어미예요. 표현은 유지해요.</p>}</div>}</>}
      {rawTranscript&&<details><summary>보존된 원전사 보기</summary><p>{rawTranscript}</p></details>}
      {proposed&&choice&&<div className={styles.comparison}><div><h4>현재 작성한 원문·수정본</h4><p>{baseline||'아직 작성한 글이 없어요.'}</p></div><div><h4>적용 전 연습용 초안</h4><p>{proposed}</p></div></div>}
      {proposed&&choice&&<p id={id+'-length'} className={overLimit?styles.limitError:styles.length} role={overLimit?'alert':'status'}>{overLimit?limitMessage:`적용할 글 ${proposed.length.toLocaleString('ko-KR')} / ${maxLength.toLocaleString('ko-KR')}자`}</p>}
      <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>내가 한 일·수치·의미가 맞는지 확인했어요.</label>
      <div className={styles.actions}><button type="button" className="button ghost" onClick={()=>setMode(null)}>취소 · 원문 유지</button><button type="button" className="button primary" aria-describedby={proposed&&choice?id+'-length':undefined} disabled={!confirmed||!choice||!proposed.trim()||mode==='direction'&&!sentence.trim()||overLimit} onClick={apply}>내 연습용 초안에 적용</button></div>
    </section>}
  </div>;
}
