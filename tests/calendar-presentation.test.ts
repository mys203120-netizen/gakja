import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarInterviewTime, calendarSchoolTones } from '../apps/web/src/lib/calendar-presentation.ts';

test('confirmed interview times use Korean time independently of the host timezone', () => {
  assert.equal(calendarInterviewTime('2026-11-02T10:30:00+09:00'), '10:30');
  assert.equal(calendarInterviewTime('2026-11-01T23:30:00Z'), '08:30');
  assert.equal(calendarInterviewTime('2026-11-02T00:00:00+09:00'), '00:00');
  assert.equal(calendarInterviewTime('2026-11-01T15:00:00Z'), '00:00');
});

test('unknown times and video submissions never acquire a fictional clock time', () => {
  for (const input of [undefined, '', '2026-11-02', 'invalid', '2026-11-02Tinvalid']) assert.equal(calendarInterviewTime(input), '시간 미정');
  assert.equal(calendarInterviewTime('2026-11-02T10:30:00+09:00', 'video_submission'), '제출기간');
  assert.equal(calendarInterviewTime(undefined, 'video_submission'), '제출기간');
});

test('school colors are stable across selection order, duplicates and repeated rendering', () => {
  const keys = ['school:uos', 'school:konkuk', 'school:sejong', 'school:hongik'];
  const expected = calendarSchoolTones(keys);
  assert.deepEqual(calendarSchoolTones([...keys].reverse()), expected);
  assert.deepEqual(calendarSchoolTones([...keys, keys[0], keys[2]]), expected);
  assert.deepEqual(calendarSchoolTones(keys), expected);
  assert.deepEqual(calendarSchoolTones([]), {});
});

test('eight registered schools each receive a distinct palette color even when hash slots collide', () => {
  const colors = Object.values(calendarSchoolTones(Array.from({ length: 8 }, (_, index) => `school:${index}`)));
  assert.equal(colors.length, 8);
  assert.equal(new Set(colors.map(tone => tone.background)).size, 8);
});

test('additional schools receive distinct colors rather than reusing the eight-color palette', () => {
  const keys = Array.from({ length: 88 }, (_, index) => `school:${index}`);
  const colors = calendarSchoolTones(keys);
  assert.equal(Object.keys(colors).length, 88);
  assert.equal(new Set(Object.values(colors).map(tone => tone.background)).size, 88);
  assert.deepEqual(calendarSchoolTones([...keys].reverse()), colors);
});

function colorChannels(value: string): number[] {
  if (/^#[a-f\d]{6}$/i.test(value)) return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
  const match = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(value);
  assert.ok(match, `unsupported test color ${value}`);
  const hue = Number(match[1]) / 360, saturation = Number(match[2]) / 100, lightness = Number(match[3]) / 100;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const k = (offset + hue * 12) % 12;
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}
function luminance(value: string): number {
  const channels = colorChannels(value).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test('school labels retain at least 4.5:1 contrast on all palette and additional school backgrounds', () => {
  const tones = calendarSchoolTones(Array.from({ length: 88 }, (_, index) => `school:${index}`));
  for (const [key, tone] of Object.entries(tones)) {
    const background = luminance(tone.background), foreground = luminance(tone.foreground);
    const contrast = (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
    assert.ok(contrast >= 4.5, `${key} text contrast ${contrast.toFixed(2)}:1 is below 4.5:1`);
  }
});
