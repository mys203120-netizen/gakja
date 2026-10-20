'use client';
import {ownedClassName} from './owned-class-name';


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

  return <div ref={ref} className={ownedClassName("landing",true)}>
    <header className={ownedClassName("landing-nav",true)}>
      <Link href="/" aria-label="각자의답 홈"><Logo /></Link>
      <Link className={ownedClassName("landing-login")} href="/login">로그인 <ArrowUpRight size={17} /></Link>
    </header>
    <main className={ownedClassName(undefined,true)}>
      <section className={ownedClassName("landing-hero",true)}>
        <div className={ownedClassName("landing-hero-copy",true)}>
          <p className={ownedClassName("landing-kicker",true)}>나를 위한 면접 준비</p>
          <h1 className={ownedClassName("landing-title",true)}><span className={ownedClassName(undefined,true)}>물음 너머,</span><span className={ownedClassName(undefined,true)}>각자의 답.</span></h1>
          <Link href="/login" className={ownedClassName("button primary large landing-hero-action")}>나의 답 준비하기 <ArrowRight size={20} /></Link>
        </div>
        <div className={ownedClassName("landing-hero-art",true)} aria-hidden="true"><img className={ownedClassName("landing-hero-symbol",true)} src="/brand-logo.svg" alt="" width={400} /></div>
        <div className={ownedClassName("landing-scroll",true)}><span className={ownedClassName(undefined,true)}>스크롤하며 살펴보기</span><ArrowDown size={18} /></div>
      </section>
      <section className={ownedClassName("scroll-story",true)}>
        <div className={ownedClassName("story-logo-wrap",true)}><img className={ownedClassName("story-logo",true)} src="/brand-logo.svg" alt="" width={440} /></div>
        <div className={ownedClassName("story-copies",true)}>
          <div className={ownedClassName("story-copy story-copy-1",true)}><span className={ownedClassName("story-label",true)}>발견</span><h2 className={ownedClassName(undefined,true)}>내 기록 속<br className={ownedClassName("story-break",true)} /> 답의 재료.</h2></div>
          <div className={ownedClassName("story-copy story-copy-2",true)}><span className={ownedClassName("story-label",true)}>설계</span><h2 className={ownedClassName(undefined,true)}>나의 경험을<br className={ownedClassName("story-break",true)} /> 나의 언어로.</h2></div>
          <div className={ownedClassName("story-copy story-copy-3",true)}><span className={ownedClassName("story-label",true)}>연습</span><h2 className={ownedClassName(undefined,true)}>이제, 말할 수<br className={ownedClassName("story-break",true)} /> 있는 답.</h2><Link href="/login" className={ownedClassName("story-action")}>나의 답 준비하기 <ArrowUpRight size={20} /></Link></div>
        </div>
        <div className={ownedClassName("story-rule",true)} aria-hidden="true" />
      </section>
      <section className={ownedClassName("landing-end",true)}>
        <Logo size={70} wordmark={false} />
        <h2 className={ownedClassName(undefined,true)}>다른 경험.<br className={ownedClassName(undefined,true)} />각자의답.</h2>
        <Link href="/login" className={ownedClassName("button primary large")}>시작하기 <ArrowRight size={20} /></Link>
      </section>
    </main>
    <footer className={ownedClassName("landing-footer",true)}><span className={ownedClassName(undefined,true)}>각자의답 © {new Date().getFullYear()}</span></footer>
  </div>;
}
