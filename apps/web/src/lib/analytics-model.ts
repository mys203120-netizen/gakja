/** Only fixed screen labels and enum parameters may leave the application. */
export const ANALYTICS_CONSENT_COOKIE = 'gakja_analytics_consent';
export const ANALYTICS_CONSENT_MAX_AGE = 180 * 24 * 60 * 60;
export const ANALYTICS_CONSENT_EVENT = 'gakja:analytics-consent';
export type AnalyticsConsent = 'granted' | 'denied' | 'unset';
export type ConversionName = 'sign_up' | 'first_answer_saved' | 'interview_completed';
export type ConversionReceipt = { name: ConversionName; method?: 'google' | 'kakao' };

const screens: Record<string, string> = {
  '/': '서비스 소개', '/faq': '자주 묻는 질문', '/contact': '문의', '/privacy': '개인정보 처리방침',
  '/my': '홈', '/training': '훈련하기', '/my/today': '오늘 훈련', '/my/train': '훈련', '/my/diagnosis': '진단',
  '/preparation': '마이 대시보드', '/records': '내 기록', '/account': '내 계정', '/armory': '내 경험',
  '/availability': '훈련 일정', '/chat': '대화', '/interview': '모의면접', '/knowledge': '면접 자료',
  '/learn': '학습', '/materials': '내 자료', '/on': '각자ON', '/practice': '답변 연습',
  '/quiz': '다시 떠올리기', '/reports': '면접 리포트', '/schools': '지원 학교', '/start': '훈련 시작',
};
const screenRoots = new Set(['/records', '/account', '/chat', '/interview', '/knowledge', '/materials', '/on', '/practice', '/quiz', '/reports', '/schools']);

export function analyticsScreen(pathname: unknown): { path: string; title: string } | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (Object.hasOwn(screens, path)) return { path, title: screens[path] };
  // Identifiers, slugs, user-entered names and unknown routes never enter GA.
  const root = '/' + path.split('/')[1];
  return screenRoots.has(root) ? { path: root, title: screens[root] } : null;
}

export function analyticsConfigured(environment: { mode?: string; measurementId?: string; manualMeasurementConfirmed?: string }): boolean {
  return environment.mode === 'production' && /^G-[A-Z0-9]+$/.test(environment.measurementId || '') && environment.manualMeasurementConfirmed === 'true';
}

export function consentGrantedAt(value: string | undefined | null, now = Date.now()): number | null {
  const match = /^granted\.(\d{13})$/.exec(value || '');
  if (!match) return null;
  const at = Number(match[1]);
  return at <= now && at > now - ANALYTICS_CONSENT_MAX_AGE * 1000 ? at : null;
}

export function analyticsConsent(value: string | undefined | null, now = Date.now()): AnalyticsConsent {
  return consentGrantedAt(value, now) !== null ? 'granted' : value === 'denied' ? 'denied' : 'unset';
}

export function safeConversionReceipt(value: unknown): ConversionReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Record<string, unknown>;
  if (receipt.name === 'sign_up' && (receipt.method === 'google' || receipt.method === 'kakao')) return { name: 'sign_up', method: receipt.method };
  if (receipt.name === 'first_answer_saved' || receipt.name === 'interview_completed') return { name: receipt.name };
  return null;
}
