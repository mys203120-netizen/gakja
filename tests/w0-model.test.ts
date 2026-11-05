import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevelopmentFixture, fixtureScenarios } from '../lib/w0/development-fixtures';
import { createDisconnectedModel, evaluationLabel, interviewDateLabel, scopeW0Model } from '../lib/w0/view-model';
import { answerDraftReducer, createAnswerDraft, isAnswerDirty, previewAnswerDraftKey, readPreviewAnswerDraft, storePreviewAnswerDraft } from '../lib/w0/answer-draft';

test('an unconnected adapter has neither example account data nor simulated progress', () => {
  const model = createDisconnectedModel();
  assert.equal(model.status, 'disconnected');
  assert.equal(model.isExample, false);
  assert.deepEqual(model.targets, []);
  assert.deepEqual(model.sessions, []);
  assert.equal(model.tickets, null);
  assert.equal(model.practiceUntil, null);
  assert.equal(model.strategy, null);
  assert.equal(model.questionPreview, undefined);
});

test('fixtures fail closed in production and for unknown scenarios or environments', () => {
  for (const scenario of fixtureScenarios) {
    assert.equal(createDevelopmentFixture(scenario, 'production'), null);
    assert.equal(createDevelopmentFixture(scenario, ''), null);
    assert.equal(createDevelopmentFixture(scenario, 'staging'), null);
  }
  assert.equal(createDevelopmentFixture('typo', 'development'), null);
});

test('fixtures explicitly cover zero, one, many, and long target contexts', () => {
  assert.equal(createDevelopmentFixture('empty', 'development')?.targets.length, 0);
  assert.equal(createDevelopmentFixture('one-target', 'development')?.targets.length, 1);
  const multiple = createDevelopmentFixture('ready', 'development');
  assert.ok(multiple);
  assert.ok(multiple.targets.length > 1);
  assert.ok(multiple.isExample);
  const long = createDevelopmentFixture('long-target', 'development');
  assert.ok(long && long.targets[0].department.length > 20);
});

test('error and forbidden previews never replace failures with ready example data', () => {
  for (const scenario of ['error', 'forbidden', 'loading'] as const) {
    const model = createDevelopmentFixture(scenario, 'test');
    assert.equal(model?.status, scenario);
    assert.deepEqual(model?.sessions, []);
    assert.deepEqual(model?.targets, []);
    assert.equal(model?.strategy, null);
    assert.equal(model?.questionPreview, undefined);
  }
});

test('each fixture invocation owns its target and session objects', () => {
  const first = createDevelopmentFixture('ready', 'test');
  assert.ok(first);
  first.targets[0].university = 'changed';
  first.sessions.length = 0;
  const second = createDevelopmentFixture('ready', 'test');
  assert.ok(second);
  assert.equal(second.targets[0].university, '예시대학교');
  assert.equal(second.sessions.length, 2);
});

test('evaluation review suppresses stale scores and never turns null into zero', () => {
  assert.equal(evaluationLabel('review_required', null), '평가 검수 대기');
  assert.equal(evaluationLabel('review_required', 95), '평가 검수 대기');
  assert.equal(evaluationLabel('pending', 95), '평가 준비 중');
  assert.equal(evaluationLabel('ready', null), '평가 결과 확인 필요');
  assert.equal(evaluationLabel('ready', Number.NaN), '평가 결과 확인 필요');
  assert.equal(evaluationLabel('ready', 0), '0점');
  assert.equal(evaluationLabel('ready', 84), '84점');
  const review = createDevelopmentFixture('review_required', 'test');
  assert.ok(review?.sessions.length);
  assert.ok(review.sessions.every((session) => session.score === null));
});

test('unknown and invalid dates remain unconfirmed rather than D-Day zero', () => {
  assert.equal(interviewDateLabel(null), '미확정');
  assert.equal(interviewDateLabel(''), '미확정');
  assert.equal(interviewDateLabel('2026-02-30'), '미확정');
  assert.equal(interviewDateLabel('2026-13-02'), '미확정');
  assert.equal(interviewDateLabel('2026-11-21T00:00:00Z'), '미확정');
  assert.equal(interviewDateLabel('2026-11-21'), '2026.11.21');
  assert.equal(interviewDateLabel('2028-02-29'), '2028.02.29');
});

test('question preview data exists only in explicitly populated example scenarios', () => {
  for (const scenario of ['ready', 'one-target', 'long-target', 'review_required']) {
    const model = createDevelopmentFixture(scenario, 'development');
    assert.ok(model?.isExample && model.questionPreview);
    assert.match(model.questionPreview.source, /합성/);
  }
  for (const scenario of ['empty', 'loading', 'pending', 'error', 'forbidden']) {
    assert.equal(createDevelopmentFixture(scenario, 'development')?.questionPreview, undefined);
  }
});

