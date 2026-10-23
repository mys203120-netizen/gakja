'use client';

import Link from 'next/link';
import {ArrowRight, LayoutDashboard, Play, Sparkles} from 'lucide-react';
import {useApp} from './app-shell';
import {ownedClassName} from './owned-class-name';
import styles from './home-gateway.module.css';

export function HomeGateway(){
  const {data}=useApp();
  return <div className={ownedClassName(styles.home,true)}>
    <header className={ownedClassName(styles.heading,true)}>
      <p className={ownedClassName(styles.greeting,true)}><Sparkles size={15} aria-hidden="true"/>{data.user.name}님, 반가워요.</p>
      <h1 className={ownedClassName(undefined,true)}>오늘도, 나다운 답으로.</h1>
      <p className={ownedClassName(styles.description,true)}>연습을 시작하거나 쌓아 온 기록을 살펴보세요.</p>
    </header>
    <nav className={ownedClassName(styles.entries,true)} aria-label="주요 메뉴">
      <Link href="/training" className={ownedClassName(`${styles.entry} ${styles.training}`)}>
        <div className={ownedClassName(styles.cardTop,true)}><span className={ownedClassName(styles.icon,true)}><Play size={28} strokeWidth={1.6} aria-hidden="true"/></span><span className={ownedClassName(styles.cardLabel,true)}>오늘의 한 걸음</span></div>
        <div className={ownedClassName(styles.copy,true)}><h2 className={ownedClassName(undefined,true)}>훈련하기</h2><p className={ownedClassName(undefined,true)}>오늘의 훈련부터 자유 연습까지</p></div>
        <span className={ownedClassName(styles.entryAction,true)}>내 답을 연습해요<ArrowRight size={22} aria-hidden="true"/></span>
      </Link>
      <Link href="/preparation" className={ownedClassName(`${styles.entry} ${styles.dashboard}`)}>
        <div className={ownedClassName(styles.cardTop,true)}><span className={ownedClassName(styles.icon,true)}><LayoutDashboard size={28} strokeWidth={1.6} aria-hidden="true"/></span><span className={ownedClassName(styles.cardLabel,true)}>쌓여 가는 나의 준비</span></div>
        <div className={ownedClassName(styles.copy,true)}><h2 className={ownedClassName(undefined,true)}>마이 대시보드</h2><p className={ownedClassName(undefined,true)}>면접 일정, 준비 현황, 기록과 리포트</p></div>
        <span className={ownedClassName(styles.entryAction,true)}>나의 준비를 살펴봐요<ArrowRight size={22} aria-hidden="true"/></span>
      </Link>
    </nav>
  </div>;
}
