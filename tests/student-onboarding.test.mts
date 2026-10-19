import test from 'node:test';
import assert from 'node:assert/strict';
import {studentOnboardingDestination} from '../apps/web/src/lib/student-onboarding.ts';

const student={user:{role:'student'},targets:[],preferences:{}};
test('a new student reaches the optional common first question before school registration',()=>{
  for(const path of ['/my','/my/today','/quiz','/interview/chat','/on','/records','/knowledge','/schools']){
    assert.equal(studentOnboardingDestination(student,path),'/start');
  }
});
test('loading bootstrap never triggers a speculative onboarding redirect',()=>{
  assert.equal(studentOnboardingDestination(null,'/my'),null);
});
test('registered existing students are not forced through new onboarding or lose current learning access',()=>{
  assert.equal(studentOnboardingDestination({...student,targets:[{id:'existing-target'}]},'/quiz/session/existing'),null);
  assert.equal(studentOnboardingDestination({...student,preferences:{schoolCalendarOnboardingCompleted:true}},'/my'),null);
  assert.equal(studentOnboardingDestination({...student,preferences:{schoolCalendarOnboardingCompleted:'true'}},'/my'),'/start');
});
test('registration, account settings and legal information remain reachable during onboarding',()=>{
  for(const path of ['/start','/start/help','/schools/new','/schools/new/step','/account','/account/settings','/account/confirmations','/settings','/legal/terms','/terms','/privacy']){
    assert.equal(studentOnboardingDestination(student,path),null);
  }
  assert.equal(studentOnboardingDestination(student,'/schools/newspaper'),'/start');
});
test('administrators and staff never inherit the student onboarding guard',()=>{
  for(const role of ['admin','staff'])assert.equal(studentOnboardingDestination({...student,user:{role}},'/admin'),null);
  assert.equal(studentOnboardingDestination(student,'/admin',true),null);
});
