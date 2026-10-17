'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { publishedMaterialBooks } from '@/lib/material-learning-flow';
import { useApp } from './app-shell';
import styles from './learning-surfaces.module.css';

const sections=[['activities','활동'],['questions','예상 질문'],['answers','답변 초안'],['guidebook','가이드북'],['handbook','핸드북']];

export function MaterialNavigation() {
  const {data}=useApp(),path=usePathname(),section=path.split('/')[2]||'';
  const bookKinds=publishedMaterialBooks(data.documents).map(book=>book.kind);
  if((path!=='/materials'&&!path.startsWith('/materials/'))||section==='briefings')return null;
  const children=sections.filter(([key])=>!['guidebook','handbook'].includes(key)||bookKinds.includes(key));
  return <div className={styles.materialNavigation}>
    <nav className={styles.materialChildren} aria-label="내 교재 구성">{children.map(([key,label])=><Link key={key} href={'/materials/'+key} aria-current={key===section?'page':undefined}>{label}</Link>)}</nav>
  </div>;
}
