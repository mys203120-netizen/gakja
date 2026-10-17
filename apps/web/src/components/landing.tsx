'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Logo } from './shared';

gsap.registerPlugin(ScrollTrigger);

export function Landing() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mm = gsap.matchMedia();
    const ctx = gsap.context(() => {
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.landing-title > span', { y: 30, opacity: 0, duration: .65, stagger: .08, ease: 'power3.out' });
        gsap.from('.landing-hero-symbol', { y: 28, opacity: 0, duration: .7, delay: .12, ease: 'power3.out' });
        gsap.from('.landing-hero-action', { y: 12, opacity: 0, duration: .4, delay: .28, ease: 'power3.out' });
        const tl = gsap.timeline({ scrollTrigger: { trigger: '.scroll-story', start: 'top top', end: '+=190%', pin: true, scrub: .4 } });
        tl.to('.story-logo', { y: -24, duration: 1 })
          .to('.story-copy-1', { y: -40, opacity: 0, duration: .3 }, .3)
          .fromTo('.story-copy-2', { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .4 }, .6)
          .to('.story-logo', { y: 0, duration: 1 }, 1)
          .to('.story-copy-2', { y: -40, opacity: 0, duration: .3 }, 1.3)
          .fromTo('.story-copy-3', { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .4 }, 1.6);
      });
    }, ref);
    return () => { mm.revert(); ctx.revert(); };
  }, []);

  return <div ref={ref} className="landing">
    <header className="landing-nav">
      <Link href="/" aria-label="각자의답 홈"><Logo /></Link>
      <Link className="landing-login" href="/login">로그인 <ArrowUpRight size={17} /></Link>
    </header>
    <main>
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-kicker">나를 위한 면접 준비</p>
          <h1 className="landing-title"><span>물음 너머,</span><span>각자의 답.</span></h1>
          <Link href="/login" className="button primary large landing-hero-action">나의 답 준비하기 <ArrowRight size={20} /></Link>
        </div>
        <div className="landing-hero-art" aria-hidden="true"><img className="landing-hero-symbol" src="/brand-logo.svg" alt="" width={400} /></div>
        <div className="landing-scroll"><span>스크롤하며 살펴보기</span><ArrowDown size={18} /></div>
      </section>
      <section className="scroll-story">
        <div className="story-logo-wrap"><img className="story-logo" src="/brand-logo.svg" alt="" width={440} /></div>
        <div className="story-copies">
          <div className="story-copy story-copy-1"><span className="story-label">발견</span><h2>내 기록 속<br className="story-break" /> 답의 재료.</h2></div>
          <div className="story-copy story-copy-2"><span className="story-label">설계</span><h2>나의 경험을<br className="story-break" /> 나의 언어로.</h2></div>
          <div className="story-copy story-copy-3"><span className="story-label">연습</span><h2>이제, 말할 수<br className="story-break" /> 있는 답.</h2><Link href="/login" className="story-action">나의 답 준비하기 <ArrowUpRight size={20} /></Link></div>
        </div>
        <div className="story-rule" aria-hidden="true" />
      </section>
      <section className="landing-end">
        <Logo size={70} wordmark={false} />
        <h2>다른 경험.<br />각자의답.</h2>
        <Link href="/login" className="button primary large">시작하기 <ArrowRight size={20} /></Link>
      </section>
    </main>
    <footer className="landing-footer"><span>각자의답 © {new Date().getFullYear()}</span></footer>
  </div>;
}
