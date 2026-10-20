import test from 'node:test';
import assert from 'node:assert/strict';
import {applyReviewReflection, reconcileTrainingReviews, reviewQuestionKey, type ReviewAttempt, type ReviewQuestion, type ReviewState} from '../apps/web/src/lib/training-review';

const now = '2026-10-21T01:00:00.000Z';
const later = '2026-10-21T02:00:00.000Z';
const end = '2026-10-21T03:00:00.000Z';
const attempt = (id: string, at = later, overrides: Partial<ReviewAttempt> = {}): ReviewAttempt => ({id, at, assisted: false, assistanceKnown: true, kind: 'interview_answer', ...overrides});
const question = (id = 'q1', overrides: Partial<ReviewQuestion> = {}): ReviewQuestion => ({id, targetId: 'school-a', targetKey: 'school-a-major-a-2027', sourceType: 'personal', sourceVersion: 1, activityIds: ['activity-a'], category: 'major', attempts: [], ...overrides});
const diagnostic = (overrides: Record<string, unknown> = {}) => ({sessionId: 'diagnostic-1', sourceType: 'personal', sourceVersion: 1, targetKey: 'school-a-major-a-2027', targetSnapshot: {university: 'a', department: 'a'}, focusCategories: [], needsReviewQuestionIds: [], ...overrides});
const reconcile = (questions: ReviewQuestion[], state?: ReviewState, diag = diagnostic(), at = end) => reconcileTrainingReviews({state, questions, diagnostics: {'school-a': diag}, now: at});
const request = (questions: ReviewQuestion[], overrides: Partial<Parameters<typeof applyReviewReflection>[0]> = {}) => applyReviewReflection({questions, targetId: 'school-a', diagnostic: diagnostic({reviewSchemaVersion: 1}), needsReviewQuestionIds: ['q1'], focusCategories: [], now, ...overrides});
const students = (state: ReviewState) => state.requests.filter(item => item.origin === 'student');

test('legacy requests retain unknown request date and require new evidence after migration', () => {
  const old = question('q1', {attempts: [attempt('old', '2026-10-20T01:00:00.000Z')]});
  const diag = diagnostic({focusCategories: ['major']});
  const initial = reconcile([old], undefined, diag, now);
  assert.equal(students(initial.state).length, 1);
  assert.equal(students(initial.state)[0].requestedAt, null);
  assert.equal(students(initial.state)[0].migratedAt, now);
  assert.deepEqual(students(initial.state)[0].baselineEvidenceIds, ['old']);
  assert.equal(initial.questions[0].needsReview, true);
  assert.equal(initial.questions[0].requestedAtUnknown, true);
  const equalTime = reconcile([{...old, attempts: [...old.attempts, attempt('same-time', now)]}], initial.state, diag);
  assert.equal(equalTime.questions[0].needsReview, true);
  const complete = reconcile([{...old, attempts: [...old.attempts, attempt('new')]}], initial.state, diag);
  assert.equal(complete.questions[0].status, 'resolved');
  assert.deepEqual(complete.questions[0].resolvedEvidenceIds, ['new']);
  const repeated = reconcile([{...old, attempts: [...old.attempts, attempt('new')]}], complete.state, diag);
  assert.deepEqual(repeated.state, complete.state);
  assert.equal(students(repeated.state).length, 1);
});

test('legacy unmatched selections remain out of scope rather than silently disappearing', () => {
  for (const diag of [diagnostic({sourceVersion: 9}), diagnostic({targetKey: 'another-department'}), diagnostic({sourceType: 'mixed'}), diagnostic({sourceType: undefined, sourceVersion: undefined})]) {
    const result = reconcile([question()], undefined, {...diag, needsReviewQuestionIds: ['q1'], focusCategories: ['major']}, now);
    assert.equal(students(result.state).length, 2);
    assert.ok(students(result.state).every(item => item.status === 'out_of_scope' && item.requestedAt === null));
    assert.equal(result.questions[0].needsReview, false);
    assert.equal(reconcile([question()], result.state, {...diag, needsReviewQuestionIds: ['q1'], focusCategories: ['major']}).state.requests.length, 2);
  }
});

