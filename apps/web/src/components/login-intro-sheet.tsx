'use client';

import {useEffect,useRef} from 'react';
import {ArrowDown,ArrowUp,Check,History,Library,ListChecks,MessageCircle} from 'lucide-react';
import styles from './login-intro-sheet.module.css';

/** The overview is part of the page, so scrolling never opens or traps a dialog. */
export function LoginIntroSheet({disabled=false}:{disabled?:boolean}) {
  const overview=useRef<HTMLElement>(null),title=useRef<HTMLHeadingElement>(null);
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
  function discover() {
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    overview.current?.scrollIntoView({block:'start',behavior:reduced?'instant':'smooth'});
    title.current?.focus({preventScroll:true});
  }
  function backToLogin() {
    const heading=document.getElementById('auth-title');
    heading?.scrollIntoView({block:'center',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    heading?.focus({preventScroll:true});
  }
  return <>
    <div className={styles.discover}>
      <button type="button" disabled={disabled} aria-controls="login-overview" onClick={discover}>각자ON 둘러보기<ArrowDown size={17}/></button>
    </div>
    <section className={styles.overview} id="login-overview" ref={overview} aria-labelledby="login-overview-title">
      <div className={styles.content}>
        <div className={styles.hero} data-reveal>
          <div className={styles.message}>
            <span className={styles.eyebrow}>내 경험으로 준비하는 면접</span>
            <h2 ref={title} tabIndex={-1} id="login-overview-title">물음 너머,<br/>답은 <em>내 안에.</em></h2>
            <p>면접일까지 남은 시간에 맞춰,<br/>오늘 할 연습부터 함께 정해요.</p>
          </div>
          <div className={styles.story} aria-label="오늘 훈련 예시">
            <span className={styles.example}><ListChecks size={18}/>오늘 훈련</span>
            <strong>나의 활동 한 가지부터</strong>
            <p>의견이 달랐던 팀 프로젝트</p>
            <div className={styles.question}><MessageCircle size={19}/><span>의견을 정리할 때,<br/>어떤 기준이 중요했나요?</span></div>
            <span className={styles.storyNote}><Check size={16}/>답변하고, 한 가지 보완하고, 다시 말해요.</span>
          </div>
        </div>
        <ol className={styles.steps} aria-label="각자ON의 세 가지 메뉴">
          <li data-reveal><span className={styles.stepNumber}><ListChecks size={21}/>01</span><h3>오늘 훈련</h3><p>지원 학교의 면접일과 내 일정에 맞춘 순서대로 연습해요.</p></li>
          <li data-reveal><span className={styles.stepNumber}><Library size={21}/>02</span><h3>준비 현황</h3><p>활동과 답변이 얼마나 준비됐는지, 다음에 보완할 곳을 확인해요.</p></li>
          <li data-reveal><span className={styles.stepNumber}><History size={21}/>03</span><h3>내 기록</h3><p>글과 음성 답변을 함께 모으고, 이전 답변과 달라진 점을 돌아봐요.</p></li>
        </ol>
        <footer className={styles.footer} data-reveal><p>각자의 이야기, <strong>각자의 답이 되도록.</strong></p><button type="button" onClick={backToLogin}>상단으로<ArrowUp size={17}/></button></footer>
      </div>
    </section>
  </>;
}
