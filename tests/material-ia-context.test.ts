import test from 'node:test';
import assert from 'node:assert/strict';
import { materialComparisonVersions, materialContextHref } from '../apps/web/src/lib/material-learning-flow';

const versions = [
  { id: 'current-first', target_id: 'uos', content_version: 6, source_type: 'personal' },
  { id: 'current-second', target_id: 'uos', content_version: 6, source_type: 'personal' },
  { id: 'old-book', target_id: 'uos', content_version: 5, source_type: 'personal' },
  { id: 'other-school', target_id: 'other', content_version: 6, source_type: 'personal' },
  { id: 'no-school', content_version: 6, source_type: 'personal' },
  { id: 'unknown-book', target_id: 'uos', source_type: 'personal' },
  { id: 'school-question', target_id: 'uos', content_version: 99, common_revision: 6, source_type: 'verified_past' },
  { id: 'old-school-question', target_id: 'uos', content_version: 6, common_revision: 5, source_type: 'common' },
];

test('material handoffs retain question, source namespace, publication and selected target', () => {
  const context = { questionId: 'q/한 글', targetId: '학교 & 전형', sourceVersion: 6 };
  for (const path of ['/on', '/records/comparisons'] as const) {
    const url = new URL(materialContextHref(path, context), 'http://localhost');
    assert.equal(url.pathname, path);
    assert.deepEqual(Object.fromEntries(url.searchParams), { sourceType: 'personal', questionId: context.questionId, targetId: context.targetId, sourceVersion: '6' });
  }
  assert.equal(new URL(materialContextHref('/on', { activityId: 'activity/a', sourceVersion: 6 }), 'http://localhost').searchParams.get('activityId'), 'activity/a');
});

test('an incomplete current material link never invents a school or publication', () => {
  for (const sourceVersion of [undefined, 0, -1, NaN, 1.5]) {
    const query = new URL(materialContextHref('/on', { questionId: 'q1', sourceVersion }), 'http://localhost').searchParams;
    assert.equal(query.has('targetId'), false);
    assert.equal(query.has('sourceVersion'), false);
  }
});

test('a scoped personal comparison cannot borrow old books, another school, common questions or unknown provenance', () => {
  const original = JSON.stringify(versions);
  assert.deepEqual(materialComparisonVersions(versions, { targetId: 'uos', sourceType: 'personal', sourceVersion: '6' }).map(v => v.id), ['current-first', 'current-second']);
  assert.equal(JSON.stringify(versions), original);
  assert.deepEqual(materialComparisonVersions(versions, { targetId: 'missing', sourceType: 'personal', sourceVersion: '6' }), []);
});

test('school-question revision is independent of the personal guidebook version', () => {
  assert.deepEqual(materialComparisonVersions(versions, { targetId: 'uos', sourceType: 'common', sourceVersion: '6' }).map(v => v.id), ['school-question']);
  assert.deepEqual(materialComparisonVersions(versions, { targetId: 'uos', sourceType: 'common', sourceVersion: '5' }).map(v => v.id), ['old-school-question']);
});

test('unscoped history remains available while invalid explicit context produces an honest empty result', () => {
  assert.deepEqual(materialComparisonVersions(versions, {}), versions);
  for (const sourceVersion of ['0', '-1', 'NaN', '1.5', 'Infinity']) assert.deepEqual(materialComparisonVersions(versions, { sourceVersion }), []);
  assert.deepEqual(materialComparisonVersions(versions, { sourceType: 'unsupported' }), []);
});
