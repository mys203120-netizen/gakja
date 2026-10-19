'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {api,Alert} from './shared';
import type {ExperienceCard} from '@/lib/armory-model';
import {questionExperienceSuggestions} from '@/lib/armory-recommendations';
import styles from './armory.module.css';
export function QuestionExperiencePicker({question,targetId,value,onSelect}:{question:{id:string;prompt:string};targetId:string;value?:ExperienceCard|null;onSelect:(card:ExperienceCard|null)=>void}){
 const [open,setOpen]=useState(false),[cards,setCards]=useState<ExperienceCard[]>([]),[picked,setPicked]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 useEffect(()=>{setOpen(false);setPicked('');setCards([]);setError('');},[question.id,targetId]);
 useEffect(()=>{if(!open)return;let active=true;setLoading(true);api('/api/armory').then(result=>{if(active)setCards(result.cards||[]);}).catch(reason=>{if(active)setError(reason.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[open,targetId]);
 const suggestions=questionExperienceSuggestions(question.prompt,cards),selection=cards.find(card=>card.id===picked);
 return <section className={styles.experiencePicker} aria-label="질문에 쓸 경험 선택"><button className="button ghost" aria-expanded={open} onClick={()=>{setPicked(value?.id||'');setError('');setOpen(!open);}}>{value?`연결한 경험: ${value.data.title}`:'쓸 경험 고르기'}</button>{open&&<div><p className={styles.hint}>내가 확인한 경험 중 질문의 단어·주제가 겹치는 최대 3개예요. 적합성 평가나 AI 추천이 아니며, 직접 골라 적용해요.</p>{loading?<p role="status">내 경험을 불러오고 있어요.</p>:error?<Alert>{error}</Alert>:<><fieldset className={styles.questionList}><legend className="sr-only">이 질문에 연결할 내 경험</legend>{suggestions.map(({card,reason})=><label key={card.id}><input type="radio" name={'experience-for-'+question.id} value={card.id} checked={picked===card.id} onChange={()=>setPicked(card.id)}/><span><strong>{card.data.title}</strong><small className={styles.matchReason}>{reason}</small><small className={styles.matchReason}>{card.data.action}</small><Link href={'/armory?card='+encodeURIComponent(card.id)}>경험 확인·편집</Link></span></label>)}<label><input type="radio" name={'experience-for-'+question.id} value="" checked={!picked} onChange={()=>setPicked('')}/><span>해당 없음 · 경험 연결 없이 답하기</span></label></fieldset>{!suggestions.length&&<p className={styles.hint}>뚜렷하게 연결되는 경험을 찾지 못했어요. 경험 없이 답하거나 무기고에서 다른 경험을 확인해 주세요.</p>}<div className={styles.actions}><button className="button ghost" onClick={()=>setOpen(false)}>취소</button><button className="button primary" disabled={Boolean(picked&&!selection)} onClick={()=>{onSelect(selection||null);setOpen(false);}}>선택 적용</button></div></>}</div>}</section>;
}
