import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSavedQuizItem, selectQuizItems } from '../apps/web/src/lib/quiz-selection';
const now = Date.UTC(2026,9,12), pool = Array.from({length:24},(_,i)=>({id:`m${i}`,question_id:`q${i}`,kind:'short_answer',prompt:`질문 ${i}`,modelAnswer:''} as any));
const history=(id:string,offset:number,data:any={},rating='good',due=now+10000)=>({memory_item_id:id,rating,data,due_at:new Date(due),created_at:new Date(now+offset)});
test('the entire eligible pool participates: old wrong items after position twelve are first',()=>{
  const result=selectQuizItems(pool,[history('m23',-1000,{correct:false})],now,6);
  assert.equal(result.items[0].id,'m23');assert.equal(result.wrong,1);assert.equal(result.items.length,6);
  assert.equal(result.reason,'다시 확인할 1문항부터');
});
test('latest verified success supersedes an earlier wrong while due items precede unseen',()=>{
  const result=selectQuizItems(pool,[history('m23',-2000,{correct:false}),history('m23',-1000,{correct:true,assistance_recorded:true}),history('m19',-3000,{correct:true,assistance_recorded:true},'good',now-1)],now,6);
  assert.equal(result.items[0].id,'m19');assert.equal(result.wrong,0);assert.equal(result.due,1);assert.ok(!result.items.some(item=>item.id==='m23'));
});
test('full-pool selection avoids recently practiced items and uses oldest first after coverage',()=>{
  const seen=pool.map((item,i)=>history(item.id,-(i+1)*1000,{correct:true}));
  assert.deepEqual(selectQuizItems(pool,seen,now,3).items.map(item=>item.id),['m23','m22','m21']);
  assert.equal(selectQuizItems(pool,seen.slice(0,12),now,2).items[0].id,'m12');
});
test('help is recorded as practice rather than inventing mastery and selection does not mutate snapshots',()=>{
  const original=JSON.stringify(pool), rows=[history('m0',-1000,{hint_used:true}),history('m1',-2000,{assisted:true}),history('m2',-3000,{correct:true})];
  const result=selectQuizItems(pool.slice(0,3),rows,now,3);
  assert.deepEqual(result.items.map(item=>item.id),['m1','m0','m2']);assert.equal(JSON.stringify(pool),original);
});
test('a saved subjective or helped correct answer does not erase a previous wrong',()=>{
  for (const data of [{correct:null},{correct:true,hint_used:true},{correct:true,assisted:true}]) {
    const result=selectQuizItems(pool,[history('m23',-2000,{correct:false}),history('m23',-1000,data)],now,6);
    assert.equal(result.wrong,1);assert.equal(result.items[0].id,'m23');
  }
});

test('a legacy correct answer with unknown assistance cannot erase an earlier wrong',()=>{
  for(const data of [{correct:true},{correct:true,assisted:false},{correct:true,hint_used:false,assistance_recorded:false}]){
    const result=selectQuizItems(pool,[history('m23',-2000,{correct:false}),history('m23',-1000,data)],now,6);
    assert.equal(result.wrong,1);assert.equal(result.items[0].id,'m23');
  }
});

test('uncertain, confirmation-needed and unchecked self recall enter review without a fake factual grade',()=>{
  for(const recall_state of ['uncertain','needs_confirmation','unchecked']){
    const row=history('m23',-1000,{correct:null,recall_state,assistance_recorded:true},'hard',now+86400_000);
    const original=JSON.stringify(row),result=selectQuizItems(pool,[row],now,6);
    assert.equal(result.wrong,1);assert.equal(result.items[0].id,'m23');assert.equal(result.due,0);assert.equal(JSON.stringify(row),original);
    assert.equal(result.reason,'다시 확인할 1문항부터','review priority never implies that an unchecked student selected retry');
  }
  const remembered=selectQuizItems(pool,[history('m23',-1000,{correct:null,recall_state:'remembered',assistance_recorded:true})],now,6);
  assert.equal(remembered.wrong,0);assert.ok(!remembered.items.some(item=>item.id==='m23'));
});
test('republished items map only by exact ID or same kind and question/prompt, never a different activity guess',()=>{
  assert.equal(mapSavedQuizItem(pool[0],[{...pool[0],id:'replacement'}])?.id,'replacement');
  assert.equal(mapSavedQuizItem(pool[0],[{...pool[1],prompt:pool[0].prompt}])?.id,'m1');
  assert.equal(mapSavedQuizItem(pool[0],[{...pool[0],id:'other-kind',kind:'choice'}]),undefined);
  assert.equal(mapSavedQuizItem(pool[0],[pool[1]]),undefined);
});
