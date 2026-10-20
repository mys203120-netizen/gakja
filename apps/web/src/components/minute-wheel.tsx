'use client';

import {useEffect,useRef,type KeyboardEvent} from 'react';
import {MINUTE_WHEEL_MAX,MINUTE_WHEEL_ROW_HEIGHT,minuteWheelIndex,minuteWheelKey,minuteWheelLabel,minuteWheelOptions} from '@/lib/minute-wheel';
import styles from './minute-wheel.module.css';

type Props={label:string;value:number;onChange:(value:number)=>void;disabled?:boolean};

/** Native vertical scrolling supplies touch momentum and snapping; no document-wide drag handler is used. */
export function MinuteWheel({label,value,onChange,disabled=false}:Props){
  const scroller=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const disabledNow=useRef(disabled);disabledNow.current=disabled;
  const exactValues=useRef<number[]>([value]),scrolling=useRef(false),baseline=useRef(value),lastEmitted=useRef(value),programmaticTarget=useRef<number|null>(null);
  if(value%5!==0&&!exactValues.current.includes(value))exactValues.current.push(value);
  const options=minuteWheelOptions(exactValues.current),optionSignature=options.join(',');
  const cancelTimer=()=>{if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}};
  function position(next:number,smooth=false){
    const node=scroller.current;if(!node)return;
    const top=Math.max(0,options.indexOf(next))*MINUTE_WHEEL_ROW_HEIGHT;
    programmaticTarget.current=top;
    node.scrollTo({top,behavior:smooth&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'auto'});
  }
  useEffect(()=>{
    if(scrolling.current&&value===lastEmitted.current)return;
    cancelTimer();scrolling.current=false;baseline.current=value;lastEmitted.current=value;position(value);
  },[value,optionSignature]);
  useEffect(()=>()=>cancelTimer(),[]);
  useEffect(()=>{if(disabled){cancelTimer();scrolling.current=false;}},[disabled]);
  function startScroll(){
    if(disabled)return;
    if(!scrolling.current)baseline.current=value;
    programmaticTarget.current=null;
  }
  function emit(next:number){if(next!==lastEmitted.current){lastEmitted.current=next;onChange(next);}}
  function settle(){
    cancelTimer();const node=scroller.current;if(!node||disabledNow.current)return;
    const next=options[minuteWheelIndex(node.scrollTop,options.length)];
    emit(next);scrolling.current=false;baseline.current=next;position(next,true);
  }
  function handleScroll(){
    const node=scroller.current;if(!node||disabled)return;
    if(programmaticTarget.current!==null){
      if(Math.abs(node.scrollTop-programmaticTarget.current)<1)programmaticTarget.current=null;
      return;
    }
    if(!scrolling.current)baseline.current=value;
    scrolling.current=true;
    // Keep the proposed form value current, including when Save is tapped before momentum finishes.
    emit(options[minuteWheelIndex(node.scrollTop,options.length)]);
    cancelTimer();timer.current=setTimeout(settle,160);
  }
  function keyDown(event:KeyboardEvent<HTMLDivElement>){
    if(disabled)return;
    if(event.key==='Escape'){
      if(!scrolling.current)return;
      event.preventDefault();cancelTimer();const original=baseline.current;scrolling.current=false;emit(original);position(original);return;
    }
    const next=minuteWheelKey(value,event.key,options);if(next===null)return;
    event.preventDefault();cancelTimer();scrolling.current=false;baseline.current=next;emit(next);position(next,true);
  }
  return <div className={styles.wheel} data-minute-wheel data-no-tab-swipe data-disabled={disabled||undefined}>
    <span className={styles.selection} aria-hidden="true"/>
    <div ref={scroller} className={styles.scroller} role="spinbutton" tabIndex={disabled?-1:0} aria-label={label} aria-valuemin={0} aria-valuemax={MINUTE_WHEEL_MAX} aria-valuenow={value} aria-valuetext={minuteWheelLabel(value)} aria-disabled={disabled||undefined}
      onKeyDown={keyDown} onPointerDown={startScroll} onWheel={startScroll} onScroll={handleScroll} onBlur={()=>{if(scrolling.current)settle();}}>
      <div aria-hidden="true">{options.map(minutes=><div key={minutes} className={styles.option} data-selected={minutes===value} onClick={()=>{if(disabled)return;cancelTimer();scrolling.current=false;baseline.current=minutes;emit(minutes);position(minutes,true);}}><span>{minuteWheelLabel(minutes)}</span></div>)}</div>
    </div>
  </div>;
}
