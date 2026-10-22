import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileParent} from '../apps/web/src/lib/app-navigation';

test('mobile details keep a useful in-app parent when opened directly',()=>{
 for(const [path,href] of [
  ['/account/data','/account'],['/account/settings','/account'],
  ['/account/confirmations','/preparation'],['/armory','/preparation'],
  ['/schools/new','/schools'],['/schools/target','/schools'],
  ['/materials/questions/question','/materials/questions'],['/materials/briefings/article','/materials/briefings'],
  ['/knowledge/article','/knowledge'],['/reports/report','/records'],
  ['/records/comparisons','/records'],['/my/train','/my'],
  ['/on/thread','/my'],['/quiz/session/session','/learn'],['/interview/session','/learn'],
 ])assert.equal(mobileParent(path)?.href,href,path);
});

test('primary destinations and unknown paths never create a looping back link',()=>{
 for(const path of ['/my','/preparation','/records','/admin','/external','//elsewhere.example'])assert.equal(mobileParent(path),null,path);
});
