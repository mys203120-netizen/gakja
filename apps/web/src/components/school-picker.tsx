'use client';
import { useEffect,useId,useRef,useState } from 'react';
import { Check,Ellipsis,Search } from 'lucide-react';
import styles from './school-picker.module.css';
type Choice={id:string;label:string;detail?:string;keywords?:string[]};
export function SchoolPicker({label,choices,value,onChange,placeholder,searchPlaceholder='이름으로 검색',disabled=false}:{label:string;choices:Choice[];value:string;onChange:(id:string)=>void;placeholder:string;searchPlaceholder?:string;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[active,setActive]=useState(0);const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null),id=useId();
  const selected=choices.find(choice=>choice.id===value),query=search.trim().toLocaleLowerCase(),filtered=choices.filter(choice=>(choice.label+' '+(choice.detail||'')+' '+(choice.keywords||[]).join(' ')).toLocaleLowerCase().includes(query));
  useEffect(()=>{if(!open)return;input.current?.focus();const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  useEffect(()=>{setActive(0);},[search]);
  function choose(choice:Choice){onChange(choice.id);setOpen(false);trigger.current?.focus();}
  return <div className={`${styles.picker} school-picker`} ref={root} onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
    <span id={`${id}-label`} className={`${styles.label} school-field-label`}>{label}</span>
    <button ref={trigger} type="button" className={`${styles.trigger} school-picker-trigger`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-labelledby={`${id}-label ${id}-value`} disabled={disabled} onClick={()=>{setOpen(!open);setSearch('');setActive(0);}}>
      <span id={`${id}-value`} className={selected?'':'school-picker-placeholder'} title={selected?.label}>{selected?.label||placeholder}</span><Ellipsis size={18} aria-hidden="true"/>
    </button>
    {open&&<div className={`${styles.popover} school-picker-popover`}>
      <div className={`${styles.search} school-picker-search`}><Search size={16}/><input ref={input} className={styles.searchInput} aria-label={`${label} 검색`} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={filtered[active]?`${id}-option-${active}`:undefined} value={search} placeholder={searchPlaceholder} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}
        else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const index=Math.max(0,Math.min(filtered.length-1,active+(event.key==='ArrowDown'?1:-1)));setActive(index);root.current?.querySelector(`#${CSS.escape(`${id}-option-${index}`)}`)?.scrollIntoView({block:'nearest'});}
        else if(event.key==='Enter'){event.preventDefault();if(filtered[active])choose(filtered[active]);}
      }}/></div>
      <div className={`${styles.options} school-picker-options`} role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`}>
        {filtered.map((choice,index)=><button id={`${id}-option-${index}`} key={choice.id} type="button" role="option" aria-selected={choice.id===value} className={`${styles.option}${index===active?' is-active':''}`} onPointerMove={()=>setActive(index)} onClick={()=>choose(choice)}><span className={styles.optionLabel}><span className={styles.optionText}>{choice.label}</span>{choice.detail&&<small>{choice.detail}</small>}{query&&choice.keywords?.some(keyword=>keyword.toLocaleLowerCase().includes(query))&&<small>{choice.keywords.filter(keyword=>keyword.toLocaleLowerCase().includes(query)).slice(0,2).join(' · ')} · 세부 전공</small>}</span>{choice.id===value&&<Check size={16}/>}</button>)}
        {!filtered.length&&<p className={`${styles.empty} school-picker-empty`}>검색 결과가 없어요.</p>}
      </div>
    </div>}
  </div>;
}
