import assert from 'node:assert/strict';
import {test} from 'node:test';
import {neutralReaction} from '../apps/web/src/lib/interviewer-reaction';

test('historical expression receipts can still be invalidated after a transcript correction',()=>{
  const original={level:75,signal:'encouraging',status:'evaluated',evidence:'과거 답변 인용'};
  const invalidated=neutralReaction('invalidated');
  assert.equal(invalidated.status,'invalidated');
  assert.equal(invalidated.evidence,'');
  assert.equal(invalidated.signal,'uncertain');
  assert.equal(original.status,'evaluated');
});
