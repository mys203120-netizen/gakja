type OnboardingAccount = {
  user?: { role?: unknown };
  targets?: unknown[];
  preferences?: { schoolCalendarOnboardingCompleted?: unknown };
};

const onboardingExceptions = ['/start', '/schools/new', '/account', '/settings', '/legal', '/terms', '/privacy'];

/** Existing support targets remain usable without retroactive onboarding. */
export function studentOnboardingDestination(data: OnboardingAccount | null, pathname: string, admin = false): string | null {
  if (admin || !data || data.user?.role !== 'student') return null;
  if ((data.targets?.length ?? 0) > 0 || data.preferences?.schoolCalendarOnboardingCompleted === true) return null;
  if (onboardingExceptions.some(path => pathname === path || pathname.startsWith(`${path}/`))) return null;
  return '/start';
}
