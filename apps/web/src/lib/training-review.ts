/** Review requests describe finite recheck exercises, never a score or a claim of mastery. */
export type ReviewCategory = 'personal' | 'major' | 'talent';
export type ReviewAttempt = {
  id: string; at: string; assistanceKnown?: boolean; assisted?: boolean; timedOut?: boolean;
  outcome?: boolean; valid?: boolean; inputMode?: string;
  kind?: 'interview_answer' | 'quiz_response' | 'memory_review' | 'assignment_submission';
};
export type ReviewQuestion = {
  id: string; targetId: string; targetKey: string; sourceType: 'personal' | 'common'; sourceVersion: number;
  activityIds: string[]; category: ReviewCategory; attempts: ReviewAttempt[];
};
export type ReviewScope = Omit<ReviewQuestion, 'attempts' | 'category'>;
export type ReviewRequest = {
  id: string; origin: 'student' | 'automatic'; selectionKey: string; diagnosticKey?: string;
  questionKeys: string[]; scopes: ReviewScope[]; requestedAt: string | null; migratedAt?: string;
  baselineEvidenceIds: string[]; status: 'active' | 'resolved' | 'dismissed' | 'out_of_scope' | 'withdrawn';
  resolvedEvidenceIds: string[]; resolvedAt: string | null; triggerEvidenceId?: string; reason: string;
  resolvedQuestionKeys?: string[]; resolvedEvidenceByQuestion?: Record<string, string>;
  /** Retain even an unmatched legacy selection, without inventing a current scope. */
  scopeSnapshot?: Record<string, unknown>;
};
export type ReviewState = {version: 1; requests: ReviewRequest[]; migratedDiagnosticKeys: string[]};
export type ReviewQuestionStatus = {
  questionKey: string; targetId: string; questionId: string; sourceType: 'personal' | 'common';
  sourceVersion: number; activityIds: string[]; status: 'active' | 'resolved' | 'clear';
  needsReview: boolean; requestIds: string[]; resolvedEvidenceIds: string[]; reason: string;
  requestedAtUnknown: boolean;
};
type Diagnostic = Record<string, any>;
type ReconcileInput = {state?: unknown; questions: ReviewQuestion[]; diagnostics: Record<string, Diagnostic>; now: string};

const categories: ReviewCategory[] = ['personal', 'major', 'talent'];
const unique = (values: string[]) => [...new Set(values)];
const strings = (value: unknown): string[] => Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string' && !!item)) : [];
const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Include support-target identity and content revision; a question ID alone is not a scope. */
export function reviewQuestionKey(question: Pick<ReviewQuestion, 'id' | 'targetId' | 'targetKey' | 'sourceType' | 'sourceVersion'>): string {
  return JSON.stringify([question.targetId, question.targetKey, question.sourceType, question.sourceVersion, question.id]);
}

function diagnosticKey(targetId: string, diagnostic: Diagnostic): string {
  return JSON.stringify([targetId, diagnostic.sessionId ?? null, canonical(diagnostic.targetSnapshot ?? null), diagnostic.targetKey ?? null, diagnostic.sourceType ?? null, diagnostic.sourceVersion ?? null]);
}

export const reviewDiagnosticKey = diagnosticKey;

function readState(value: unknown): ReviewState {
  const saved = value && typeof value === 'object' ? value as Partial<ReviewState> : {};
  if (saved.version !== 1) return {version: 1, requests: [], migratedDiagnosticKeys: []};
  const requests = Array.isArray(saved.requests) ? saved.requests.filter(request => request && typeof request.id === 'string' && ['student', 'automatic'].includes(request.origin)).map(request => ({
    ...request, questionKeys: strings(request.questionKeys), scopes: Array.isArray(request.scopes) ? request.scopes.map(scope => ({...scope, activityIds: strings(scope.activityIds)})) : [],
    baselineEvidenceIds: strings(request.baselineEvidenceIds), resolvedEvidenceIds: strings(request.resolvedEvidenceIds),
    resolvedQuestionKeys: strings(request.resolvedQuestionKeys), resolvedEvidenceByQuestion: {...request.resolvedEvidenceByQuestion},
  })) : [];
  return {version: 1, requests: [...new Map(requests.map(request => [request.id, request])).values()], migratedDiagnosticKeys: strings(saved.migratedDiagnosticKeys)};
}

