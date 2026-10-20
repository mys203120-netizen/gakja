'use client';
import {ownedClassName} from './owned-class-name';

import {useEffect,useRef} from 'react';
import type {InterviewerAvatarSignal} from '@/lib/client/interviewer-avatar';
import {PORTRAIT_EYES,portraitExpressionFrame} from '@/lib/client/portrait-expression';
import styles from './interviewer-character.module.css';

export function PortraitExpression({portraitId,src,personId,signal}:{portraitId:string;src:string;personId:string;signal:InterviewerAvatarSignal}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const node=canvas.current,eyes=PORTRAIT_EYES[portraitId];if(!node||!eyes)return;
    const context=node.getContext('2d'),image=new Image();if(!context)return;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');let disposed=false,raf=0,started=0,loaded=false;
    let state=signal.snapshot.state;const seed=Array.from(personId).reduce((sum,c)=>sum+c.charCodeAt(0),0),parent=node.parentElement;
    const unsubscribe=signal.subscribe(next=>{state=next.speakerId===personId?next.state:next.state==='listening'?'listening':'idle';if(loaded&&!raf&&!disposed)raf=requestAnimationFrame(tick);});
    const tick=(now:number)=>{
      if(disposed)return;if(!started)started=now;
      const motion=portraitExpressionFrame(state,now-started,seed,reduced.matches);
      parent?.style.setProperty('--portrait-tilt',`${motion.tilt.toFixed(3)}deg`);parent?.style.setProperty('--portrait-y',`${motion.y.toFixed(3)}px`);
      node.dataset.expressionState=state;node.dataset.blink=motion.blink.toFixed(2);context.clearRect(0,0,640,640);
      node.hidden=motion.blink<.025&&Math.abs(motion.gaze)<.2;
      if(!node.hidden)for(const [cx,cy,rx,ry] of eyes){
        const scale=640/1254,x=cx*scale,y=cy*scale,w=rx*scale,h=ry*scale;
        // Original eye pixels remain the source. Gaze is clipped inside the eye; lids cover only its ellipse.
        context.save();context.beginPath();context.ellipse(x,y,w,h,0,0,Math.PI*2);context.clip();
        context.drawImage(image,(cx-rx-motion.gaze)*image.naturalWidth/1254,(cy-ry)*image.naturalHeight/1254,rx*2*image.naturalWidth/1254,ry*2*image.naturalHeight/1254,x-w,y-h,w*2,h*2);
        if(motion.blink>.025){
          const covered=h*2*motion.blink;
          context.drawImage(image,(cx-rx)*image.naturalWidth/1254,(cy-ry-12)*image.naturalHeight/1254,rx*2*image.naturalWidth/1254,10*image.naturalHeight/1254,x-w,y-h,w*2,covered);
          context.globalAlpha=motion.blink*.65;context.strokeStyle='#77584e';context.lineWidth=.65;context.beginPath();context.ellipse(x,y-h+covered,w*.94,1.2,0,.05,Math.PI-.05);context.stroke();
        }
        context.restore();
      }
      raf=state!=='idle'&&!reduced.matches?requestAnimationFrame(tick):0;
    };
    const motionChanged=()=>{if(loaded&&!raf&&!disposed)raf=requestAnimationFrame(tick);};reduced.addEventListener('change',motionChanged);
    image.onload=()=>{loaded=true;if(!disposed)raf=requestAnimationFrame(tick);};image.onerror=()=>{node.hidden=true;};image.src=src;
    return()=>{disposed=true;unsubscribe();cancelAnimationFrame(raf);reduced.removeEventListener('change',motionChanged);image.onload=null;image.onerror=null;parent?.style.removeProperty('--portrait-tilt');parent?.style.removeProperty('--portrait-y');};
  },[portraitId,src,personId,signal]);
  return <canvas ref={canvas} className={ownedClassName(styles.expression,true)} width={640} height={640} hidden aria-hidden="true"/>;
}
