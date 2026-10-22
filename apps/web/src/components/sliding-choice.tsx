'use client';

import type {ReactNode} from 'react';
import {ownedClassName} from './owned-class-name';
import styles from './sliding-choice.module.css';

type Choice<T extends string>={value:T;label:ReactNode};
/** The reference's moving surface, with separate, keyboard-operable choices. */
export function SlidingChoice<T extends string>({label,value,options,onChange,disabled=false}:{label:string;value:T;options:readonly [Choice<T>,Choice<T>];onChange:(value:T)=>void;disabled?:boolean}){
  return <div className={ownedClassName(styles.choices,true)} role="group" aria-label={label} data-right={value===options[1].value}>
    <span className={ownedClassName(styles.slider,true)} aria-hidden="true"/>
    {options.map((option,index)=><button key={option.value} type="button" aria-pressed={value===option.value} disabled={disabled} className={ownedClassName(styles.choice,true)} onClick={()=>onChange(option.value)} onKeyDown={event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;
      onChange(options[next].value);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    }}>{option.label}</button>)}
  </div>;
}

export function MotionSwitch({label,checked,disabled=false,onChange}:{label:string;checked:boolean;disabled?:boolean;onChange:(checked:boolean)=>void}){
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={()=>onChange(!checked)} className={ownedClassName(styles.switch,true)} data-right={checked}>
    <span className={ownedClassName(styles.slider,true)} aria-hidden="true"/>
    <span aria-hidden="true" className={ownedClassName(styles.switchLabel,true)}>끔</span><span aria-hidden="true" className={ownedClassName(styles.switchLabel,true)}>켬</span>
  </button>;
}
