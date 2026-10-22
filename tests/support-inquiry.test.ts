import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateInquiry, readInquiryBody } from '../apps/web/src/lib/support-inquiry';
import { supportConfig, privacyConfig } from '../apps/web/src/lib/support-config';
import { PRIVACY_POLICY_VERSION } from '../apps/web/src/lib/privacy-policy';

const valid = () => ({ email: 'Test@EXAMPLE.test ', type: 'privacy', content: '  합성 자료 삭제 요청  ', consent: true, policyVersion: PRIVACY_POLICY_VERSION, requestId: randomUUID() });
test('inquiry validates explicit current consent and canonicalizes only email/outer whitespace', () => {
  const result = validateInquiry(valid());
  assert.equal(result.email, 'test@example.test');
  assert.equal(result.content, '합성 자료 삭제 요청');
  for (const changes of [{ consent: false }, { consent: 'true' }, { policyVersion: 'old' }, { email: 'a\r\nb@example.test' }, { type: '__proto__' }, { content: ' ' }, { content: '가'.repeat(5001) }, { requestId: '../private' }, { website: 'bot.test' }]) assert.throws(() => validateInquiry({ ...valid(), ...changes }));
});
test('bounded inquiry body rejects streamed overflows, invalid encoding and malformed JSON', async () => {
  const request = (body: string) => new Request('http://localhost/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await readInquiryBody(request(JSON.stringify(valid()))) as {type: string}).type, 'privacy');
  await assert.rejects(readInquiryBody(request('x'.repeat(24001))), /너무 길/);
  await assert.rejects(readInquiryBody(request('{')), /확인/);
  await assert.rejects(readInquiryBody(new Request('http://localhost/contact', { method: 'POST', body: '{}' })), /JSON/);
});
test('production inquiry collection requires real operator, email, response and retention notices', () => {
  assert.equal(supportConfig({ NODE_ENV: 'production' }).available, false);
  assert.equal(supportConfig({ NODE_ENV: 'development' }).available, true);
  const env = { NODE_ENV: 'production', SITE_ORGANIZATION_NAME: 'Synthetic operator', SUPPORT_EMAIL: 'support@example.test', SUPPORT_RESPONSE_TIME: '합성 응답 안내', SUPPORT_RETENTION_NOTICE: '합성 보관 안내' } as NodeJS.ProcessEnv;
  assert.equal(supportConfig(env).available, true);
  assert.equal(privacyConfig(env).ready, false);
  assert.equal(privacyConfig({ ...env, PRIVACY_CONTACT_EMAIL: 'invalid' }).email, null);
  assert.equal(privacyConfig({ ...env, PRIVACY_OFFICER: '합성 담당자', PRIVACY_RETENTION_NOTICE: '합성 자료 보관 안내', PRIVACY_PROCESSORS_NOTICE: '합성 위탁 안내', PRIVACY_TRANSFERS_NOTICE: '합성 국외이전 안내' }).ready, true);
});
