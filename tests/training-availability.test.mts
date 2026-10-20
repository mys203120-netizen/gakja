import test from 'node:test';
import assert from 'node:assert/strict';
import {availabilityInput,availabilityInputSchema,availabilityMinutesForDate,normalizeTrainingAvailability,type TrainingAvailability} from '../apps/web/src/lib/training-availability.ts';

const settings:TrainingAvailability={version:2,startDate:'2026-10-20',revision:1,savedAt:'2026-10-20T00:30:00.000Z',weekdayMinutes:120,weekendMinutes:180,blockedDates:[],overrides:{}};

test('availability follows a real calendar across weekday, weekend and all dates without an automatic CSAT exclusion',()=>{
  assert.equal(availabilityMinutesForDate(settings,'2026-10-20'),120);
  assert.equal(availabilityMinutesForDate(settings,'2026-10-24'),180);
  assert.equal(availabilityMinutesForDate(settings,'2026-11-19'),120);
  assert.equal(availabilityMinutesForDate(settings,'2026-11-20'),120);
  assert.equal(availabilityMinutesForDate(settings,'2026-11-21'),180);
});
test('joined date and blocked days have precedence; explicit daily overrides precede period defaults',()=>{
  const value={...settings,blockedDates:['2026-10-22'],overrides:{'2026-10-19':180,'2026-10-21':45,'2026-10-22':240,'2026-11-19':30}};
  assert.equal(availabilityMinutesForDate(value,'2026-10-19'),0);
  assert.equal(availabilityMinutesForDate(value,'2026-10-21'),45);
  assert.equal(availabilityMinutesForDate(value,'2026-10-22'),0);
  assert.equal(availabilityMinutesForDate(value,'2026-11-19'),30);
});
test('absence, invalid stored values and invalid calendar days never create a speculative schedule',()=>{
  for(const value of [null,undefined,{}, {...settings,weekdayMinutes:481},{...settings,startDate:'2026-02-30'},{...settings,revision:0}]){
    assert.equal(normalizeTrainingAvailability(value),null);
    assert.equal(availabilityMinutesForDate(value,'2026-11-20'),0);
  }
  for(const day of ['2026-02-30','2026-11-20T00:00:00Z','invalid'])assert.equal(availabilityMinutesForDate(settings,day),0);
});
test('editable input rejects server-owned dates and metadata, duplicate blocked days and fabricated overrides',()=>{
  const {version:_,startDate:__,revision:___,savedAt:____,...input}=settings;
  assert.equal(availabilityInputSchema.safeParse(input).success,true);
  for(const bad of [{...input,startDate:'2000-01-01'},{...input,studentId:'another-student'},{...input,blockedDates:['2026-10-22','2026-10-22']},{...input,overrides:{'2026-02-30':20}},{...input,weekendMinutes:-1},{...input,weekdayMinutes:12.5}])assert.equal(availabilityInputSchema.safeParse(bad).success,false);
});
test('normalization preserves all supported days without a seven-day or one-month limit and does not mutate input',()=>{
  const source={...settings,blockedDates:['2026-12-15','2026-10-23']};
  assert.deepEqual(normalizeTrainingAvailability(source)?.blockedDates,['2026-10-23','2026-12-15']);
  assert.deepEqual(source.blockedDates,['2026-12-15','2026-10-23']);
  assert.equal(availabilityMinutesForDate(settings,'2026-12-14'),120);
});


test('legacy settings project only the current period and explicit single-period saves retain metadata',()=>{
 const legacy={...settings,version:1 as const,csatDate:'2026-11-19',beforeCsatWeekdayMinutes:20,beforeCsatWeekendMinutes:60};
 const original=JSON.stringify(legacy),before=normalizeTrainingAvailability(legacy,'2026-10-20')!,after=normalizeTrainingAvailability(legacy,'2026-11-20')!;
 assert.equal(before.version,2);assert.equal(before.weekdayMinutes,20);assert.equal(before.weekendMinutes,60);
 assert.equal(after.weekdayMinutes,120);assert.equal(after.weekendMinutes,180);
 assert.equal(availabilityMinutesForDate(before,'2026-11-19'),20);assert.equal(availabilityMinutesForDate(before,'2026-11-20'),20);
 assert.deepEqual(availabilityInput(legacy,'2026-10-20'),{weekdayMinutes:20,weekendMinutes:60,blockedDates:[],overrides:{}});
 assert.equal(JSON.stringify(legacy),original);assert.equal(before.startDate,legacy.startDate);assert.equal(before.savedAt,legacy.savedAt);assert.equal(before.revision,legacy.revision);
 assert.ok(!('csatDate' in before));assert.equal(availabilityInputSchema.safeParse({...availabilityInput(before),csatDate:null}).success,false);
});
