import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedQuestionMatchesTarget} from '../apps/web/src/lib/published-question-scope';
const target={id:'a',university:'합성대학교',department:'환경공학과',campus:'본교',admission_year:2027,admission_type:'일반전형'};
const other={...target,id:'b',university:'다른대학교'};
const learning={support_targets:[target,other]};
const question={id:'q',support_target_ids:[target.id]};
test('AI and knowledge question scoping rejects each changed school identity despite a retained ID',()=>{
  assert.equal(publishedQuestionMatchesTarget(question,learning,target),true);
  for(const patch of [{university:'새대학교'},{department:'건축학과'},{campus:'다른캠퍼스'},{admission_year:2028},{admission_type:'새전형'}])assert.equal(publishedQuestionMatchesTarget(question,learning,{...target,...patch}),false);
  assert.equal(publishedQuestionMatchesTarget(question,learning,other),false);
  assert.equal(publishedQuestionMatchesTarget(question,learning,null),false);
});
test('unrelated applications and unscoped biography stay available without mutating the published baseline',()=>{
  const before=JSON.stringify(learning),changed={...target,department:'건축학과'};
  assert.equal(publishedQuestionMatchesTarget({support_target_ids:[other.id]},learning,other),true);
  assert.equal(publishedQuestionMatchesTarget({support_target_ids:[]},learning,changed),true);
  assert.equal(publishedQuestionMatchesTarget({},learning,null),true);
  assert.equal(JSON.stringify(learning),before);
});
