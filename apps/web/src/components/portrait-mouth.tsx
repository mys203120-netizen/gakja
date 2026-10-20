'use client';
import {useEffect,useRef} from 'react';
import type {InterviewerAvatarFrame,InterviewerAvatarSignal} from '@/lib/client/interviewer-avatar';
import {PORTRAIT_MOUTHS,portraitMouthBounds,PortraitMouthRenderer} from '@/lib/client/portrait-mouth';
import styles from './interviewer-character.module.css';

/** The existing portrait remains the fallback; canvas owns only its measured mouth patch. */
export function PortraitMouth({portraitId,src,personId,signal}:{portraitId:string;src:string;personId:string;signal:InterviewerAvatarSignal}){
  const canvas=useRef<HTMLCanvasElement>(null),mouth=PORTRAIT_MOUTHS[portraitId];
  useEffect(()=>{
    if(!canvas.current||!mouth)return;const node=canvas.current,image=new Image();let disposed=false,renderer:PortraitMouthRenderer|undefined,frame:InterviewerAvatarFrame=signal.snapshot;
    const render=()=>{if(!renderer||disposed)return;try{renderer.frame(frame,personId);}catch{renderer.dispose();renderer=undefined;}};
    const unsubscribe=signal.subscribe(next=>{frame=next;render();});
    image.onload=()=>{if(disposed)return;try{renderer=new PortraitMouthRenderer(node,image,mouth);node.dataset.mouthReady='true';render();}catch{node.hidden=true;}};
    image.onerror=()=>{node.hidden=true;};image.src=src;
    return()=>{disposed=true;unsubscribe();image.onload=null;image.onerror=null;renderer?.dispose();node.hidden=true;delete node.dataset.mouthReady;};
  },[mouth,personId,signal,src]);
  if(!mouth)return null;const bounds=portraitMouthBounds(mouth);
  return <canvas ref={canvas} className={styles.mouth} hidden aria-hidden="true" data-mouth-person={personId} style={{left:`${bounds.x*100}%`,top:`${bounds.y*100}%`,width:`${bounds.width*100}%`,height:`${bounds.height*100}%`}}/>;
}