type IndexedAttempt = {attempt: ReviewAttempt; at: number};
type QuestionEvidence = {
  question: ReviewQuestion; activityKey: string; attempts: ReviewAttempt[];
  byId: Map<string, ReviewAttempt>; qualified: IndexedAttempt[];
};

/** Normalize each receipt once per reconciliation, including conflicting retries. */
function indexEvidence(question: ReviewQuestion): QuestionEvidence {
  const byId = new Map<string, IndexedAttempt & {allUnassisted: boolean; allCorrect: boolean}>();
  for (const source of question.attempts) {
    if (!source.id) continue;
    const at = time(source.at);
    if (!Number.isFinite(at)) continue;
    const saved = byId.get(source.id);
    if (!saved) {
      byId.set(source.id, {at, allUnassisted: source.assisted === false, allCorrect: source.outcome === true,
        attempt: {...source, valid: source.valid !== false, assisted: source.assisted === true ? true : source.assisted === false ? false : undefined,
          assistanceKnown: source.assistanceKnown === true, timedOut: source.timedOut === true,
          outcome: source.outcome === false ? false : source.outcome === true ? true : undefined}});
      continue;
    }
    if (at < saved.at) {saved.at = at; saved.attempt.at = source.at;}
    saved.allUnassisted = saved.allUnassisted && source.assisted === false;
    saved.allCorrect = saved.allCorrect && source.outcome === true;
    saved.attempt.valid = saved.attempt.valid !== false && source.valid !== false;
    saved.attempt.assisted = saved.attempt.assisted === true || source.assisted === true ? true : saved.allUnassisted ? false : undefined;
    saved.attempt.assistanceKnown = saved.attempt.assistanceKnown === true && source.assistanceKnown === true;
    saved.attempt.timedOut = saved.attempt.timedOut === true || source.timedOut === true;
    saved.attempt.outcome = saved.attempt.outcome === false || source.outcome === false ? false : saved.allCorrect ? true : undefined;
  }
  const sorted = [...byId.values()].sort((a, b) => a.at - b.at || a.attempt.id.localeCompare(b.attempt.id));
  return {question, activityKey: JSON.stringify([...question.activityIds].sort()), attempts: sorted.map(item => item.attempt),
    byId: new Map(sorted.map(item => [item.attempt.id, item.attempt])), qualified: sorted.filter(item => qualifies(item.attempt))};
}

/** This cache belongs to one reconciliation; later source corrections rebuild it. */
function evidenceIndex(questions: ReviewQuestion[]) {
  const byQuestion = new Map<ReviewQuestion, QuestionEvidence>();
  const evidence = (question: ReviewQuestion) => {
    let indexed = byQuestion.get(question);
    if (!indexed) {indexed = indexEvidence(question); byQuestion.set(question, indexed);}
    return indexed;
  };
  return {evidence, byKey: new Map(questions.map(question => [reviewQuestionKey(question), evidence(question)]))};
}

