'use client';
import {ownedClassName} from './owned-class-name';


import {useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,Check,History,Library,ListChecks,MessageCircle} from 'lucide-react';
import {trackEvent} from '@/lib/analytics';
import {PublicFaq} from './public-faq';
import {PublicLinks} from './public-links';
import styles from './login-intro-sheet.module.css';

/** The overview is part of the page, so scrolling never opens or traps a dialog. */
export function LoginIntroSheet({disabled=false}:{disabled?:boolean}) {
  const overview=useRef<HTMLElement>(null),title=useRef<HTMLHeadingElement>(null);
  const [showMobileStart,setShowMobileStart]=useState(false);
  useEffect(()=>{
    const section=overview.current;
    if(!section||typeof IntersectionObserver==='undefined')return;
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    let observer:IntersectionObserver|undefined;
    function syncMotion() {
      observer?.disconnect();
      if(!section)return;
      if(media.matches){delete section.dataset.motion;return;}
      const blocks=section.querySelectorAll<HTMLElement>('[data-reveal]');
      observer=new IntersectionObserver(entries=>{
        for(const entry of entries)(entry.target as HTMLElement).dataset.visible=entry.isIntersecting?'true':'false';
      },{threshold:.12,rootMargin:'0px 0px -24px 0px'});
      for(const block of blocks){block.dataset.visible='false';observer.observe(block);}
      section.dataset.motion='ready';
    }
    syncMotion();media.addEventListener('change',syncMotion);
    return()=>{observer?.disconnect();media.removeEventListener('change',syncMotion);delete section.dataset.motion;};
  },[]);
  useEffect(()=>{
    const form=document.getElementById('auth-form');
    if(!form||typeof IntersectionObserver==='undefined')return;
    const mobile=window.matchMedia('(max-width: 767px)');
    let pastLogin=false;
    function syncStart(){
      const active=document.activeElement;
      const editing=active instanceof HTMLElement&&(active.matches('input,textarea,select')||active.isContentEditable);
      const viewport=window.visualViewport;
      const keyboardVisible=Boolean(viewport&&window.innerHeight-viewport.height>150);
      setShowMobileStart(mobile.matches&&pastLogin&&!editing&&!keyboardVisible&&!disabled);
    }
    const observer=new IntersectionObserver(entries=>{
      const entry=entries[0];
      pastLogin=!entry.isIntersecting&&entry.boundingClientRect.bottom<=0;
      syncStart();
    });
    observer.observe(form);
    mobile.addEventListener('change',syncStart);
    document.addEventListener('focusin',syncStart);
    document.addEventListener('focusout',syncStart);
    window.visualViewport?.addEventListener('resize',syncStart);
    syncStart();
    return()=>{observer.disconnect();mobile.removeEventListener('change',syncStart);document.removeEventListener('focusin',syncStart);document.removeEventListener('focusout',syncStart);window.visualViewport?.removeEventListener('resize',syncStart);};
  },[disabled]);
  function discover() {
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    overview.current?.scrollIntoView({block:'start',behavior:reduced?'instant':'smooth'});
    title.current?.focus({preventScroll:true});
  }
  function backToLogin(placement?:'hero'|'mobile') {
    if(placement)trackEvent('cta_start_click',{placement});
    const heading=document.getElementById('auth-title');
    heading?.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    const control=document.querySelector<HTMLElement>('#auth-form button:not([disabled])');
    (control||heading)?.focus({preventScroll:true});
  }
  return <>
    <div className={ownedClassName(styles.discover,true)}>
      <button type="button" disabled={disabled} aria-controls="login-overview" onClick={discover} className={ownedClassName(undefined,true)}>각자ON 둘러보기<ArrowDown size={17}/></button>
    </div>
    <section className={ownedClassName(styles.overview,true)} id="login-overview" ref={overview} aria-labelledby="login-overview-title">
      <div className={ownedClassName(styles.content,true)}>
        <div className={ownedClassName(styles.hero,true)} data-reveal>
          <div className={ownedClassName(styles.message,true)}>
            <span className={ownedClassName(styles.eyebrow,true)}>내 경험으로 준비하는 면접</span>
            <h2 ref={title} tabIndex={-1} id="login-overview-title" className={ownedClassName(undefined,true)}>물음 너머,<br className={ownedClassName(undefined,true)}/>답은 <em className={ownedClassName(undefined,true)}>내 안에.</em></h2>
            <p className={ownedClassName(undefined,true)}>면접일까지 남은 시간에 맞춰,<br className={ownedClassName(undefined,true)}/>오늘 할 연습부터 함께 정해요.</p>
            <button className={styles.startButton} type="button" disabled={disabled} onClick={()=>backToLogin('hero')}>내 면접 준비 시작하기<ArrowUp size={17}/></button>
          </div>
          <div className={ownedClassName(styles.story,true)} aria-label="오늘 훈련 예시">
            <span className={ownedClassName(styles.example,true)}><ListChecks size={18}/>오늘 훈련</span>
            <strong className={ownedClassName(undefined,true)}>나의 활동 한 가지부터</strong>
            <p className={ownedClassName(undefined,true)}>의견이 달랐던 팀 프로젝트</p>
            <div className={ownedClassName(styles.question,true)}><MessageCircle size={19}/><span className={ownedClassName(undefined,true)}>의견을 정리할 때,<br className={ownedClassName(undefined,true)}/>어떤 기준이 중요했나요?</span></div>
            <span className={ownedClassName(styles.storyNote,true)}><Check size={16}/>답변하고, 한 가지 보완하고, 다시 말해요.</span>
          </div>
        </div>
        <section className={styles.examples} aria-labelledby="intro-example-title" data-reveal>
          <div className={styles.exampleHeading}><h2 id="intro-example-title">한 가지 경험이 답변이 되는 과정</h2><p>서비스 이해를 위한 예시</p></div>
          <ol className={styles.exampleScreens}>
            <li><span className={styles.screenLabel}>01 · 활동 선택</span><h3>의견이 달랐던 팀 프로젝트</h3><p className={styles.screenMeta}>나의 활동 · 팀 탐구</p><div className={styles.screenCard}><strong>내가 맡은 역할</strong><p>서로 다른 의견을 정리하고 발표 방향을 함께 정했어요.</p></div><span className={styles.screenHint}><Check size={14}/>이 활동으로 연습하기</span></li>
            <li><span className={styles.screenLabel}>02 · 답변·보완</span><h3>어떤 기준으로 의견을 정리했나요?</h3><div className={styles.screenCard}><strong>나의 답변</strong><p>각자 제안한 이유를 적고, 주제와 맞는지 비교했어요.</p></div><div className={styles.improvement}><MessageCircle size={16}/><p>비교한 기준을 한 가지 더 구체적으로 말해 볼까요?</p></div></li>
            <li><span className={styles.screenLabel}>03 · 이전 답변 비교</span><h3>내 행동이 더 선명해졌어요</h3><div className={styles.screenCard}><strong>이전 답변</strong><p>친구들과 의논해서 정했어요.</p></div><div className={styles.screenCard}><strong>보완한 답변</strong><p>조사 자료로 확인할 수 있는지를 기준으로 제안을 비교했어요.</p></div><span className={styles.screenHint}><History size={14}/>이전 답변과 함께 돌아보기</span></li>
          </ol>
        </section>
        <ol className={ownedClassName(styles.steps,true)} aria-label="각자ON의 세 가지 메뉴">
          <li data-reveal className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.stepNumber,true)}><ListChecks size={21}/>01</span><h3 className={ownedClassName(undefined,true)}>오늘 훈련</h3><p className={ownedClassName(undefined,true)}>지원 학교의 면접일과 내 일정에 맞춘 순서대로 연습해요.</p></li>
          <li data-reveal className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.stepNumber,true)}><Library size={21}/>02</span><h3 className={ownedClassName(undefined,true)}>준비 현황</h3><p className={ownedClassName(undefined,true)}>활동과 답변이 얼마나 준비됐는지, 다음에 보완할 곳을 확인해요.</p></li>
          <li data-reveal className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.stepNumber,true)}><History size={21}/>03</span><h3 className={ownedClassName(undefined,true)}>내 기록</h3><p className={ownedClassName(undefined,true)}>글과 음성 답변을 함께 모으고, 이전 답변과 달라진 점을 돌아봐요.</p></li>
        </ol>
        <PublicFaq/>
        <footer className={ownedClassName(styles.footer,true)} data-reveal><p className={ownedClassName(undefined,true)}>각자의 이야기, <strong className={ownedClassName(undefined,true)}>각자의 답이 되도록.</strong></p><button type="button" onClick={()=>backToLogin()} className={ownedClassName(undefined,true)}>상단으로<ArrowUp size={17}/></button></footer>
        <PublicLinks/>
      </div>
    </section>
    {showMobileStart&&!disabled&&<div className={styles.mobileStart}><button type="button" disabled={disabled} onClick={()=>backToLogin('mobile')}>내 면접 준비 시작하기<ArrowUp size={18}/></button></div>}
  </>;
}
