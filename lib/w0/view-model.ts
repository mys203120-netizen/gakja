/** Frontend presentation types only. These are not server or authorization contracts. */
export type W0Status =
  | 'disconnected'
  | 'loading'
  | 'empty'
  | 'pending'
  | 'error'
  | 'forbidden'
  | 'ready'
  | 'review_required';

export type W0Target = {
  id: string;
  university: string;
  department: string;
  admission: string;
  interviewDate: string | null;
};

export type W0Session = {
  id: string;
  targetId?: string;
  title: string;
  date: string;
  kind: 'practice' | 'mock';
  evaluation: 'review_required' | 'pending' | 'ready';
  score: number | null;
};

export type W0Model = {
  isExample: boolean;
  status: W0Status;
  targets: W0Target[];
  practiceUntil: string | null;
  tickets: number | null;
  strategy: string | null;
  activities: string[];
  sessions: W0Session[];
  /** Target owning guidebook content; absent scope must never match all targets. */
  contentTargetId?: string;
  /** Only populated by the development fixture, never by the disconnected adapter. */
  questionPreview?: { source: string; question: string; initialAnswer: string };
};

/** Until an authenticated adapter exists, show an explicit unavailable state. */
export function createDisconnectedModel(): W0Model {
  return {
    isExample: false,
    status: 'disconnected',
    targets: [],
    practiceUntil: null,
    tickets: null,
    strategy: null,
    activities: [],
    sessions: [],
  };
}

/**
 * A frontend presentation projection, not an authorization boundary. The future
 * authenticated adapter must independently enforce ownership and target scope.
 */
export function scopeW0Model(model: W0Model, targetId: string | null): W0Model {
  const targetExists = targetId !== null && model.targets.some((target) => target.id === targetId);
  const hasContentScope = targetExists && model.contentTargetId === targetId;
  const sessions = targetExists ? model.sessions.filter((session) => session.targetId === targetId) : [];
  const strategy = hasContentScope ? model.strategy : null;
  const activities = hasContentScope ? model.activities : [];
  const questionPreview = hasContentScope ? model.questionPreview : undefined;
  const hasTargetData = Boolean(strategy || activities.length || questionPreview || sessions.length);
  const status = !hasTargetData && (model.status === 'ready' || model.status === 'review_required')
    ? 'empty'
    : model.status;
  return {
    ...model,
    status,
    contentTargetId: hasContentScope ? model.contentTargetId : undefined,
    strategy,
    activities,
    questionPreview,
    sessions,
  };
}

/** Review and processing states take precedence over any stale numeric value. */
export function evaluationLabel(
  evaluation: W0Session['evaluation'],
  score: number | null,
): string {
  if (evaluation === 'review_required') return '평가 검수 대기';
  if (evaluation === 'pending') return '평가 준비 중';
  if (score === null || !Number.isFinite(score)) return '평가 결과 확인 필요';
  return `${score}점`;
}

/** Personal dates are supplied as ISO calendar dates; never infer a D-Day. */
export function interviewDateLabel(date: string | null): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '미확정';
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) return '미확정';
  return date.replaceAll('-', '.');
}
