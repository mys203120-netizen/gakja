
import {ownedClassName} from '@/components/owned-class-name';
import Link from 'next/link';
import { Logo } from '@/components/shared';

export default function NotFound() {
  return <main className={ownedClassName("brand-status-page",true)}><Logo size={48} wordmark={false} /><h1 className={ownedClassName(undefined,true)}>페이지를 찾을 수 없어요.</h1><Link href="/" className={ownedClassName("button primary")}>홈으로</Link><Link href="/my" className={ownedClassName("button ghost")}>오늘 훈련으로</Link></main>;
}
