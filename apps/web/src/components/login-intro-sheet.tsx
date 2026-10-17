'use client';

import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowDown, ArrowRight, Check, Layers3, MessageCircle, Sparkles, X} from 'lucide-react';
import styles from './login-intro-sheet.module.css';

export function LoginIntroSheet({disabled=false}:{disabled?:boolean}) {
  const [open,setOpen]=useState(false);
  const [closing,setClosing]=useState(false);
  const marker=useRef<HTMLDivElement>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const title=useRef<HTMLHeadingElement>(null);
  const openedByScroll=useRef(false);
  const returnToLogin=useRef(false);
  const dragStart=useRef<number|null>(null);

  useEffect(()=>{
    let lastY=window.scrollY;
    const scroll=()=>{
      const y=window.scrollY,down=y>lastY;lastY=y;
      if(!down||y<60||disabled||open||openedByScroll.current)return;
      if(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'))return;
      if(window.visualViewport&&window.visualViewport.height<window.innerHeight*.8)return;
      // Let people reach the login controls before an intentional final scroll opens the intro.
      if(marker.current&&marker.current.getBoundingClientRect().bottom<=window.innerHeight+8){
        openedByScroll.current=true;setOpen(true);
      }
    };
    window.addEventListener('scroll',scroll,{passive:true});
    return()=>window.removeEventListener('scroll',scroll);
  },[disabled,open]);

  useEffect(()=>{
    if(!open)return;
    openedByScroll.current=true;
    const previous=document.activeElement as HTMLElement|null;
    const element=dialog.current;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    element?.showModal();title.current?.focus({preventScroll:true});
    return()=>{
      element?.close();document.body.style.overflow=overflow;
      if(returnToLogin.current){
        const heading=document.getElementById('auth-title');
        heading?.focus({preventScroll:true});
        heading?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
        returnToLogin.current=false;
      }else previous?.focus({preventScroll:true});
    };
  },[open]);

  useEffect(()=>{
    if(!closing)return;
    const timer=window.setTimeout(()=>{setOpen(false);setClosing(false);},window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:200);
    return()=>window.clearTimeout(timer);
  },[closing]);

  const close=(login=false)=>{returnToLogin.current=login;setClosing(true);};
  return <>
    <div className={styles.discover} ref={marker}>
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?'login-brand-sheet':undefined} onClick={()=>setOpen(true)}>
        <span className={styles.discoverLabel}>내 이야기가 답이 되는 방법</span>
        <span>각자ON 둘러보기 <ArrowDown size={16}/></span>
      </button>
      <span className={styles.scrollHint}>조금 더 내려서 만나보세요</span>
    </div>
    {open&&createPortal(<dialog id="login-brand-sheet" ref={dialog} className={styles.sheet} data-closing={closing} aria-labelledby="login-brand-title" aria-describedby="login-brand-description" onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget)close();}}>
      <section className={styles.surface}>
        <header className={styles.topbar}>
          <button className={styles.handle} type="button" aria-label="소개 시트 닫기" onClick={()=>close()} onPointerDown={e=>{dragStart.current=e.clientY;e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={e=>{if(dragStart.current!==null&&e.clientY-dragStart.current>60)close();dragStart.current=null;}} onPointerCancel={()=>{dragStart.current=null;}}><span/></button>
          <span className={styles.wordmark}><img src="/brand-logo.svg" width={24} height={24} alt=""/>각자ON <span>각자의답</span></span>
          <button className={styles.close} type="button" aria-label="소개 닫기" onClick={()=>close()}><X size={21}/></button>
        </header>
        <div className={styles.content}>
          <div className={styles.hero}>
            <div className={styles.message}>
              <span className={styles.eyebrow}><span/>나의 경험으로 준비하는 면접</span>
              <h2 ref={title} tabIndex={-1} id="login-brand-title">물음 너머,<br/>답은 <em>내 안에.</em></h2>
              <p id="login-brand-description">작다고 생각했던 경험에도 나만의 이유가 있어요.<br className={styles.desktopBreak}/> 각자ON과 발견하고, 말하고, 더 선명하게 다듬어요.</p>
              <div className={styles.promise}><Check size={16}/>내가 한 경험, 내가 설명할 수 있는 답변.</div>
            </div>
            <div className={styles.story} aria-label="내 경험이 면접 답변으로 이어지는 연습 예시">
              <span className={styles.example}>이렇게 연결돼요 · 연습 예시</span>
              <div className={styles.memory}><span><Layers3 size={15}/> 나의 무기고</span><strong>의견이 달랐던 팀 프로젝트</strong><p>서로의 의견을 듣고 공통점을 정리했다.</p><div><i>협업</i><i>나의 역할</i></div></div>
              <div className={styles.connector} aria-hidden="true"><span/><ArrowDown size={17}/></div>
              <div className={styles.question}><span><MessageCircle size={15}/> Chat · Live 면접</span><p>“의견을 정리할 때,<br/>어떤 기준이 가장 중요했나요?”</p></div>
              <span className={styles.storyNote}><Sparkles size={14}/>경험 하나에서, 나다운 답변 한 걸음.</span>
            </div>
          </div>
          <section className={styles.journey} aria-labelledby="login-journey-title">
            <div className={styles.journeyTitle}><h3 id="login-journey-title">준비는 가볍게. 답변은 나답게.</h3><span>나를 알아가는 세 단계</span></div>
            <ol className={styles.steps}>
              <li><span className={styles.stepNumber}>01 <Layers3 size={19}/></span><h4>경험을 발견하고</h4><p>나의 무기고에 활동 속 상황과<br/>내 행동, 배운 점을 차곡차곡.</p><span className={styles.feature}>나의 무기고</span></li>
              <li><span className={styles.stepNumber}>02 <MessageCircle size={19}/></span><h4>내 말로 연습하고</h4><p>Chat으로 생각을 정리하고,<br/>Live로 직접 말하며 익숙해져요.</p><span className={styles.feature}>Chat · Live 면접</span></li>
              <li><span className={styles.stepNumber}>03 <Sparkles size={19}/></span><h4>한 번 더 선명하게</h4><p>리포트로 답변을 돌아보고,<br/>AI 비서와 다음 연습을 준비해요.</p><span className={styles.feature}>내 리포트 · AI 비서</span></li>
            </ol>
          </section>
          <p className={styles.signoff}>각자의 이야기, <strong>각자의 답이 되도록.</strong></p>
        </div>
        <footer className={styles.footer}><span>오늘의 경험이 내일의 답변으로.</span><button type="button" onClick={()=>close(true)}>로그인으로 돌아가기 <ArrowRight size={18}/></button></footer>
      </section>
    </dialog>,document.body)}
  </>;
}