test('answer drafts preserve text while editing and cancel restores the last local save', () => {
  const initial = createAnswerDraft('예상 답변');
  assert.equal(isAnswerDirty(initial), false);
  assert.equal(answerDraftReducer(initial, { type: 'change', value: '수정' }), initial);
  const editing = answerDraftReducer(initial, { type: 'edit' });
  const changed = answerDraftReducer(editing, { type: 'change', value: '  직접 수정한 예시\n두 번째 줄  ' });
  assert.equal(changed.savedAnswer, '예상 답변');
  assert.equal(isAnswerDirty(changed), true);
  const saved = answerDraftReducer(changed, { type: 'save' });
  assert.equal(saved.savedAnswer, '  직접 수정한 예시\n두 번째 줄  ');
  assert.equal(saved.hasSavedRevision, true);
  assert.equal(saved.editing, false);
  assert.equal(isAnswerDirty(saved), false);
  const secondDraft = answerDraftReducer(answerDraftReducer(saved, { type: 'edit' }), { type: 'change', value: '취소할 내용' });
  const cancelled = answerDraftReducer(secondDraft, { type: 'cancel' });
  assert.equal(cancelled.savedAnswer, saved.savedAnswer);
  assert.equal(cancelled.draftAnswer, saved.savedAnswer);
  assert.equal(cancelled.editing, false);
  assert.equal(isAnswerDirty(cancelled), false);
});

test('question save and unsave do not submit or erase an answer draft', () => {
  const editing = answerDraftReducer(createAnswerDraft('기본 예시'), { type: 'edit' });
  const changed = answerDraftReducer(editing, { type: 'change', value: '아직 저장하지 않은 답변' });
  const bookmarked = answerDraftReducer(changed, { type: 'toggle-question' });
  assert.equal(bookmarked.questionSaved, true);
  assert.equal(bookmarked.savedAnswer, '기본 예시');
  assert.equal(bookmarked.draftAnswer, changed.draftAnswer);
  assert.equal(isAnswerDirty(bookmarked), true);
  const unbookmarked = answerDraftReducer(bookmarked, { type: 'toggle-question' });
  assert.equal(unbookmarked.questionSaved, false);
  assert.equal(unbookmarked.draftAnswer, changed.draftAnswer);
  const saved = answerDraftReducer(bookmarked, { type: 'save' });
  assert.equal(saved.questionSaved, true);
  assert.equal(saved.savedAnswer, changed.draftAnswer);
});

test('blank drafts cannot replace a nonempty saved answer', () => {
  const changed = answerDraftReducer(answerDraftReducer(createAnswerDraft('보존할 답변'), { type: 'edit' }), { type: 'change', value: '  \n ' });
  assert.equal(answerDraftReducer(changed, { type: 'save' }), changed);
  assert.equal(changed.savedAnswer, '보존할 답변');
  assert.equal(changed.editing, true);
});

test('target selection projects scoped content without borrowing another target or merging sessions', () => {
  const model = createDevelopmentFixture('ready', 'test');
  assert.ok(model);
  const first = scopeW0Model(model, 'example-target-a');
  assert.equal(first.status, 'ready');
  assert.equal(first.strategy, model.strategy);
  assert.deepEqual(first.activities, model.activities);
  assert.equal(first.questionPreview, model.questionPreview);
  assert.equal(first.sessions.length, 2);
  assert.ok(first.sessions.every((session) => session.targetId === 'example-target-a'));
  const second = scopeW0Model(model, 'example-target-b');
  assert.equal(second.status, 'empty');
  assert.equal(second.strategy, null);
  assert.deepEqual(second.activities, []);
  assert.equal(second.questionPreview, undefined);
  assert.equal(second.contentTargetId, undefined);
  assert.deepEqual(second.sessions, []);
  assert.equal(second.targets, model.targets);
  assert.equal(second.tickets, model.tickets);
  assert.equal(second.practiceUntil, model.practiceUntil);
  assert.equal(model.sessions.length, 2);
  assert.ok(model.questionPreview);
});

