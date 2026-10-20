import test from 'node:test';
import assert from 'node:assert/strict';
import {studentOnboardingDestination} from '../apps/web/src/lib/student-onboarding.ts';

const student={user:{role:'student'},targets:[],preferences:{}};
test('a new student selects a school and its public calendar before starting the daily training',()=>{
  for(const path of ['/my','/my/today','/quiz','/interview/chat','/on','/records','/knowledge','/schools']){
    assert.equal(studentOnboardingDestination(student,path),'/schools/new?onboarding=1');
  }
});
test('loading bootstrap never triggers a speculative onboarding redirect',()=>{
  assert.equal(studentOnboardingDestination(null,'/my'),null);
});
test('existing students retain access only while an active school is registered',()=>{
  assert.equal(studentOnboardingDestination({...student,targets:[{id:'existing-target'}]},'/quiz/session/existing'),null);
  assert.equal(studentOnboardingDestination({...student,preferences:{schoolCalendarOnboardingCompleted:true}},'/my'),'/schools/new?onboarding=1');
  assert.equal(studentOnboardingDestination({...student,preferences:{schoolCalendarOnboardingCompleted:'true'}},'/my'),'/schools/new?onboarding=1');
});
test('registration, account settings and legal information remain reachable during onboarding',()=>{
  for(const path of ['/start','/start/help','/schools/new','/schools/new/step','/availability','/account','/account/settings','/account/confirmations','/settings','/legal/terms','/terms','/privacy']){
    assert.equal(studentOnboardingDestination(student,path),null);
  }
  assert.equal(studentOnboardingDestination(student,'/schools/newspaper'),'/schools/new?onboarding=1');
});
test('only a marked incomplete registration resumes availability setup, including after a page reload',()=>{
  const incomplete={...student,targets:[{id:'new-target'}],preferences:{schoolCalendarOnboardingCompleted:true,trainingAvailabilityRequired:true}};
  for(const path of ['/my','/preparation','/records','/interview/new'])assert.equal(studentOnboardingDestination(incomplete,path),'/availability?onboarding=1');
  for(const path of ['/schools/new','/availability','/account/settings'])assert.equal(studentOnboardingDestination(incomplete,path),null);
  assert.equal(studentOnboardingDestination({...incomplete,preferences:{...incomplete.preferences,trainingAvailabilityRequired:'true'}},'/my'),null);
});
test('valid saved availability completes setup while invalid settings remain pending',()=>{
  const incomplete={...student,targets:[{id:'new-target'}],preferences:{trainingAvailabilityRequired:true,trainingAvailability:{}}};
  assert.equal(studentOnboardingDestination(incomplete,'/my'),'/availability?onboarding=1');
  const trainingAvailability={version:1,weekdayMinutes:120,weekendMinutes:120,csatDate:null,beforeCsatWeekdayMinutes:20,beforeCsatWeekendMinutes:60,blockedDates:[],overrides:{},revision:1,savedAt:'2026-10-20T00:00:00.000Z',startDate:'2026-10-20'};
  assert.equal(studentOnboardingDestination({...incomplete,preferences:{trainingAvailabilityRequired:true,trainingAvailability}},'/my'),null);
});
test('administrators and staff never inherit the student onboarding guard',()=>{
  for(const role of ['admin','staff'])assert.equal(studentOnboardingDestination({...student,user:{role}},'/admin'),null);
  assert.equal(studentOnboardingDestination(student,'/admin',true),null);
});
