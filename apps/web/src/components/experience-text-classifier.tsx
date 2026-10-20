'use client';
import {ownedClassName} from './owned-class-name';

import {useState} from 'react';
import {classifyExperienceText} from '@/lib/armory-recommendations';
import {experienceSteps,type Experience} from '@/lib/armory-model';
import styles from './armory.module.css';
export function ExperienceTextClassifier({onApply}:{onApply:(fields:Partial<Experience>)=>void}){
 const [original,setOriginal]=useState(''),[sections,setSections]=useState<Pick<Experience,'situation'|'action'|'result'>|null>(null);
 return <details className={ownedClassName(styles.pasteTool,true)}><summary className={ownedClassName(undefined,true)}>이미 쓴 글이 있나요? 붙여넣어 나누기</summary><p className={ownedClassName(styles.hint,true)}>원문 속 표현을 상황·내 행동·결과로 나눠요. 문장을 새로 만들지 않으며, 적용 전 직접 수정할 수 있어요.</p><label className={ownedClassName(undefined,true)}>붙여넣은 원문<textarea rows={4} maxLength={6000} value={original} onChange={event=>{setOriginal(event.target.value);setSections(null);}} className={ownedClassName(undefined,true)}/></label><button className={ownedClassName("button ghost",true)} disabled={!original.trim()} onClick={()=>setSections(classifyExperienceText(original))}>내 글에서 상황·행동 나누기</button>{sections&&<><p className={ownedClassName(styles.hint,true)}>단어를 바탕으로 나눈 초안이에요. 맞지 않는 분류는 고쳐주세요. 각 칸은 2,000자까지 담고, 원문 전체는 따로 보관해요.</p>{experienceSteps.map(step=><label key={step.key} className={ownedClassName(undefined,true)}>{step.label}<textarea rows={3} maxLength={2000} value={sections[step.key]} onChange={event=>setSections({...sections,[step.key]:event.target.value})} className={ownedClassName(undefined,true)}/></label>)}<div className={ownedClassName(styles.actions,true)}><button className={ownedClassName("button ghost",true)} onClick={()=>setSections(null)}>분류 취소</button><button className={ownedClassName("button primary",true)} onClick={()=>{onApply({...sections,originalText:original});setSections(null);}}>확인한 분류를 초안에 적용</button></div><p className={ownedClassName(styles.hint,true)}>이 버튼은 초안에만 반영해요. 경험 확인·저장 전까지 원래 카드는 유지돼요.</p></>}</details>;
}
