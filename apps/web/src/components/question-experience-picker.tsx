'use client';
import {ownedClassName} from './owned-class-name';

import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {ChevronDown} from 'lucide-react';
import {api,Alert} from './shared';
import type {ExperienceCard} from '@/lib/armory-model';
import {questionExperienceSuggestions} from '@/lib/armory-recommendations';
import styles from './question-experience-picker.module.css';
export function QuestionExperiencePicker({question,targetId,value,onSelect,children,secondaryAction,disabled=false}:{question:{id:string;prompt:string};targetId:string;value?:ExperienceCard|null;onSelect:(card:ExperienceCard|null)=>void;children?:ReactNode;secondaryAction?:ReactNode;disabled?:boolean}){
 const [open,setOpen]=useState(false),[cards,setCards]=useState<ExperienceCard[]>([]),[picked,setPicked]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const panelId=useId(),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{setOpen(false);setPicked('');setCards([]);setError('');},[question.id,targetId]);
 useEffect(()=>{if(!open)return;let active=true;setLoading(true);api('/api/armory').then(result=>{if(active)setCards(result.cards||[]);}).catch(reason=>{if(active)setError(reason.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[open,targetId]);
 const suggestions=questionExperienceSuggestions(question.prompt,cards),selection=cards.find(card=>card.id===picked);
 function close(){setOpen(false);trigger.current?.focus();}
 return <section className={ownedClassName(styles.experiencePicker,true)} aria-label={children?'훈련 시작과 경험 선택':'질문에 쓸 경험 선택'} onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();close();}}}>
  <div className={ownedClassName(styles.toolbar,true)}>
   {children}
   <button ref={trigger} type="button" className={ownedClassName(styles.trigger,true)} disabled={disabled} aria-expanded={open} aria-controls={panelId} onClick={()=>{setPicked(value?.id||'');setError('');setOpen(!open);}}><span className={ownedClassName(undefined,true)}>{value?`연결한 경험: ${value.data.title}`:'경험 선택'}</span><ChevronDown size={16} aria-hidden="true"/></button>
   {secondaryAction}
  </div>
  {open&&<div id={panelId} className={ownedClassName(styles.panel,true)}>
   <p className={ownedClassName(styles.hint,true)}>질문과 단어·주제가 겹치는 경험을 최대 3개 보여 드려요. 답변에 쓸 경험을 골라 주세요.</p>
   {loading?<p role="status" className={ownedClassName(styles.hint,true)}>내 경험을 불러오고 있어요.</p>:error?<Alert>{error}</Alert>:<>
    <fieldset className={ownedClassName(styles.choices,true)} disabled={disabled}><legend className={ownedClassName('sr-only',true)}>이 질문에 연결할 내 경험</legend>
     {suggestions.map(({card,reason})=><label key={card.id} className={ownedClassName(styles.choice,true)}><input type="radio" name={'experience-for-'+question.id} value={card.id} checked={picked===card.id} onChange={()=>setPicked(card.id)} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{card.data.title}</strong><small className={ownedClassName(styles.matchReason,true)}>{reason}</small><small className={ownedClassName(styles.matchReason,true)}>{card.data.action}</small><Link className={ownedClassName(styles.detailLink)} href={'/armory?card='+encodeURIComponent(card.id)}>경험 확인·편집</Link></span></label>)}
     <label className={ownedClassName(styles.choice,true)}><input type="radio" name={'experience-for-'+question.id} value="" checked={!picked} onChange={()=>setPicked('')} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}>경험 연결 없이 답하기</span></label>
    </fieldset>
    {!suggestions.length&&<p className={ownedClassName(styles.hint,true)}>연결되는 경험을 찾지 못했어요. 경험 없이 답하거나 내 경험에서 다른 경험을 확인해 주세요.</p>}
    <div className={ownedClassName(styles.panelActions,true)}><button type="button" className={ownedClassName('button ghost',true)} onClick={close}>취소</button><button type="button" className={ownedClassName('button primary',true)} disabled={disabled||Boolean(picked&&!selection)} onClick={()=>{onSelect(selection||null);close();}}>선택 적용</button></div>
   </>}
  </div>}
 </section>;
}
