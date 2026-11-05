import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRequestTokenBudget, measureRequestTokenBudget } from '../server/providers/request-token-budget';

test('visible request preflight includes instructions and schema and labels its byte bound as non-exact',()=>{
 const measured=measureRequestTokenBudget({instructions:'지침',input:'답변',schema:{type:'object',description:'출력 계약'},maxOutputTokens:2000});
 assert.equal(measured.exactInputTokens,null);assert.equal(measured.method,'utf8_upper_bound_not_exact_token_count');
 assert.equal(measured.blocks.instructions.utf8Bytes,Buffer.byteLength('지침'));
 assert.ok(measured.blocks.schema.utf8Bytes>0);
 assert.equal(measured.totalVisibleInputBytes,Object.values(measured.blocks).reduce((sum,block)=>sum+block.utf8Bytes,0));
 assert.ok(measured.totalVisibleInputBytes>measured.totalVisibleCharacters);
 assert.equal(measured.conservativeVisibleInputTokenUpperBound,measured.totalVisibleInputBytes);
 assert.doesNotThrow(()=>assertRequestTokenBudget(measured,{maxVisibleInputBytes:1000,contextWindowTokens:10000}));
});

test('large policy or output reservation cannot bypass a tiny input-string check',()=>{
 const measured=measureRequestTokenBudget({instructions:'정책'.repeat(500),input:'{}',schema:{description:'설명'.repeat(500)},maxOutputTokens:2000});
 assert.throws(()=>assertRequestTokenBudget(measured,{maxVisibleInputBytes:1000}),/REQUEST_VISIBLE_INPUT_BUDGET_EXCEEDED/u);
 assert.throws(()=>assertRequestTokenBudget(measured,{maxVisibleInputBytes:10000,contextWindowTokens:measured.totalVisibleInputBytes+2000}),/REQUEST_CONTEXT_BUDGET_EXCEEDED/u);
 assert.throws(()=>measureRequestTokenBudget({instructions:'',input:'',maxOutputTokens:0}),/REQUEST_OUTPUT_BUDGET_INVALID/u);
});
