'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {PRACTICE_SECTIONS,RESOURCE_SECTIONS,isAnswerWorkspace,practiceSectionHref,resourceSectionHref,studentSection} from '@/lib/app-navigation';
import styles from './navigation-rail.module.css';

export function SectionNavigation(){
  const path=usePathname(),section=studentSection(path);
  if(isAnswerWorkspace(path))return null;
  const items=section==='resources'?RESOURCE_SECTIONS:section==='practice'?PRACTICE_SECTIONS:null;
  if(!items)return null;
  const current=section==='resources'?resourceSectionHref(path):practiceSectionHref(path);
  return <nav className={styles.sectionNavigation} aria-label={section==='resources'?'자료 탐색':'연습 탐색'}>{items.map(item=><Link key={item.href} href={item.href} aria-current={current===item.href?'page':undefined}>{item.label}</Link>)}{section==='resources'&&<Link className={styles.factLink} href="/account/confirmations" aria-current={path.startsWith('/account/confirmations')?'page':undefined}>사실 확인</Link>}</nav>;
}