test('unscoped content, sessions, and unknown targets fail closed in the presentation projection', () => {
  const model = createDevelopmentFixture('ready', 'test');
  assert.ok(model);
  const missingScopes = {
    ...model,
    contentTargetId: undefined,
    sessions: model.sessions.map((session) => ({ ...session, targetId: undefined })),
  };
  const projected = scopeW0Model(missingScopes, 'example-target-a');
  assert.equal(projected.strategy, null);
  assert.equal(projected.questionPreview, undefined);
  assert.deepEqual(projected.sessions, []);
  for (const targetId of [null, 'not-registered']) {
    const invalid = scopeW0Model(model, targetId);
    assert.equal(invalid.status, 'empty');
    assert.equal(invalid.questionPreview, undefined);
    assert.deepEqual(invalid.sessions, []);
  }
  const reviewed = createDevelopmentFixture('review_required', 'test');
  assert.ok(reviewed);
  assert.equal(scopeW0Model(reviewed, 'example-target-b').status, 'empty');
  assert.equal(scopeW0Model(reviewed, 'example-target-a').status, 'review_required');
  const disconnected = createDisconnectedModel();
  assert.equal(scopeW0Model(disconnected, null).status, 'disconnected');
});

test('navigation cache restores the exact unfinished answer and independent question save state', () => {
  const initialAnswer = '탐구 역할 예시';
  const key = previewAnswerDraftKey('nav-target-a', '역할을 설명해 주세요', initialAnswer);
  const editing = answerDraftReducer(readPreviewAnswerDraft(key, initialAnswer), { type: 'edit' });
  const changed = answerDraftReducer(editing, { type: 'change', value: '아직 저장하지 않은 초안\n둘째 줄  ' });
  const bookmarked = answerDraftReducer(changed, { type: 'toggle-question' });
  storePreviewAnswerDraft(key, bookmarked);
  const restored = readPreviewAnswerDraft(key, initialAnswer);
  assert.deepEqual(restored, bookmarked);
  assert.equal(restored.savedAnswer, initialAnswer);
  assert.equal(isAnswerDirty(restored), true);
  assert.equal(restored.editing, true);
  assert.equal(restored.questionSaved, true);
  const cancelled = answerDraftReducer(restored, { type: 'cancel' });
  assert.equal(cancelled.draftAnswer, initialAnswer);
  assert.equal(cancelled.questionSaved, true);
  storePreviewAnswerDraft(key, cancelled);
  assert.equal(isAnswerDirty(readPreviewAnswerDraft(key, initialAnswer)), false);
});

test('navigation cache separates target and question revisions and does not share mutable objects', () => {
  const keyA = previewAnswerDraftKey('cache-target-a', '질문', '기본 답변');
  const keyB = previewAnswerDraftKey('cache-target-b', '질문', '기본 답변');
  const revisionKey = previewAnswerDraftKey('cache-target-a', '질문', '새 기본 답변');
  const state = answerDraftReducer(createAnswerDraft('기본 답변'), { type: 'toggle-question' });
  storePreviewAnswerDraft(keyA, state);
  state.questionSaved = false;
  assert.equal(readPreviewAnswerDraft(keyA, '기본 답변').questionSaved, true);
  assert.equal(readPreviewAnswerDraft(keyB, '기본 답변').questionSaved, false);
  assert.equal(readPreviewAnswerDraft(revisionKey, '새 기본 답변').savedAnswer, '새 기본 답변');
  const restored = readPreviewAnswerDraft(keyA, '기본 답변');
  restored.savedAnswer = '외부 변경';
  assert.equal(readPreviewAnswerDraft(keyA, '기본 답변').savedAnswer, '기본 답변');
  assert.notEqual(previewAnswerDraftKey('a:b', 'c', 'd'), previewAnswerDraftKey('a', 'b:c', 'd'));
});

test('explicit discard before navigation cannot restore discarded text from the preview cache', () => {
  const initialAnswer = '최초 예시';
  const key = previewAnswerDraftKey('discard-target', '질문', initialAnswer);
  let state = answerDraftReducer(createAnswerDraft(initialAnswer), { type: 'edit' });
  state = answerDraftReducer(state, { type: 'change', value: '앞서 저장한 수정본' });
  state = answerDraftReducer(state, { type: 'save' });
  state = answerDraftReducer(state, { type: 'toggle-question' });
  state = answerDraftReducer(state, { type: 'edit' });
  state = answerDraftReducer(state, { type: 'change', value: '이동하면서 버릴 초안' });
  storePreviewAnswerDraft(key, state);
  // Mirrors the synchronous discard handler before navigation unmounts it.
  state = answerDraftReducer(state, { type: 'cancel' });
  storePreviewAnswerDraft(key, state);
  const restored = readPreviewAnswerDraft(key, initialAnswer);
  assert.equal(restored.savedAnswer, '앞서 저장한 수정본');
  assert.equal(restored.draftAnswer, '앞서 저장한 수정본');
  assert.equal(restored.editing, false);
  assert.equal(restored.questionSaved, true);
  assert.equal(isAnswerDirty(restored), false);
});
