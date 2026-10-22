import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_CONSENT_MAX_AGE, analyticsConfigured, analyticsConsent, analyticsScreen, consentGrantedAt, safeConversionReceipt } from '../apps/web/src/lib/analytics-model';

test('analytics requires production, a real-shaped measurement ID, and confirmed manual measurement setup', () => {
  const setup = { mode: 'production', measurementId: 'G-ABC123', manualMeasurementConfirmed: 'true' };
  assert.equal(analyticsConfigured(setup), true);
  for (const invalid of [{ mode: 'development' }, { mode: 'test' }, { measurementId: '' }, { measurementId: 'G-<script>' }, { manualMeasurementConfirmed: 'false' }, { manualMeasurementConfirmed: undefined }]) {
    assert.equal(analyticsConfigured({ ...setup, ...invalid }), false);
  }
});

test('screen mapping drops identities, query strings, fragments, and user-provided page titles', () => {
  for (const path of ['/interview/student-name/room-id?email=student@example.com#answer', '/interview/another-id']) {
    assert.deepEqual(analyticsScreen(path), { path: '/interview', title: '모의면접' });
  }
  assert.deepEqual(analyticsScreen('/records/홍길동'), { path: '/records', title: '내 기록' });
  assert.deepEqual(analyticsScreen('/contact?message=개인정보'), { path: '/contact', title: '문의' });
  assert.deepEqual(analyticsScreen('/my/today/'), { path: '/my/today', title: '오늘 훈련' });
});

test('auth, password reset, admin, API, unknown routes and external URLs cannot be measured', () => {
  for (const path of ['/login', '/signup', '/invite', '/reset-password?token=secret', '/auth/callback?code=secret', '/api/auth/callback/google', '/api/analytics/conversions', '/admin/student-id', '/unknown/student-name', '//evil.example/my', 'https://example.com/my', null, undefined]) {
    assert.equal(analyticsScreen(path), null, String(path));
  }
});

test('consent defaults off and expired, malformed or future grants do not enable analytics', () => {
  const now = 1792627200000;
  assert.equal(analyticsConsent(undefined, now), 'unset');
  assert.equal(analyticsConsent('denied', now), 'denied');
  assert.equal(analyticsConsent(`granted.${now - 1}`, now), 'granted');
  assert.equal(consentGrantedAt(`granted.${now - 1}`, now), now - 1);
  for (const consent of ['granted', 'true', `granted.${now + 1}`, `granted.${now - ANALYTICS_CONSENT_MAX_AGE * 1000}`, 'granted.0', 'granted.NaN']) {
    assert.equal(consentGrantedAt(consent, now), null);
  }
});

test('verified receipt mapping strips all extra data and permits only known conversion enums', () => {
  assert.deepEqual(safeConversionReceipt({ name: 'sign_up', method: 'google', email: 'private@example.com', userId: 'private-id' }), { name: 'sign_up', method: 'google' });
  assert.deepEqual(safeConversionReceipt({ name: 'first_answer_saved', answer: 'private answer', method: 'private' }), { name: 'first_answer_saved' });
  assert.deepEqual(safeConversionReceipt({ name: 'interview_completed', report: 'private report' }), { name: 'interview_completed' });
  for (const value of [null, {}, { name: 'cta_start_click' }, { name: 'sign_up', method: 'student@example.com' }, { name: 'arbitrary' }]) assert.equal(safeConversionReceipt(value), null);
});
