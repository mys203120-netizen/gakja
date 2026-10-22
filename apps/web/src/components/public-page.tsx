import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './public-page.module.css';

export function PublicPage({ title, introduction, children }: { title: string; introduction: string; children: ReactNode }) {
  return <div className={styles.page}>
    <header className={styles.header}><Link href="/" className={styles.brand}><img src="/brand-logo.svg" width="32" height="32" alt=""/>각자ON</Link><Link href="/">면접 준비 시작하기</Link></header>
    <main className={styles.main}><h1>{title}</h1><p className={styles.introduction}>{introduction}</p>{children}</main>
    <footer className={styles.footer}><nav aria-label="서비스 안내"><Link href="/faq">자주 묻는 질문</Link><Link href="/contact">문의하기</Link><Link href="/privacy">개인정보 처리방침</Link></nav><span>각자ON · 각자의답</span></footer>
  </div>;
}
