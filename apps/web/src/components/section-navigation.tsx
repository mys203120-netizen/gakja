'use client';
import Link from 'next/link';
import {useEffect,useRef} from 'react';
import {usePathname} from 'next/navigation';
import {PRACTICE_SECTIONS,RESOURCE_SECTIONS,isAnswerWorkspace,practiceSectionHref,resourceSectionHref,studentSection} from '@/lib/app-navigation';
import styles from './navigation-rail.module.css';

export function SectionNavigation(){
  const path=usePathname(),section=studentSection(path);
  const navigation=useRef<HTMLElement>(null);
  useEffect(()=>{
    const container=navigation.current,active=container?.querySelector<HTMLElement>('[aria-current="page"]');
    if(!container||!active)return;
    const frame=container.getBoundingClientRect(),link=active.getBoundingClientRect();
    const overflow=link.left<frame.left?link.left-frame.left:link.right>frame.right?link.right-frame.right:0;
    if(overflow)container.scrollBy({left:overflow,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  },[path]);
  if(isAnswerWorkspace(path))return null;
  if(path==='/my'||path==='/preparation'||path==='/availability'||path.startsWith('/my/diagnosis')||path.startsWith('/my/train'))return null;
  const items=section==='preparation'?RESOURCE_SECTIONS:section==='today'?PRACTICE_SECTIONS:null;
  if(!items)return null;
  const current=section==='preparation'?resourceSectionHref(path):practiceSectionHref(path);
  function openAssistant(event:React.MouseEvent){const pause=new Event('gakja:open-on',{cancelable:true});window.dispatchEvent(pause);if(pause.defaultPrevented)event.preventDefault();}
  return <nav ref={navigation} className={styles.sectionNavigation} data-scrollbar="hidden" aria-label={section==='preparation'?'준비 자료와 활동':'오늘 훈련과 연습'}>{items.map(item=><Link key={item.href} href={item.href} onClick={item.href==='/on'?openAssistant:undefined} aria-current={current===item.href?'page':undefined}>{item.label}</Link>)}{section==='preparation'&&<Link className={styles.factLink} href="/account/confirmations" aria-current={path.startsWith('/account/confirmations')?'page':undefined}>사실 확인</Link>}</nav>;
}