function studentEpisodes(requests: ReviewRequest[]) {
  const counts = new Map<string, number>();
  for (const request of requests) if (request.origin === 'student') {
    const key = JSON.stringify([request.diagnosticKey, request.selectionKey]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function scopedQuestions(questions: ReviewQuestion[], targetId: string, diagnostic: Diagnostic): ReviewQuestion[] {
  // Mixed/unknown source snapshots cannot safely identify a common-question revision.
  if (!['personal', 'common'].includes(diagnostic.sourceType) || diagnostic.sourceVersion === null || diagnostic.sourceVersion === '' || !Number.isFinite(Number(diagnostic.sourceVersion))) return [];
  return questions.filter(question => question.targetId === targetId
    && (typeof diagnostic.targetKey !== 'string' || diagnostic.targetKey === question.targetKey)
    && question.sourceType === diagnostic.sourceType && question.sourceVersion === Number(diagnostic.sourceVersion));
}

function selectQuestions(questions: ReviewQuestion[], selectionKey: string, diagnostic: Diagnostic): ReviewQuestion[] {
  if (selectionKey.startsWith('question:')) return questions.filter(question => question.id === selectionKey.slice(9));
  const category = selectionKey.slice(9), answered = new Set(strings(diagnostic.questionIds || diagnostic.answeredQuestionIds));
  return questions.filter(question => question.category === category)
    .sort((a, b) => Number(answered.has(b.id)) - Number(answered.has(a.id)) || reviewQuestionKey(a).localeCompare(reviewQuestionKey(b)))
    .slice(0, 2);
}

function selectedKeys(diagnostic: Diagnostic): string[] {
  return [...strings(diagnostic.needsReviewQuestionIds).map(id => 'question:' + id),
    ...strings(diagnostic.focusCategories).filter(category => categories.includes(category as ReviewCategory)).map(category => 'category:' + category)];
}

function studentRequest(input: {episodes: Map<string, number>; evidence: (question: ReviewQuestion) => QuestionEvidence; targetId: string; diagnostic: Diagnostic; questions: ReviewQuestion[]; selectionKey: string; now: string; legacy: boolean}): ReviewRequest {
  const key = diagnosticKey(input.targetId, input.diagnostic), selected = selectQuestions(input.questions, input.selectionKey, input.diagnostic);
  const episodeKey = JSON.stringify([key, input.selectionKey]), episode = (input.episodes.get(episodeKey) || 0) + 1;
  input.episodes.set(episodeKey, episode);
  const scopes = selected.map(({attempts: _, category: __, ...scope}) => ({...scope, activityIds: [...scope.activityIds]}));
  return {
    id: JSON.stringify(['student-review', key, input.selectionKey, episode]), origin: 'student', diagnosticKey: key, selectionKey: input.selectionKey,
    questionKeys: selected.map(reviewQuestionKey), scopes, requestedAt: input.legacy ? null : input.now,
    ...(input.legacy ? {migratedAt: input.now} : {}),
    baselineEvidenceIds: unique(selected.flatMap(question => input.evidence(question).attempts.filter(attempt => attempt.valid !== false).map(attempt => attempt.id))),
    status: selected.length ? 'active' : 'out_of_scope', resolvedEvidenceIds: [], resolvedAt: null,
    reason: input.selectionKey.startsWith('category:') ? '선택한 영역의 재확인 과제예요.' : '직접 다시 확인할 질문으로 선택했어요.',
    scopeSnapshot: {targetId: input.targetId, targetKey: input.diagnostic.targetKey, targetSnapshot: canonical(input.diagnostic.targetSnapshot), sourceType: input.diagnostic.sourceType, sourceVersion: input.diagnostic.sourceVersion},
  };
}

function qualifies(attempt: ReviewAttempt): boolean {
  if (attempt.valid === false || attempt.assistanceKnown !== true || attempt.assisted !== false || attempt.timedOut === true || attempt.outcome === false) return false;
  return attempt.kind === 'quiz_response' || attempt.kind === 'memory_review' || attempt.kind === 'assignment_submission' ? attempt.outcome === true : true;
}

/** Recompute from original facts each time, including previously resolved requests. */
function assess(request: ReviewRequest, questions: Map<string, QuestionEvidence>): ReviewRequest {
  const noResolution = {resolvedEvidenceIds: [], resolvedQuestionKeys: [], resolvedEvidenceByQuestion: {}, resolvedAt: null};
  if (request.origin === 'student' && request.status === 'dismissed') return {...request, ...noResolution};
  if (!request.questionKeys.length || request.questionKeys.some(key => !questions.has(key))) return {...request, ...noResolution, status: 'out_of_scope'};
  if (request.scopes.some(scope => {
    const current = questions.get(reviewQuestionKey(scope));
    return !current || JSON.stringify([...scope.activityIds].sort()) !== current.activityKey;
  })) return {...request, ...noResolution, status: 'out_of_scope'};
  if (request.origin === 'automatic') {
    const trigger = questions.get(request.questionKeys[0])!.byId.get(request.triggerEvidenceId!);
    if (!trigger || trigger.valid === false || !(trigger.assisted === true || trigger.timedOut === true || trigger.outcome === false)) return {...request, ...noResolution, status: 'withdrawn'};
  }
  const after = time(request.requestedAt ?? request.migratedAt), baseline = new Set(request.baselineEvidenceIds);
  const selected = new Map<string, ReviewAttempt>();
  const resolvedEvidenceByQuestion: Record<string, string> = {};
  let resolvedAt: string | null = null, latestTime = -Infinity;
  for (const key of request.questionKeys) {
    if (!Number.isFinite(after)) continue;
    const qualified = questions.get(key)!.qualified;
    // The first qualified attempt strictly after the request, in the original
    // time/receipt order. Baseline and cross-question reuse exclusions still apply.
    let low = 0, high = qualified.length;
    while (low < high) {const middle = (low + high) >>> 1; if (qualified[middle].at <= after) low = middle + 1; else high = middle;}
    for (let index = low; index < qualified.length; index++) {
      const {attempt: evidence, at} = qualified[index];
      if (baseline.has(evidence.id) || selected.has(evidence.id)) continue;
      selected.set(evidence.id, evidence); resolvedEvidenceByQuestion[key] = evidence.id;
      if (at > latestTime) {latestTime = at; resolvedAt = evidence.at;}
      break;
    }
  }
  const resolved = selected.size === request.questionKeys.length;
  return {...request, status: resolved ? 'resolved' : 'active', resolvedEvidenceIds: [...selected.keys()],
    resolvedQuestionKeys: Object.keys(resolvedEvidenceByQuestion), resolvedEvidenceByQuestion,
    resolvedAt: resolved ? resolvedAt : null};
}

export function reconcileTrainingReviews(input: ReconcileInput): {state: ReviewState; questions: ReviewQuestionStatus[]} {
  const state = readState(input.state), {evidence, byKey} = evidenceIndex(input.questions), episodes = studentEpisodes(state.requests);
  const requestIds = new Set(state.requests.map(request => request.id)), migratedKeys = new Set(state.migratedDiagnosticKeys);
  for (const [targetId, diagnostic] of Object.entries(input.diagnostics).sort(([a], [b]) => a.localeCompare(b))) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const key = diagnosticKey(targetId, diagnostic);
    if (migratedKeys.has(key)) continue;
    if (diagnostic.reviewSchemaVersion !== 1) {
      const scoped = scopedQuestions(input.questions, targetId, diagnostic);
      for (const selectionKey of selectedKeys(diagnostic)) {
        const request = studentRequest({episodes, evidence, targetId, diagnostic, questions: scoped, selectionKey, now: input.now, legacy: true});
        state.requests.push(request); requestIds.add(request.id);
      }
    }
    state.migratedDiagnosticKeys.push(key);
    migratedKeys.add(key);
  }
  for (const question of input.questions) {
    const questionKey = reviewQuestionKey(question);
    for (const attempt of evidence(question).attempts) {
      if (attempt.valid === false || !(attempt.assisted === true || attempt.timedOut === true || attempt.outcome === false)) continue;
      const id = JSON.stringify(['automatic-review', questionKey, attempt.id]);
      if (requestIds.has(id)) continue;
      const {attempts: _, category: __, ...scope} = question;
      state.requests.push({id, origin: 'automatic', selectionKey: 'receipt:' + attempt.id, questionKeys: [questionKey], scopes: [{...scope, activityIds: [...scope.activityIds]}],
        requestedAt: attempt.at, baselineEvidenceIds: [attempt.id], status: 'active', resolvedEvidenceIds: [], resolvedAt: null, triggerEvidenceId: attempt.id,
        reason: attempt.assisted ? '도움 없이 다시 답할 과제예요.' : attempt.timedOut ? '시간 안에 다시 답할 과제예요.' : '개념을 다시 확인할 과제예요.'});
      requestIds.add(id);
    }
  }
  state.requests = state.requests.map(request => assess(request, byKey));
  const matchingByQuestion = new Map<string, ReviewRequest[]>();
  for (const request of state.requests) if (request.status === 'active' || request.status === 'resolved') {
    for (const key of new Set(request.questionKeys)) {
      const matching = matchingByQuestion.get(key);
      if (matching) matching.push(request); else matchingByQuestion.set(key, [request]);
    }
  }
  return {state, questions: input.questions.map(question => {
    const questionKey = reviewQuestionKey(question), matching = matchingByQuestion.get(questionKey) || [];
    const active = matching.filter(request => request.status === 'active' && !request.resolvedQuestionKeys?.includes(questionKey)), relevant = active.length ? active : matching;
    return {questionKey, targetId: question.targetId, questionId: question.id, sourceType: question.sourceType, sourceVersion: question.sourceVersion,
      activityIds: [...question.activityIds], status: active.length ? 'active' : matching.length ? 'resolved' : 'clear', needsReview: !!active.length,
      requestIds: relevant.map(request => request.id), resolvedEvidenceIds: unique(relevant.flatMap(request => request.resolvedEvidenceByQuestion?.[questionKey] ? [request.resolvedEvidenceByQuestion[questionKey]] : [])),
      reason: active.length ? active[0].reason : matching.length ? '재확인 과제를 마쳤어요. 다음 복습에서 다시 확인해요.' : '',
      requestedAtUnknown: active.some(request => request.requestedAt === null)};
  })};
}

export function applyReviewReflection(input: {state?: unknown; questions: ReviewQuestion[]; targetId: string; diagnostic: Diagnostic; needsReviewQuestionIds: string[]; focusCategories: ReviewCategory[]; now: string}): ReviewState {
  const diagnostics = {[input.targetId]: input.diagnostic};
  const state = reconcileTrainingReviews({...input, diagnostics}).state, key = diagnosticKey(input.targetId, input.diagnostic);
  const scoped = scopedQuestions(input.questions, input.targetId, input.diagnostic);
  const currentScopes = new Map(scoped.map(question => [reviewQuestionKey(question), question]));
  const selections = new Set(selectedKeys({needsReviewQuestionIds: input.needsReviewQuestionIds, focusCategories: input.focusCategories}));
  for (const request of state.requests) {
    if (request.origin === 'student' && request.diagnosticKey === key && !selections.has(request.selectionKey)) request.status = 'dismissed';
    // Saving a new reflection replaces earlier student selections in this exact current scope.
    // Merely linking a new diagnosis never clears unfinished work or automatic evidence requests.
    if (request.origin === 'student' && !request.diagnosticKey?.startsWith('daily:') && request.diagnosticKey !== key && request.status !== 'dismissed'
      && request.questionKeys.length > 0 && request.questionKeys.every(questionKey => currentScopes.has(questionKey))
      && request.scopes.every(scope => {
        const current = currentScopes.get(reviewQuestionKey(scope));
        return current && JSON.stringify([...scope.activityIds].sort()) === JSON.stringify([...current.activityIds].sort());
      })) request.status = 'dismissed';
  }
  const episodes = studentEpisodes(state.requests), {evidence} = evidenceIndex(scoped);
  const existingSelections = new Set(state.requests.filter(request => request.origin === 'student' && request.diagnosticKey === key && request.status !== 'dismissed').map(request => request.selectionKey));
  for (const selectionKey of selections) {
    if (existingSelections.has(selectionKey)) continue;
    state.requests.push(studentRequest({episodes, evidence, targetId: input.targetId, diagnostic: input.diagnostic, questions: scoped, selectionKey, now: input.now, legacy: false}));
    existingSelections.add(selectionKey);
  }
  return reconcileTrainingReviews({state, questions: input.questions, diagnostics: {[input.targetId]: {...input.diagnostic, reviewSchemaVersion: 1}}, now: input.now}).state;
}
