'use client';
import {ownedClassName} from './owned-class-name';


import {useEffect,useId,useRef,useState} from 'react';
import {Check,ChevronDown} from 'lucide-react';
import styles from './settings-select.module.css';

type Option={value:string;label:string};
export function SettingsSelect({label,value,options,onChange,disabled=false}:{label:string;value:string;options:Option[];onChange:(value:string)=>void;disabled?:boolean}){
 const [open,setOpen]=useState(false);
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const initialFocus=useRef<number|null>(null);
 const id=useId();
 const selected=Math.max(0,options.findIndex(option=>option.value===value));
 useEffect(()=>{
  if(!open)return;
  const buttons=root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
  buttons?.[initialFocus.current??selected]?.focus({preventScroll:true});
  initialFocus.current=null;
  const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
  document.addEventListener('pointerdown',outside);
  return()=>document.removeEventListener('pointerdown',outside);
 },[open,selected]);
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 function close(){setOpen(false);trigger.current?.focus({preventScroll:true});}
 return <div className={ownedClassName(styles.root,true)} ref={root} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}} onKeyDown={event=>{
  if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||disabled)return;
  event.preventDefault();
  if(!open){initialFocus.current=event.key==='Home'?0:event.key==='End'?options.length-1:selected;setOpen(true);return;}
  const buttons=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')||[]);
  const current=buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(current+1)%buttons.length:(current-1+buttons.length)%buttons.length;
  buttons[next]?.focus({preventScroll:true});
 }}>
  <button type="button" className={ownedClassName(styles.trigger,true)} ref={trigger} aria-label={`${label} · ${options[selected]?.label||value}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled} onClick={()=>setOpen(previous=>!previous)}><span className={ownedClassName(undefined,true)}>{options[selected]?.label||value}</span><ChevronDown size={15} aria-hidden="true"/></button>
  {open&&<div className={ownedClassName(styles.menu,true)} id={id} role="listbox" aria-label={label}>{options.map(option=><button type="button" role="option" aria-selected={value===option.value} tabIndex={-1} key={option.value} onClick={()=>{close();if(option.value!==value)onChange(option.value);}} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{option.label}</span>{value===option.value&&<Check size={16} aria-hidden="true"/>}</button>)}</div>}
 </div>;
}
