import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, personalDate, safeSourceURL, scheduleChanged, scheduleLabel, validateDateOnly, validateKSTDateTime } from '../apps/web/src/lib/schedule.ts';

test('school-wide period never becomes a personal interview date or D-day', () => {
  const target = { interview_date: '2026-11-01', schedule: { period_start: '2026-11-01', period_end: '2026-11-03', personal_at: null, personal_date: null } };
  assert.equal(personalDate(target), null);
  assert.equal(scheduleLabel(target), '11월 1일–11월 3일');
});

test('confirmed personal day remains distinct from a confirmed clock time', () => {
  assert.equal(personalDate({ schedule: { personal_date: '2026-11-02' } }), '2026-11-02');
  assert.equal(scheduleLabel({ schedule: { personal_date: '2026-11-02' } }), '11월 2일 · 시간 발표 대기');
  assert.equal(scheduleLabel({ interview_date: '2026-11-02' }), '11월 2일 · 시간 발표 대기');
});

test('absolute timestamps and datetime-local fields normalize to KST without using the machine timezone', () => {
  assert.equal(validateKSTDateTime('2026-11-02T00:30:00.000Z'), '2026-11-02T09:30:00+09:00');
  assert.equal(validateKSTDateTime('2026-11-02T09:30'), '2026-11-02T09:30:00+09:00');
  assert.equal(validateKSTDateTime('2026-11-01T23:30:00Z'), '2026-11-02T08:30:00+09:00');
  assert.throws(() => validateKSTDateTime('2026-11-02T25:00'));
  assert.throws(() => validateKSTDateTime('2026-02-30T10:00:00Z'));
  assert.throws(() => validateDateOnly('2026-02-29'));
});

test('schedule validation keeps individual date, school period and review provenance consistent', () => {
  assert.throws(() => normalizeSchedule({ period_start: '2026-11-03', period_end: '2026-11-01' }));
  assert.throws(() => normalizeSchedule({ period_start: '2026-11-03', personal_date: '2026-11-01' }));
  assert.throws(() => normalizeSchedule({ personal_date: '2026-11-03', personal_at: '2026-11-02T10:00' }));
  assert.throws(() => normalizeSchedule({ status: 'reviewed', checked_at: '2026-10-12' }));
  const schedule = normalizeSchedule({ personal_at: '2026-11-02T00:30:00.000Z', status: 'reviewed', source_url: 'https://admission.example.edu/notice', checked_at: '2026-10-12', required_materials: ['신분증', '수험표'] });
  assert.equal(schedule.personal_date, '2026-11-02');
  assert.deepEqual(schedule.required_materials, ['신분증', '수험표']);
});

test('provenance-only review does not issue an interview schedule change notification', () => {
  const before = normalizeSchedule({ personal_date: '2026-11-02', required_materials: '신분증\n수험표' });
  const after = { ...before, checked_at: '2026-10-12', source_url: 'https://admission.example.edu', status: 'reviewed' };
  assert.equal(scheduleChanged(before, after), false);
  assert.equal(scheduleChanged(before, { ...after, personal_date: '2026-11-03' }), true);
  assert.equal(scheduleChanged(before, { ...after, required_materials: ['다른 준비물'] }), true);
});

test('source links reject executable schemes and URLs containing credentials', () => {
  assert.equal(safeSourceURL('javascript:alert(1)'), null);
  assert.equal(safeSourceURL('https://user:secret@example.edu'), null);
  assert.equal(safeSourceURL('https://example.edu/notice'), 'https://example.edu/notice');
});
