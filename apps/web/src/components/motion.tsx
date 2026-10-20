'use client';
import {ownedClassName} from './owned-class-name';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { attachQuestionCarry } from './playful-flow';
gsap.registerPlugin(ScrollTrigger);
export function PageMotion({ children }: { children: React.ReactNode }) { const ref = useRef<HTMLDivElement>(null); const pathname = usePathname(); const path = /^\/on(?:\/[^/]+)?\/?$/.test(pathname)&&!pathname.startsWith('/on/interviews')?'/on':pathname; useEffect(attachQuestionCarry, []); useEffect(() => { const ctx = gsap.context(() => { const mm = gsap.matchMedia(); mm.add('(prefers-reduced-motion: no-preference)', () => { if(document.querySelector('.question-carry'))return; gsap.fromTo(ref.current, { opacity: .85 }, { opacity: 1, duration: .12, ease: 'power3.out', clearProps: 'all' }); gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach(el => gsap.fromTo(el, { opacity: .85 }, { opacity: 1, duration: .14, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 95%', once: true }, clearProps: 'all' })); }); }, ref); return () => ctx.revert(); }, [path]); return <div ref={ref} className={ownedClassName("page-motion",true)}>{children}</div>; }
