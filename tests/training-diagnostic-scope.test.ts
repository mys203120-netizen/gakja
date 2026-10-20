import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticReviewScope} from '../apps/web/src/lib/training-diagnostic-scope';

test('common diagnostic uses frozen common revision independently of a missing/different personal publication',()=>{
 for(const contentVersion of [null,4,99])assert.deepEqual(diagnosticReviewScope({contentVersion,questions:[{id:'a',common_revision:7},{id:'b',common_revision:7}]}),{sourceType:'common',sourceVersion:7,questionIds:['a','b']});
});
test('personal diagnostic keeps the original content version and rejects ambiguous roots',()=>{
 assert.deepEqual(diagnosticReviewScope({contentVersion:3,questions:[{id:'a'},{id:'a'}]}),{sourceType:'personal',sourceVersion:3,questionIds:['a']});
 for(const context of [{contentVersion:3,questions:[]},{contentVersion:null,questions:[{id:'a'}]},{contentVersion:3,questions:[{id:'a'},{id:'b',common_revision:7}]},{contentVersion:3,questions:[{id:'a',common_revision:7},{id:'b',common_revision:8}]}])assert.equal(diagnosticReviewScope(context),null);
});
