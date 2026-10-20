'use client';
import {useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check} from 'lucide-react';
import styles from './floating-notice.module.css';

/** A transient receipt never takes space from the current task. */
export function FloatingNotice({children,duration=3600,onDismiss}:{children:string;duration?:number;onDismiss?:()=>void}) {
  const [mounted,setMounted]=useState(false),[visible,setVisible]=useState(true),[finished,setFinished]=useState(false);
  useEffect(()=>{setMounted(true);},[]);
  useEffect(()=>{
    setVisible(true);setFinished(false);
    const fade=setTimeout(()=>setVisible(false),duration);
    const remove=setTimeout(()=>{setFinished(true);onDismiss?.();},duration+360);
    return()=>{clearTimeout(fade);clearTimeout(remove);};
  },[children,duration]);
  if(!mounted||finished)return null;
  return createPortal(<div className={styles.notice} data-visible={visible} role="status" aria-live="polite" aria-atomic="true"><Check size={17} aria-hidden="true"/><span>{children}</span></div>,document.body);
}
