import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeCoreModel, runtimeFactReviewModel } from '../server/providers/realtime-model';

test('realtime core and fact-review overrides do not change offline bank generation settings', () => {
  const environment = { OPENAI_QUESTION_MODEL: 'offline-model', OPENAI_REALTIME_MODEL: 'core-model', OPENAI_REVIEW_MODEL: 'review-model' };
  const before = JSON.stringify(environment);
  assert.equal(realtimeCoreModel(environment), 'core-model');
  assert.equal(runtimeFactReviewModel(environment), 'review-model');
  assert.equal(JSON.stringify(environment), before);
  assert.equal(environment.OPENAI_QUESTION_MODEL, 'offline-model');
});

test('unset or blank per-stage models retain the existing question-model fallback', () => {
  assert.equal(realtimeCoreModel({ OPENAI_QUESTION_MODEL: 'old-model', OPENAI_REALTIME_MODEL: ' ' }), 'old-model');
  assert.equal(runtimeFactReviewModel({ OPENAI_QUESTION_MODEL: 'old-model', OPENAI_REVIEW_MODEL: '' }), 'old-model');
  assert.equal(realtimeCoreModel({}), 'gpt-6-luna');
});