test('migrated arrays do not add weight after their finite exercise is resolved', () => {
  const diag = diagnostic({focusCategories: ['major']});
  const initial = reconcile([question()], undefined, diag, now);
  const complete = reconcile([question('q1', {attempts: [attempt('success')]})], initial.state, diag);
  assert.equal(complete.questions[0].needsReview, false);
  assert.equal(complete.state.requests.length, 1);
  assert.equal(complete.state.requests[0].status, 'resolved');
});

test('schema-one diagnostics never recreate legacy selections when their arrays are retained', () => {
  const result = reconcile([question()], undefined, diagnostic({reviewSchemaVersion: 1, focusCategories: ['major'], needsReviewQuestionIds: ['q1']}), now);
  assert.equal(result.state.requests.length, 0);
  assert.equal(result.questions[0].needsReview, false);
  assert.equal(result.state.migratedDiagnosticKeys.length, 1);
});

test('another school, changed application, source, version or activity cannot solve an old request', () => {
  const state = request([question()]);
  const other = question('q1', {targetId: 'school-b', targetKey: 'school-b-major-a-2027', attempts: [attempt('other')]});
  assert.equal(reconcile([question(), other], state).questions[0].needsReview, true);
  const changed: Array<Partial<ReviewQuestion>> = [{targetKey: 'school-a-major-b-2027'}, {sourceVersion: 2}, {sourceType: 'common'}, {activityIds: ['another-activity']}];
  for (const override of changed) {
    const result = reconcile([question('q1', {...override, attempts: [attempt('new')]})], state);
    assert.equal(students(result.state)[0].status, 'out_of_scope');
    assert.equal(result.questions[0].needsReview, false);
  }
  assert.notEqual(reviewQuestionKey(question()), reviewQuestionKey(other));
});

test('resolved evidence invalidation, removal, help correction and timeout reopen the request', () => {
  const state = request([question()]);
  const complete = reconcile([question('q1', {attempts: [attempt('success')]})], state);
  assert.equal(complete.questions[0].status, 'resolved');
  for (const attempts of [[], [attempt('success', later, {valid: false})], [attempt('success', later, {assisted: true})], [attempt('success', later, {timedOut: true})], [attempt('success', later, {assistanceKnown: false})]]) {
    const reopened = reconcile([question('q1', {attempts})], complete.state);
    assert.equal(students(reopened.state)[0].status, 'active');
    assert.equal(reopened.questions[0].needsReview, true);
    assert.deepEqual(students(reopened.state)[0].resolvedEvidenceIds, []);
    assert.equal(students(reopened.state)[0].resolvedAt, null);
  }
  const restored = reconcile([question('q1', {attempts: [attempt('success')]})], complete.state);
  assert.equal(restored.questions[0].status, 'resolved');
});

test('unknown help and incorrect knowledge checks cannot resolve recheck exercises', () => {
  const state = request([question()]);
  for (const answer of [attempt('unknown', later, {assistanceKnown: false}), attempt('missing', later, {assisted: undefined}), attempt('incorrect', later, {outcome: false}), attempt('quiz', later, {kind: 'quiz_response'}), attempt('memory', later, {kind: 'memory_review'})]) {
    assert.equal(reconcile([question('q1', {attempts: [answer]})], state).questions[0].needsReview, true);
  }
  assert.equal(reconcile([question('q1', {attempts: [attempt('quiz', later, {kind: 'quiz_response', outcome: true})]})], state).questions[0].status, 'resolved');
});

test('category recheck is bounded to two fixed questions and prioritizes answered diagnostic questions', () => {
  const questions = [question('q1'), question('q2'), question('q3'), question('q4')];
  const state = request(questions, {needsReviewQuestionIds: [], focusCategories: ['major'], diagnostic: diagnostic({reviewSchemaVersion: 1, questionIds: ['q3', 'q4']})});
  assert.deepEqual(students(state)[0].questionKeys, [reviewQuestionKey(questions[2]), reviewQuestionKey(questions[3])]);
  assert.equal(students(state)[0].questionKeys.length, 2);
  const one = reconcile(questions.map(q => ({...q, attempts: q.id === 'q3' ? [attempt('three')] : []})), state);
  assert.equal(students(one.state)[0].status, 'active');
  assert.deepEqual(students(one.state)[0].resolvedEvidenceIds, ['three']);
  assert.equal(one.questions.find(q => q.questionId === 'q3')?.status, 'resolved');
  assert.equal(one.questions.find(q => q.questionId === 'q4')?.status, 'active');
  assert.deepEqual(one.questions.find(q => q.questionId === 'q3')?.resolvedEvidenceIds, ['three']);
  assert.deepEqual(one.questions.find(q => q.questionId === 'q4')?.resolvedEvidenceIds, []);
  const both = reconcile(questions.map(q => ({...q, attempts: q.id === 'q3' ? [attempt('three')] : q.id === 'q4' ? [attempt('four')] : []})), one.state);
  assert.equal(students(both.state)[0].status, 'resolved');
  assert.ok(both.questions.every(q => !q.needsReview));
});

