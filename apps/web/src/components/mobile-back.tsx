'use client';
import {usePathname,useSearchParams} from 'next/navigation';
import Link from 'next/link';
import {ArrowLeft} from 'lucide-react';
import {mobileParent} from '@/lib/app-navigation';
import {ownedClassName} from './owned-class-name';
import styles from './navigation-rail.module.css';

export function MobileBack(){
 const path=usePathname(),params=useSearchParams(),parent=mobileParent(path);
 if(!parent)return null;
 const date=params.get('date')||'';
 const validDate=/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
 const href=parent.href==='/records'&&/^\/(?:records|reports)\//.test(path)&&validDate?'/records?date='+encodeURIComponent(date):parent.href;
 return <Link href={href} className={ownedClassName(`${styles.mobileBack} icon-button`,true)} aria-label={`뒤로 · ${parent.label}`} onClick={click=>{
  const event=new Event('gakja:navigate-back',{cancelable:true});
  if(!window.dispatchEvent(event))click.preventDefault();
 }}><ArrowLeft size={22} aria-hidden="true"/></Link>;
}
