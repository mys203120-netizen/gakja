export type SocialProvider = 'google' | 'kakao';
export function isSocialProvider(value: unknown): value is SocialProvider { return value === 'google' || value === 'kakao'; }
export function socialNext(value: unknown, role: 'student' | 'staff' | 'admin' = 'student'): string {
  if (role !== 'student') return '/admin';
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/my';
  try {
    const path = new URL(value, 'https://gakja.invalid');
    if (path.origin !== 'https://gakja.invalid' || !/^\/(my|quiz|interview|records|reports|knowledge|on|materials|account|onboarding)(\/|$)/.test(path.pathname)) return '/my';
    return path.pathname + path.search;
  } catch { return '/my'; }
}
export const socialErrors: Record<string, string> = {
  google_not_configured: 'Google 연결을 준비 중이에요. 이메일로 로그인해 주세요.',
  kakao_not_configured: '카카오 연결을 준비 중이에요. 이메일로 로그인해 주세요.',
  oauth_state: '연결 시간이 지났어요. 다시 시작해 주세요.',
  oauth_cancelled: '연결을 취소했어요. 원할 때 다시 시작해 주세요.',
  oauth_failed: '계정을 연결하지 못했어요. 다시 시도해 주세요.',
  oauth_email: '가입하려면 계정의 확인된 이메일 제공에 동의해 주세요.',
  oauth_existing: '같은 이메일의 계정이 있어요. 기존 로그인으로 들어와 주세요.',
  suspended: '이 계정은 이용이 중지되어 있어요. 담당자에게 문의해 주세요.',
  auth: '계정을 연결하지 못했어요. 다시 시도해 주세요.',
  unassigned: '계정 연결을 확인해 주세요. 담당자에게 문의해 주세요.',
};