test('a resolved category exercise never expands to newly added questions', () => {
  const state = request([question()], {needsReviewQuestionIds: [], focusCategories: ['major']});
  const complete = reconcile([question('q1', {attempts: [attempt('first')]})], state);
  const expanded = reconcile([question('q1', {attempts: [attempt('first')]}), question('q2'), question('q3')], complete.state);
  assert.equal(students(expanded.state)[0].status, 'resolved');
  assert.equal(students(expanded.state)[0].questionKeys.length, 1);
  assert.ok(expanded.questions.every(q => !q.needsReview));
});

test('duplicate receipts do not increase exercise completion or create automatic requests twice', () => {
  const questions = [question('q1'), question('q2')];
  const state = request(questions, {needsReviewQuestionIds: [], focusCategories: ['major']});
  const shared = attempt('same-receipt');
  const duplicated = reconcile(questions.map(q => ({...q, attempts: [shared, shared]})), state);
  assert.equal(students(duplicated.state)[0].status, 'active');
  assert.deepEqual(students(duplicated.state)[0].resolvedEvidenceIds, ['same-receipt']);
  assert.equal(duplicated.questions.filter(q => q.needsReview).length, 1);
  const adverse = attempt('helped', now, {assisted: true});
  const automatic = reconcile([question('q1', {attempts: [adverse, adverse]})]);
  assert.equal(automatic.state.requests.length, 1);
  assert.equal(reconcile([question('q1', {attempts: [adverse, adverse]})], automatic.state).state.requests.length, 1);
});

test('conflicting copies of a receipt are conservative independent of array order', () => {
  const state = request([question()]);
  const good = attempt('conflict'), bad = attempt('conflict', later, {assisted: true});
  for (const attempts of [[good, bad], [bad, good], [good, {...good, valid: false}], [{...good, valid: false}, good]]) {
    assert.equal(students(reconcile([question('q1', {attempts})], state).state)[0].status, 'active');
  }
});

test('reflection save retries retain original request and resolved status; deselect and reselect creates a new episode', () => {
  const questions = [question()];
  const state = request(questions);
  assert.deepEqual(request(questions, {state, now: later}), state);
  const answered = [question('q1', {attempts: [attempt('success')]})];
  const complete = reconcile(answered, state).state;
  const repeat = request(answered, {state: complete, now: end});
  assert.equal(students(repeat).length, 1);
  assert.equal(students(repeat)[0].status, 'resolved');
  assert.equal(students(repeat)[0].requestedAt, now);
  const dismissed = request(answered, {state: repeat, needsReviewQuestionIds: [], now: end});
  assert.equal(students(dismissed)[0].status, 'dismissed');
  const selected = request(answered, {state: dismissed, now: end});
  assert.equal(students(selected).length, 2);
  assert.equal(students(selected)[1].status, 'active');
  assert.notEqual(students(selected)[0].id, students(selected)[1].id);
  assert.deepEqual(students(selected)[1].baselineEvidenceIds, ['success']);
});

