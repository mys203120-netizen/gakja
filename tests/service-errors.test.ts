import test from 'node:test';
import assert from 'node:assert/strict';
import { publicServiceError, serviceDisplayMessage } from '../lib/interview/service-errors';
import { safeProviderError } from '../server/protocol';

test('provider diagnostics remain private while public copy contains neither the vendor nor transport details', () => {
  for (const detail of ['CLOVA Speech UNAVAILABLE: read ECONNRESET', 'CLOVA Voice 429: internal body', 'DEADLINE_EXCEEDED grpc endpoint:50051', '음성 연결 오류: CLOVA Speech 내부 응답']) {
    assert.equal(serviceDisplayMessage(detail), publicServiceError('speech'));
    assert.equal(safeProviderError(new Error(detail)), detail);
  }
  assert.equal(serviceDisplayMessage('INVALID_REACTION', 'question'), publicServiceError('question'));
  assert.equal(serviceDisplayMessage('401 OpenAI APIError sk-fake-secret', 'question'), publicServiceError('question'));
});

test('user guidance is useful, evaluation and storage messages stay distinct, and native failures are contained', () => {
  const permission = '마이크 권한을 허용한 뒤 다시 시도해 주세요.';
  assert.equal(serviceDisplayMessage(permission, 'speech'), permission);
  assert.equal(serviceDisplayMessage(new TypeError('Failed to fetch'), 'question'), publicServiceError('question'));
  assert.notEqual(publicServiceError('evaluation'), publicServiceError('storage'));
  assert.equal(serviceDisplayMessage('Unexpected provider internal trace'), publicServiceError('connection'));
});
