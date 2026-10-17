import Link from 'next/link';
import { Logo } from '@/components/shared';

export default function NotFound() {
  return <main className="brand-status-page"><Logo size={48} wordmark={false} /><h1>페이지를 찾을 수 없어요.</h1><Link href="/my" className="button primary">대시보드로</Link></main>;
}