test('saving a new diagnostic reflection replaces older manual selections only in the exact current scope', () => {
  const questions = [question()], state = request(questions);
  const nextDiagnostic = diagnostic({sessionId: 'diagnostic-2', reviewSchemaVersion: 1});
  const linkedOnly = reconcile(questions, state, nextDiagnostic);
  assert.equal(students(linkedOnly.state)[0].status, 'active');
  const cleared = request(questions, {state: linkedOnly.state, diagnostic: nextDiagnostic, needsReviewQuestionIds: [], now: later});
  assert.equal(students(cleared)[0].status, 'dismissed');
  assert.equal(reconcile(questions, cleared, nextDiagnostic).questions[0].needsReview, false);
  const previouslyResolved = reconcile([question('q1', {attempts: [attempt('old-success')]})], state).state;
  const explicitlyCleared = request([question('q1', {attempts: [attempt('old-success')]})], {state: previouslyResolved, diagnostic: nextDiagnostic, needsReviewQuestionIds: [], now: end});
  assert.equal(students(explicitlyCleared)[0].status, 'dismissed');
  assert.equal(reconcile(questions, explicitlyCleared, nextDiagnostic).questions[0].needsReview, false);

  const withAutomatic = reconcile([question('q1', {attempts: [attempt('help', now, {assisted: true})]})], state).state;
  const clearedManual = request([question('q1', {attempts: [attempt('help', now, {assisted: true})]})], {state: withAutomatic, diagnostic: nextDiagnostic, needsReviewQuestionIds: [], now: later});
  assert.equal(students(clearedManual)[0].status, 'dismissed');
  assert.equal(clearedManual.requests.find(item => item.origin === 'automatic')?.status, 'active');

  for (const override of [{targetKey: 'another-department'}, {sourceVersion: 2}, {sourceType: 'common' as const}]) {
    const changed = question('q1', override), diag = {...nextDiagnostic, targetKey: changed.targetKey, sourceType: changed.sourceType, sourceVersion: changed.sourceVersion};
    const unrelated = request([question(), changed], {state, diagnostic: diag, needsReviewQuestionIds: [], now: later});
    assert.equal(students(unrelated)[0].status, 'active');
  }
});

test('automatic adverse receipts resolve from later unaided records and reopen when that evidence changes', () => {
  const adverse = attempt('helped', now, {assisted: true}), success = attempt('success');
  const initial = reconcile([question('q1', {attempts: [adverse]})]);
  assert.equal(initial.questions[0].needsReview, true);
  const complete = reconcile([question('q1', {attempts: [adverse, success]})], initial.state);
  assert.equal(complete.questions[0].status, 'resolved');
  const repeat = reconcile([question('q1', {attempts: [adverse, success]})], complete.state);
  assert.deepEqual(repeat.state, complete.state);
  assert.equal(reconcile([question('q1', {attempts: [adverse]})], complete.state).questions[0].needsReview, true);
  const withdrawn = reconcile([question('q1', {attempts: [success]})], complete.state);
  assert.equal(withdrawn.state.requests[0].status, 'withdrawn');
  assert.equal(withdrawn.questions[0].needsReview, false);
  const corrected = reconcile([question('q1', {attempts: [{...adverse, assisted: false}, success]})], complete.state);
  assert.equal(corrected.state.requests[0].status, 'withdrawn');
});

test('an unaided answer before or at the adverse receipt cannot resolve it', () => {
  for (const at of ['2026-10-20T01:00:00.000Z', now]) {
    const result = reconcile([question('q1', {attempts: [attempt('good', at), attempt('bad', now, {outcome: false})]})]);
    assert.equal(result.questions[0].needsReview, true);
  }
});

test('source-version migration keys and snapshot identity are canonical and isolated', () => {
  const diag = diagnostic({needsReviewQuestionIds: ['q1'], targetSnapshot: {department: 'a', university: 'a'}});
  const state = reconcile([question()], undefined, diag, now).state;
  const reordered = reconcile([question()], state, diagnostic({needsReviewQuestionIds: ['q1'], targetSnapshot: {university: 'a', department: 'a'}}));
  assert.equal(students(reordered.state).length, 1);
  const newVersion = reconcile([question('q1', {sourceVersion: 2})], state, {...diag, sourceVersion: 2});
  assert.equal(students(newVersion.state).length, 2);
  assert.equal(students(newVersion.state)[0].status, 'out_of_scope');
  assert.equal(students(newVersion.state)[1].status, 'active');
});

test('reconciliation does not mutate the saved state or question evidence', () => {
  const questions = [question()], state = request(questions);
  const saved = JSON.stringify({state, questions});
  reconcile(questions, state);
  request(questions, {state, needsReviewQuestionIds: []});
  assert.equal(JSON.stringify({state, questions}), saved);
});
