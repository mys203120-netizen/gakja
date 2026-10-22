'use client';

import { Suspense, useEffect, useState } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { analyticsEnabled, collectVerifiedConversions, disableAnalytics, initializeAnalytics, markAnalyticsReady, readAnalyticsConsent, setAnalyticsConsent } from '@/lib/analytics';
import { ANALYTICS_CONSENT_EVENT, type AnalyticsConsent } from '@/lib/analytics-model';
import styles from './analytics.module.css';

function AnalyticsTracking() {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent>('unset');
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setConsent(readAnalyticsConsent());
    update();
    window.addEventListener(ANALYTICS_CONSENT_EVENT, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(ANALYTICS_CONSENT_EVENT, update); window.removeEventListener('storage', update); };
  }, []);
  useEffect(() => {
    if (consent !== 'granted' || !pathname) { disableAnalytics(); setId(null); return; }
    setId(initializeAnalytics(pathname));
    const collect = () => { if (document.visibilityState === 'visible') void collectVerifiedConversions(); };
    collect();
    const interval = window.setInterval(collect, 15_000);
    document.addEventListener('visibilitychange', collect);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', collect); };
  }, [consent, pathname]);
  // Initialization (including safe URL/title overrides) precedes tag loading.
  return id ? <Script id="gakja-ga4" src={`https://www.googletagmanager.com/gtag/js?id=${id}`} strategy="afterInteractive" referrerPolicy="no-referrer" onReady={() => { markAnalyticsReady(); void collectVerifiedConversions(); }}/> : null;
}

export function Analytics() {
  return <Suspense fallback={null}><AnalyticsTracking/></Suspense>;
}

export function AnalyticsConsentSettings() {
  const [consent, setConsent] = useState<AnalyticsConsent>('unset');
  useEffect(() => {
    const update = () => setConsent(readAnalyticsConsent());
    update(); window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  const change = (allow: boolean) => { const next = allow ? 'granted' : 'denied'; setAnalyticsConsent(next); setConsent(next); };
  return <section aria-labelledby="analytics-consent-heading">
    <h2 id="analytics-consent-heading">선택 통계 수집 설정</h2>
    <p>동의한 경우에만 Google Analytics로 화면 방문과 시작·가입·첫 답변 저장·면접 완료 통계를 수집해요. 이름, 이메일, 학생부, 답변 원문과 주소의 식별자·검색어는 보내지 않아요.</p>
    <p>설정은 이 브라우저에 180일간 저장돼요. 허용하지 않아도 모든 서비스를 이용할 수 있고 언제든 변경할 수 있어요.</p>
    <label className={styles.choice}><input type="checkbox" checked={consent === 'granted'} onChange={event => change(event.target.checked)}/><span>선택 통계 수집을 허용합니다</span></label>
    <p role="status">{consent === 'granted' ? '통계 수집을 허용했어요.' : '현재 통계를 수집하지 않아요.'}{!analyticsEnabled() ? ' 운영 통계 설정이 활성화되면 이 선택을 적용해요.' : ''}</p>
  </section>;
}
