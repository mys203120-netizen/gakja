'use client';
import {ownedClassName} from './owned-class-name';

import { useEffect,useId,useRef,useState } from 'react';
import { Check,Ellipsis,Search } from 'lucide-react';
import styles from './school-picker.module.css';
type Choice={id:string;label:string;detail?:string;keywords?:string[]};
export function SchoolPicker({label,choices,value,onChange,placeholder,searchPlaceholder='이름으로 검색',disabled=false}:{label:string;choices:Choice[];value:string;onChange:(id:string)=>void;placeholder:string;searchPlaceholder?:string;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[active,setActive]=useState(0);const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null),id=useId();
  const selected=choices.find(choice=>choice.id===value),query=search.trim().toLocaleLowerCase(),filtered=choices.filter(choice=>(choice.label+' '+(choice.detail||'')+' '+(choice.keywords||[]).join(' ')).toLocaleLowerCase().includes(query));
  useEffect(()=>{if(!open)return;input.current?.focus();const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  useEffect(()=>{setActive(0);},[search]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  function choose(choice:Choice){if(disabled)return;onChange(choice.id);setOpen(false);trigger.current?.focus();}
  return <div className={ownedClassName(`${styles.picker} school-picker`,true)} ref={root} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
    <span id={`${id}-label`} className={ownedClassName(`${styles.label} school-field-label`,true)}>{label}</span>
    <button ref={trigger} type="button" className={ownedClassName(`${styles.trigger} school-picker-trigger`,true)} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={`${id}-label ${id}-value`} disabled={disabled} onClick={()=>{setOpen(!open);setSearch('');setActive(0);}}>
      <span id={`${id}-value`} className={ownedClassName(selected?'':'school-picker-placeholder',true)} title={selected?.label}>{selected?.label||placeholder}</span><Ellipsis size={18} aria-hidden="true"/>
    </button>
    {open&&<div className={ownedClassName(`${styles.popover} school-picker-popover`,true)}>
      <div className={ownedClassName(`${styles.search} school-picker-search`,true)}><Search size={16}/><input ref={input} className={ownedClassName(styles.searchInput,true)} aria-label={`${label} 검색`} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={filtered[active]?`${id}-option-${active}`:undefined} value={search} placeholder={searchPlaceholder} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{
        if(disabled||event.nativeEvent.isComposing||event.keyCode===229)return;
        if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}
        else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const index=Math.max(0,Math.min(filtered.length-1,active+(event.key==='ArrowDown'?1:-1)));setActive(index);root.current?.querySelector(`#${CSS.escape(`${id}-option-${index}`)}`)?.scrollIntoView({block:'nearest'});}
        else if(event.key==='Enter'){event.preventDefault();if(filtered[active])choose(filtered[active]);}
      }}/></div>
      <div className={ownedClassName(`${styles.options} school-picker-options`,true)} role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`}>
        {filtered.map((choice,index)=><button id={`${id}-option-${index}`} key={choice.id} type="button" role="option" aria-selected={choice.id===value} disabled={disabled} className={ownedClassName(`${styles.option}${index===active?' is-active':''}`,true)} onPointerMove={()=>setActive(index)} onClick={()=>choose(choice)}><span className={ownedClassName(styles.optionLabel,true)}><span className={ownedClassName(styles.optionText,true)}>{choice.label}</span>{choice.detail&&<small className={ownedClassName(undefined,true)}>{choice.detail}</small>}{query&&choice.keywords?.some(keyword=>keyword.toLocaleLowerCase().includes(query))&&<small className={ownedClassName(undefined,true)}>{choice.keywords.filter(keyword=>keyword.toLocaleLowerCase().includes(query)).slice(0,2).join(' · ')} · 세부 전공</small>}</span>{choice.id===value&&<Check size={16}/>}</button>)}
        {!filtered.length&&<p className={ownedClassName(`${styles.empty} school-picker-empty`,true)}>검색 결과가 없어요.</p>}
      </div>
    </div>}
  </div>;
}
