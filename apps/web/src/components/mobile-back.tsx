'use client';
import {usePathname} from 'next/navigation';
import Link from 'next/link';
import {ArrowLeft} from 'lucide-react';
import {mobileParent} from '@/lib/app-navigation';
import {ownedClassName} from './owned-class-name';
import styles from './navigation-rail.module.css';

export function MobileBack(){
 const path=usePathname(),parent=mobileParent(path);
 if(!parent)return null;
 return <Link href={parent.href} className={ownedClassName(`${styles.mobileBack} icon-button`,true)} aria-label={`뒤로 · ${parent.label}`} onClick={click=>{
  const event=new Event('gakja:navigate-back',{cancelable:true});
  if(!window.dispatchEvent(event))click.preventDefault();
 }}><ArrowLeft size={22} aria-hidden="true"/></Link>;
}
