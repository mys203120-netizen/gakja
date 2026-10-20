import {normalizeTrainingAvailability} from './training-availability';

type OnboardingAccount = {
  user?: { role?: unknown };
  targets?: unknown[];
  preferences?: { schoolCalendarOnboardingCompleted?: unknown; trainingAvailabilityRequired?:unknown; trainingAvailability?:unknown };
};

const onboardingExceptions = ['/start', '/schools/new', '/availability', '/account', '/settings', '/legal', '/terms', '/privacy'];

/** A historical completion flag cannot replace an active support target. */
export function studentOnboardingDestination(data: OnboardingAccount | null, pathname: string, admin = false): string | null {
  if (admin || !data || data.user?.role !== 'student') return null;
  if (onboardingExceptions.some(path => pathname === path || pathname.startsWith(`${path}/`))) return null;
  if ((data.targets?.length ?? 0) > 0) {
    if(data.preferences?.trainingAvailabilityRequired===true&&!normalizeTrainingAvailability(data.preferences.trainingAvailability))return '/availability?onboarding=1';
    return null;
  }
  return '/schools/new?onboarding=1';
}
