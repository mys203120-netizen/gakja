import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevelopmentFixture } from '../lib/w0/development-fixtures';
import { scopeW0Model, type W0Status } from '../lib/w0/view-model';
import { canEditExampleMemo, isMemoDirty, memoDraftReducer, readPreviewMemoDraft, storePreviewMemoDraft } from '../lib/w0/memo-draft';

test('memo editing requires existing example guide content in the selected target', () => {
  const fixture = createDevelopmentFixture('ready', 'test');
  assert.ok(fixture);
  const first = scopeW0Model(fixture, 'example-target-a');
  assert.equal(canEditExampleMemo(first, 'example-target-a'), true);
  assert.equal(canEditExampleMemo({ ...first, status: 'review_required' }, 'example-target-a'), true);
  assert.equal(canEditExampleMemo(first, 'example-target-b'), false);
  assert.equal(canEditExampleMemo(scopeW0Model(fixture, 'example-target-b'), 'example-target-b'), false);
  assert.equal(canEditExampleMemo({ ...first, isExample: false }, 'example-target-a'), false);
  assert.equal(canEditExampleMemo({ ...first, contentTargetId: undefined }, 'example-target-a'), false);
  assert.equal(canEditExampleMemo({ ...first, strategy: null, activities: [], questionPreview: undefined }, 'example-target-a'), false);
});

test('hidden and unavailable states cannot activate an unsaved-memo navigation guard', () => {
  const fixture = createDevelopmentFixture('ready', 'test');
  assert.ok(fixture);
  const editing = memoDraftReducer(readPreviewMemoDraft('hidden-state-target'), { type: 'edit' });
  const dirty = memoDraftReducer(editing, { type: 'change', value: '일시적으로 숨겨도 보존할 초안' });
  const ready = scopeW0Model(fixture, 'example-target-a');
  assert.equal(isMemoDirty(dirty, canEditExampleMemo(ready, 'example-target-a')), true);
  for (const status of ['error', 'pending', 'forbidden', 'empty', 'disconnected', 'loading'] as W0Status[]) {
    const unavailable = { ...ready, status };
    assert.equal(canEditExampleMemo(unavailable, 'example-target-a'), false, status);
    assert.equal(isMemoDirty(dirty, canEditExampleMemo(unavailable, 'example-target-a')), false, status);
  }
  assert.equal(dirty.draft, '일시적으로 숨겨도 보존할 초안');
  assert.equal(isMemoDirty(dirty, canEditExampleMemo(ready, 'example-target-a')), true);
});

test('memo draft and saved text remain separate through save, cancel, and client navigation', () => {
  const target = 'memo-navigation-target';
  let state = memoDraftReducer(readPreviewMemoDraft(target), { type: 'edit' });
  state = memoDraftReducer(state, { type: 'change', value: '저장한 메모\n둘째 줄' });
  state = memoDraftReducer(state, { type: 'save' });
  state = memoDraftReducer(state, { type: 'edit' });
  state = memoDraftReducer(state, { type: 'change', value: '아직 저장하지 않은 메모' });
  storePreviewMemoDraft(target, state);
  const restored = readPreviewMemoDraft(target);
  assert.deepEqual(restored, state);
  assert.equal(restored.saved, '저장한 메모\n둘째 줄');
  assert.equal(isMemoDirty(restored, true), true);
  const discarded = memoDraftReducer(restored, { type: 'cancel' });
  storePreviewMemoDraft(target, discarded);
  const afterNavigation = readPreviewMemoDraft(target);
  assert.equal(afterNavigation.draft, '저장한 메모\n둘째 줄');
  assert.equal(afterNavigation.saved, '저장한 메모\n둘째 줄');
  assert.equal(afterNavigation.editing, false);
  assert.equal(isMemoDirty(afterNavigation, true), false);
});

test('memo cache has strict target separation and returns independent state objects', () => {
  const first = memoDraftReducer(readPreviewMemoDraft('memo-scope-a'), { type: 'edit' });
  const changed = memoDraftReducer(first, { type: 'change', value: 'A의 메모' });
  storePreviewMemoDraft('memo-scope-a', changed);
  changed.draft = '외부 변경';
  assert.equal(readPreviewMemoDraft('memo-scope-a').draft, 'A의 메모');
  assert.deepEqual(readPreviewMemoDraft('memo-scope-b'), { saved: '', draft: '', editing: false });
  const restored = readPreviewMemoDraft('memo-scope-a');
  restored.saved = '다른 외부 변경';
  assert.equal(readPreviewMemoDraft('memo-scope-a').saved, '');
  assert.equal(isMemoDirty({ saved: '', draft: '', editing: true }, true), false);
});
