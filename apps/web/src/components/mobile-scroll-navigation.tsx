'use client';
import {useEffect} from 'react';
import {usePathname} from 'next/navigation';
import {installScrollNavigation} from '@/lib/client/scroll-navigation';

export function MobileScrollNavigation(){
  const path=usePathname();
  useEffect(()=>{const nav=document.querySelector<HTMLElement>('nav.mobile-nav');if(nav)return installScrollNavigation(nav);},[path]);
  return null;
}
