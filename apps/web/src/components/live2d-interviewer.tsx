'use client';
import {ownedClassName} from './owned-class-name';

import {useEffect,useRef,useState} from 'react';
import {Live2DController,loadLive2DRuntime} from '@/lib/client/live2d-controller';
import type {InterviewerAvatarSignal,InterviewerAvatarFrame} from '@/lib/client/interviewer-avatar';
import styles from './interviewer-character.module.css';

const modelPaths=[process.env.NEXT_PUBLIC_LIVE2D_MODEL_A,process.env.NEXT_PUBLIC_LIVE2D_MODEL_B,process.env.NEXT_PUBLIC_LIVE2D_MODEL_C,process.env.NEXT_PUBLIC_LIVE2D_MODEL_D,process.env.NEXT_PUBLIC_LIVE2D_MODEL_E];
export function Live2DInterviewer({index,personId,signal}:{index:number;personId:string;signal?:InterviewerAvatarSignal}){
  const canvas=useRef<HTMLCanvasElement>(null),[ready,setReady]=useState(false);const modelUrl=modelPaths[index],runtimeUrl=process.env.NEXT_PUBLIC_LIVE2D_RUNTIME_URL;
  useEffect(()=>{
    if(process.env.NEXT_PUBLIC_LIVE2D_ENABLED!=='true'||!modelUrl||!runtimeUrl||!canvas.current||!signal)return;
    if(!modelUrl.startsWith('/')||modelUrl.startsWith('//')||!modelUrl.endsWith('.model3.json'))return;
    const abort=new AbortController();let controller:Live2DController|undefined,frame=0,last=0,disposed=false;
    let state:InterviewerAvatarFrame={state:'idle',speakerId:personId,mouthOpen:0};
    const unsubscribe=signal.subscribe(next=>{state=next.speakerId===personId?next:{state:next.state==='listening'?'listening':'idle',speakerId:personId,mouthOpen:0};});
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const tick=(now:number)=>{if(disposed||!controller)return;try{controller.frame(state,last?(now-last)/1000:0,reduced.matches);last=now;frame=requestAnimationFrame(tick);}catch{setReady(false);controller.dispose();controller=undefined;}};
    void loadLive2DRuntime(runtimeUrl).then(runtime=>runtime.mount(canvas.current!,modelUrl,abort.signal)).then(model=>{
      if(disposed){model.destroy();return;}
      try{controller=new Live2DController(model);setReady(true);frame=requestAnimationFrame(tick);}catch{model.destroy();setReady(false);}
    }).catch(()=>{if(!disposed)setReady(false);});
    const lost=(event:Event)=>{event.preventDefault();setReady(false);if(frame)cancelAnimationFrame(frame);controller?.dispose();controller=undefined;};
    const node=canvas.current;node.addEventListener('webglcontextlost',lost);
    return()=>{disposed=true;abort.abort();unsubscribe();if(frame)cancelAnimationFrame(frame);node.removeEventListener('webglcontextlost',lost);controller?.dispose();};
  },[index,personId,signal,modelUrl,runtimeUrl]);
  return <canvas ref={canvas} className={ownedClassName(styles.live2d,true)} width={640} height={640} data-live2d-ready={ready||undefined} aria-hidden="true"/>;
}
