'use client';
import {ownedClassName} from '@/components/owned-class-name';

import { Logo } from '@/components/shared';

export default function Error({ reset }: { reset: () => void }) {
  return <div className={ownedClassName("brand-status-page",true)}><Logo size={48} wordmark={false} /><h1 className={ownedClassName(undefined,true)}>화면을 불러오지 못했어요.</h1><button onClick={reset} className={ownedClassName("button primary",true)}>다시 시도</button></div>;
}
