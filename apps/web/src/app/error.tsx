'use client';
import { Logo } from '@/components/shared';

export default function Error({ reset }: { reset: () => void }) {
  return <div className="brand-status-page"><Logo size={48} wordmark={false} /><h1>화면을 불러오지 못했어요.</h1><button onClick={reset} className="button primary">다시 시도</button></div>;
}
