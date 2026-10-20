'use client';

import {useEffect,useRef} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {swipeDestination} from '@/lib/mobile-tab-swipe';

/** Touch gestures stay outside controls, horizontal lists, and browser back edges. */
export function MobileTabSwipe({enabled}:{enabled:boolean}) {
  const path=usePathname(),router=useRouter(),enter=useRef<'left'|'right'|null>(null);
  useEffect(()=>{
    const main=document.getElementById('main-content');
    if(!main||!enabled||!['/my','/preparation','/records'].includes(path))return;
    let gesture:{id:number;x:number;y:number;time:number;axis:'x'|'y'|null}|null=null,timer:number|undefined;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const entering=enter.current;enter.current=null;
    if(entering&&!reduced.matches){main.dataset.tabTransition=entering;timer=window.setTimeout(()=>delete main.dataset.tabTransition,220);}
    function clear(){gesture=null;main!.style.removeProperty('--tab-drag');delete main!.dataset.tabDragging;}
    function start(event:PointerEvent){
      if(event.pointerType!=='touch'||!event.isPrimary||window.innerWidth>700||document.querySelector('dialog[open]')||document.getSelection()?.isCollapsed===false)return;
      const target=event.target instanceof Element?event.target:null;
      if(!target||target.closest('a,button,input,textarea,select,summary,[contenteditable],audio,video,[role="tablist"],[data-no-tab-swipe]')||event.clientX<28||event.clientX>window.innerWidth-28)return;
      for(let node:Element|null=target;node&&node!==main;node=node.parentElement){if(node.scrollWidth>node.clientWidth+2&&/auto|scroll/.test(getComputedStyle(node).overflowX))return;}
      gesture={id:event.pointerId,x:event.clientX,y:event.clientY,time:performance.now(),axis:null};
    }
    function track(x:number,y:number){
      if(!gesture)return false;
      const dx=x-gesture.x,dy=y-gesture.y;
      if(!gesture.axis&&Math.max(Math.abs(dx),Math.abs(dy))>12)gesture.axis=Math.abs(dx)>Math.abs(dy)*1.6?'x':'y';
      if(gesture.axis==='y'){clear();return false;}
      if(gesture.axis==='x'&&!reduced.matches){main!.dataset.tabDragging='true';main!.style.setProperty('--tab-drag',`${Math.max(-24,Math.min(24,dx*.12))}px`);}
      return gesture.axis==='x';
    }
    function move(event:PointerEvent){
      if(!gesture||event.pointerId!==gesture.id)return;
      track(event.clientX,event.clientY);
    }
    function touchMove(event:TouchEvent){
      if(!gesture)return;
      if(event.touches.length!==1||document.getSelection()?.isCollapsed===false){clear();return;}
      const point=event.touches[0];
      // Cancel only an accepted tab gesture. Horizontal lists and controls never
      // start one, so their native panning and text selection remain available.
      if(track(point.clientX,point.clientY)&&event.cancelable)event.preventDefault();
    }
    function finish(event:PointerEvent){
      if(!gesture||gesture.id!==event.pointerId)return;
      const dx=event.clientX-gesture.x,href=swipeDestination(path,dx,event.clientY-gesture.y,performance.now()-gesture.time);
      clear();
      if(href){enter.current=dx<0?'left':'right';router.push(href);}
    }
    main.addEventListener('pointerdown',start,{passive:true});main.addEventListener('pointermove',move,{passive:true});main.addEventListener('pointerup',finish,{passive:true});main.addEventListener('pointercancel',clear,{passive:true});main.addEventListener('touchmove',touchMove,{passive:false});
    main.dataset.tabSwipe='true';
    return()=>{main.removeEventListener('pointerdown',start);main.removeEventListener('pointermove',move);main.removeEventListener('pointerup',finish);main.removeEventListener('pointercancel',clear);main.removeEventListener('touchmove',touchMove);if(timer)clearTimeout(timer);clear();delete main.dataset.tabSwipe;delete main.dataset.tabTransition;};
  },[enabled,path,router]);
  return null;
}
