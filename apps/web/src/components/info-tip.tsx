'use client';
import {ownedClassName} from './owned-class-name';


import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Info} from 'lucide-react';
import {useHelpEnabled} from './help-preferences';
import styles from './tooltip.module.css';

/** Optional context stays available by pointer, keyboard, and touch. */
export function InfoTip({label,children}:{label:string;children:ReactNode}) {
  const enabled=useHelpEnabled();
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const pinned=useRef(false),closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [open,setOpen]=useState(false),[position,setPosition]=useState<{top:number;left:number}|null>(null);
  const cancelClose=useCallback(()=>{if(closeTimer.current!==null){clearTimeout(closeTimer.current);closeTimer.current=null;}},[]);
  const close=useCallback(()=>{cancelClose();pinned.current=false;setOpen(false);setPosition(null);},[cancelClose]);
  const show=()=>{cancelClose();setOpen(true);};
  const leave=()=>{cancelClose();if(pinned.current)return;closeTimer.current=setTimeout(()=>{if(document.activeElement!==trigger.current)close();},150);};
  useEffect(()=>()=>cancelClose(),[cancelClose]);
  useEffect(()=>{if(!enabled)close();},[enabled,close]);
  useEffect(()=>{
    if(!open||!enabled)return;
    const place=()=>{
      const anchor=trigger.current?.getBoundingClientRect(),surface=panel.current?.getBoundingClientRect();
      if(!anchor||!surface)return;
      const gutter=16,left=Math.max(gutter,Math.min(anchor.left+anchor.width/2-surface.width/2,window.innerWidth-surface.width-gutter));
      const below=anchor.bottom+8,top=below+surface.height<=window.innerHeight-gutter?below:Math.max(gutter,anchor.top-surface.height-8);
      setPosition(previous=>previous?.top===top&&previous.left===left?previous:{top,left});
    };
    const outside=(event:Event)=>{const node=event.target as Node|null;if(node&&!trigger.current?.contains(node)&&!panel.current?.contains(node))close();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside,true);document.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside,true);document.removeEventListener('keydown',key,true);};
  },[open,enabled,children,close]);
  if(!enabled)return null;
  return <span className={ownedClassName(styles.tip,true)}>
    <button ref={trigger} type="button" className={ownedClassName(styles.trigger,true)} aria-label={label} aria-expanded={open} aria-controls={open?id:undefined} aria-describedby={open?id:undefined}
      onPointerEnter={event=>{if(event.pointerType!=='touch')show();}} onPointerLeave={leave} onFocus={show} onBlur={event=>{if(event.relatedTarget&&!panel.current?.contains(event.relatedTarget as Node))close();}}
      onClick={()=>{cancelClose();pinned.current=!pinned.current;if(pinned.current)setOpen(true);else close();}}><Info size={17} aria-hidden="true"/></button>
    {open&&createPortal(<div ref={panel} id={id} role="tooltip" className={ownedClassName(styles.panel,true)} style={{top:position?.top??0,left:position?.left??0,visibility:position?'visible':'hidden'}}
      onPointerEnter={cancelClose} onPointerLeave={leave}>{children}</div>,trigger.current?.closest('dialog')||document.body)}
  </span>;
}
