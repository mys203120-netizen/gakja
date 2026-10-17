import test from 'node:test';
import assert from 'node:assert/strict';
import { searchStudentMaterials } from '../apps/web/src/lib/material-search';

const learning = {
  activities: [{ id: 'shared', title: '미세 플라스틱 실험' }, { id: 'source/a b', title: 'DNA   탐구' }],
  questions: [{ id: 'shared', prompt: '미세 플라스틱의 영향은?', support_target_ids: ['uos'] }, { id: 'other', prompt: '미세 플라스틱 정책은?', support_target_ids: ['other'] }, { id: 'common', prompt: '미세 플라스틱 문제를 어떻게 보나요?', support_target_ids: [] }],
};
test('search retains student activities and only current-target or common questions', () => {
  const before = JSON.stringify(learning);
  assert.deepEqual(searchStudentMaterials(learning, '미세 플라스틱', 'uos').map(item => item.key), ['activity:shared', 'question:shared', 'question:common']);
  assert.deepEqual(searchStudentMaterials(learning, '미세 플라스틱', 'other').map(item => item.key), ['activity:shared', 'question:other', 'question:common']);
  assert.equal(JSON.stringify(learning), before);
});
test('query normalization accepts case, compatibility forms, and repeated whitespace', () => {
  const result = searchStudentMaterials(learning, '  ｄｎａ \n 탐구  ', 'uos');
  assert.equal(result.length, 1);
  assert.equal(result[0].href, '/materials/activities/source%2Fa%20b');
});
test('zero matches and blank searches produce a true empty result', () => {
  assert.deepEqual(searchStudentMaterials(learning, '없는 질문', 'uos'), []);
  assert.deepEqual(searchStudentMaterials(learning, ' \n '), []);
  assert.deepEqual(searchStudentMaterials(undefined, '활동'), []);
});
test('without a selected target the search can expose all available question routes', () => {
  assert.equal(searchStudentMaterials(learning, '미세 플라스틱').length, 4);
  assert.deepEqual(searchStudentMaterials({ activities: [{ id: 'bad' }, { title: '제목' }], questions: [] }, '제목'), []);
});
