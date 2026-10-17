import test from 'node:test';
import assert from 'node:assert/strict';
import { answerComparison, createDemoPack, evaluateQuizResponse, hashLearningData, parseLearningHtml, publicQuizItem, quizSnapshotItem, renderLearningHtml, reviewedShortAnswerMatches, schoolProfileIdentityMatches, validateGuidebook, validatePair, validateSchoolProfile, type LearningPack, type MemoryItem, type SchoolProfileData, type SchoolProfileProvenance } from '../src/index.js';

const studentId = 'contract-test-student';
const context = { studentId, productionJobRef: `${studentId}-job`, registeredTargetIds: [`${studentId}-target-1`, `${studentId}-target-2`] };
const pair = () => structuredClone(createDemoPack(studentId, '테스트 학생', 'environment'));

test('both complete final TOCs and 4 memory methods survive server HTML import', () => {
  const packs = pair().map(p => parseLearningHtml(renderLearningHtml(p)).pack);
  const result = validatePair(packs, context);
  assert.equal(result.documents.length, 2);
  assert.equal(result.learning.activities.length, 8);
  assert.equal(result.learning.questions.length, 15);
  assert.equal(result.learning.questions.filter(question=>question.question_types.includes('concept')).length,3);
  assert.equal(result.learning.questions.filter(question=>!question.question_types.includes('concept')).length,12);
  assert.equal(new Set(result.learning.memory_items.map(m => m.kind)).size, 4);
});
test('canonical learning hash ignores object key order but preserves array order', () => {
  assert.equal(hashLearningData({ a: 1, b: { c: 2, d: 3 } }), hashLearningData({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(hashLearningData([1, 2]), hashLearningData([2, 1]));
});
test('reject script, obfuscated handler, iframe, external resource and duplicate contract', () => {
  const html = renderLearningHtml(pair()[0]);
  for (const attack of ['<script>alert(1)</script>', '<img oNerror="alert(1)">', '<iframe></iframe>', '<img src="https://example.com/track">', '<style>@import "https://example.com/track";</style>', '<svg><a href="java&#x73;cript:alert(1)">x</a></svg>']) assert.throws(() => parseLearningHtml(html.replace('</body>', attack + '</body>')));
  assert.throws(() => parseLearningHtml(html + html));
});
test('reject other student, production job and unregistered targets', () => {
  assert.throws(() => validatePair(pair(), { ...context, studentId: 'other' }), /지정된 학생/);
  assert.throws(() => validatePair(pair(), { ...context, productionJobRef: 'other' }), /제작 건/);
  assert.throws(() => validatePair(pair(), { ...context, registeredTargetIds: [] }), /서버에 등록/);
});
test('reject paired learning mismatch even when each individual hash is valid', () => {
  const packs = pair(); packs[1].learning_data.activities[0].activity_summary += ' 개정';
  packs[1].learning_data_hash = hashLearningData(packs[1].learning_data);
  assert.throws(() => validatePair(packs, context), /두 책/);
});
test('reject stale hash, missing subsection, renamed section and dangling references', () => {
  const missing = pair(); missing[0].document.sections[0].children!.pop();
  assert.throws(() => validatePair(missing, context), /하위 목차/);
  const renamed = pair(); renamed[0].document.sections[0].title = '다른 목차';
  assert.throws(() => validatePair(renamed, context), /확정 제목/);
  const stale = pair(); stale[0].learning_data.activities[0].title = '변경';
  assert.throws(() => validatePair(stale, context), /해시/);
  const dangling = pair(); dangling[0].document.blocks.push({ id: 'unresolved-block', type: 'question_ref', section_id: dangling[0].document.sections[0].children![0].id, question_id: 'missing' });
  assert.throws(() => validatePair(dangling, context), /참조 missing/);
});
test('declines unsupported legacy schemas and duplicate entity IDs', () => {
  const legacy = pair(); (legacy[0] as unknown as {schema_version:string}).schema_version = '1.1.0';
  assert.throws(() => validatePair(legacy, context), /migration/);
  const duplicated = pair(); duplicated[0].learning_data.questions[1].id = duplicated[0].learning_data.activities[0].id;
  duplicated[0].learning_data_hash = hashLearningData(duplicated[0].learning_data);
  assert.throws(() => validatePair(duplicated, context), /중복/);
});
test('render escapes literal closing script content in learning quotes', () => {
  const packs = pair(); packs[0].learning_data.source_refs[0].quote += ' </script><script>alert(1)</script>';
  packs[0].learning_data_hash = hashLearningData(packs[0].learning_data);
  const result = parseLearningHtml(renderLearningHtml(packs[0]));
  assert.match(result.pack.learning_data.source_refs[0].quote!, /<\/script>/);
});
test('reject mismatched book body markers and external SVG or escaped CSS resources', () => {
  const html = renderLearningHtml(pair()[0]);
  assert.throws(() => parseLearningHtml(html.replace('data-document-kind="guidebook"', 'data-document-kind="handbook"')), /문서 종류/);
  assert.throws(() => parseLearningHtml(html.replace('<main data-document-kind="guidebook">', '<main>')), /본문 main/);
  for (const attack of ['<svg><image href="https://example.com/track"/></svg>', '<style>@\\69mport "https://example.com/track";</style>', '<style>p {background:u\\72l(https://example.com/track)}</style>']) assert.throws(() => parseLearningHtml(html.replace('</body>', attack + '</body>')));
});

test('approved objective quiz grades an option; hidden keys do not reach task views', () => {
  const learning = pair()[0].learning_data;
  const item = quizSnapshotItem(learning.memory_items.find(m => m.kind === 'choice')!,learning);
  const view = publicQuizItem(item);
  assert.equal('correct_option_id' in view,false);
  assert.equal('correct_order' in view,false);
  assert.equal('back' in view,false);
  const correct = evaluateQuizResponse(item,{memoryItemId:item.id,response:item.correct_option_id!,rating:'good'});
  assert.equal(correct.correct,true);
  const wrongId = item.options!.find(o => o.id !== item.correct_option_id)!.id;
  const wrong = evaluateQuizResponse(item,{memoryItemId:item.id,response:wrongId,rating:'easy'});
  assert.equal(wrong.correct,false); assert.equal(wrong.retry_due,true);
  assert.throws(() => evaluateQuizResponse(item,{memoryItemId:item.id,response:'not-a-valid-option',rating:'good'}));
});
test('personal experience and inability to recall remain unscored and preserve meaning checks', () => {
  const learning = pair()[0].learning_data;
  const item = quizSnapshotItem(learning.memory_items.find(m => m.kind === 'keyword_recall')!,learning);
  const answer = {memoryItemId:item.id,response:'교재 문장을 외우지 않고 내 말로 설명한 응답',rating:'good' as const,selfCheckedMeanings:item.required_meaning_elements};
  const result = evaluateQuizResponse(item,answer);
  assert.equal(result.correct,null); assert.equal(result.missing_meanings.length,0);
  assert.equal(result.evaluation_method,'self_check');
  assert.throws(() => evaluateQuizResponse(item,{...answer,selfCheckedMeanings:['승인되지 않은 사실']}));
  const cannot = evaluateQuizResponse(item,{memoryItemId:item.id,response:'',rating:'again',cannotRecall:true});
  assert.equal(cannot.correct,null); assert.equal(cannot.retry_due,true); assert.equal(cannot.cannot_recall,true);
});
test('a disputed fact never becomes an objective wrong answer and order checks reject missing steps', () => {
  const learning = pair()[0].learning_data;
  const choice = quizSnapshotItem(learning.memory_items.find(m => m.kind === 'choice')!,learning);
  choice.verification_status='student_says_different';
  const result = evaluateQuizResponse(choice,{memoryItemId:choice.id,response:choice.options![0].id,rating:'good'});
  assert.equal(result.correct,null); assert.equal(result.evaluation_method,'self_check');
  const order = quizSnapshotItem(learning.memory_items.find(m => m.kind === 'order')!,learning);
  assert.throws(() => evaluateQuizResponse(order,{memoryItemId:order.id,response:[],order:[order.sequence![0].id],rating:'good'}));
  assert.equal(evaluateQuizResponse(order,{memoryItemId:order.id,response:[],order:order.sequence!.map(x => x.id).reverse(),rating:'good',selfCheckedMeanings:order.required_meaning_elements}).correct,null);
});
test('question depth and typed confirmation claims survive content import without replacing approval', () => {
  const packs = pair();
  for (const pack of packs) {
    pack.learning_data.questions[0].depth='D2';
    pack.learning_data.activities[0].fact_confirmation='confirmed_from_record';
    pack.learning_data.answer_scripts[0].claims[0].claim_type='student_record_fact';
    pack.learning_data.answer_scripts[0].claims[0].confirmation_status='confirmed_from_record';
    pack.learning_data_hash=hashLearningData(pack.learning_data);
  }
  assert.equal(validatePair(packs,context).learning.questions[0].depth,'D2');
  for (const pack of packs) { pack.learning_data.answer_scripts[0].claims[0].confirmation_status='student_says_different'; pack.learning_data_hash=hashLearningData(pack.learning_data); }
  assert.throws(() => validatePair(packs,context),/미확인 주장/);
});
test('answer comparison exposes literal checks without awarding improvement', () => {
  const comparison = answerComparison('역할을 내 말로 설명',{answer_elements:['본인 역할','과정']} as any);
  assert.equal(comparison.comparison_basis,'literal_mentions');
  assert.deepEqual(comparison.required_meanings,[{text:'본인 역할',present:false},{text:'과정',present:false}]);
  assert.equal('score' in comparison,false); assert.equal('improved' in comparison,false);
});
test('school profiles keep evaluation weights separate and require provenance for official rules', () => {
  const data: SchoolProfileData = {admission_year:2027,university:'가상 대학',campus:'가상 캠퍼스',department:'가상 학과',admission_type:'가상 전형',interview_stage:'1단계',format:'unknown',interview_conducted:null,interviewer_count:null,applicant_count:null,preparation_minutes:null,interview_minutes:null,admission_interview_weight:30,evaluation_weights:[{element:'학업',weight:30},{element:'진로',weight:50},{element:'공동체',weight:20}],question_distribution:null};
  const provenance: SchoolProfileProvenance = {source_url:null,page:null,document_title:null,applicable_year:2027,published_at:null,checked_at:null,review_note:'테스트용 훈련 설정'};
  validateSchoolProfile(data,provenance,'training_configuration');
  assert.equal(data.question_distribution,null);
  assert.throws(() => validateSchoolProfile(data,provenance,'official_confirmed'),/원문/);
  const official = {...provenance,source_url:'https://example.edu/admission',document_title:'테스트 모집요강',checked_at:'2026-10-12T00:00:00Z'};
  validateSchoolProfile(data,official,'official_confirmed');
  assert.throws(() => validateSchoolProfile({...data,interviewer_count:{min:3,max:1}},official,'official_confirmed'),/범위/);
  const distribution = {basis:'official' as const,unit:'root_question_count' as const,buckets:[{id:'activity',label:'활동',weight:1}],includes_followups:false};
  assert.throws(() => validateSchoolProfile({...data,question_distribution:distribution},provenance,'training_configuration'),/공식 확인/);
});
test('new short-answer and speaking content imports without altering existing four-method packs', () => {
  const packs=pair();
  for(const pack of packs) {
    const original=pack.learning_data.memory_items.find(m=>m.kind==='choice')!;
    pack.learning_data.memory_items.push({...original,id:'new-reviewed-short',kind:'short_answer',category:'concept',accepted_answers:[original.options!.find(o=>o.id===original.correct_option_id)!.text]});
    pack.learning_data.memory_items.push({...original,id:'new-speech',kind:'short_speech',category:'experiential',evaluation_method:'self_check',accepted_answers:undefined,numeric_answer:undefined});
    pack.learning_data_hash=hashLearningData(pack.learning_data);
  }
  assert.equal(validatePair(packs,context).learning.memory_items.length,14);
  const original=pair(); assert.equal(new Set(original[0].learning_data.memory_items.map(m=>m.kind)).size,4);
  for(const pack of packs) { const item=pack.learning_data.memory_items.find(m=>m.id==='new-reviewed-short')!;item.accepted_answers=undefined;pack.learning_data_hash=hashLearningData(pack.learning_data); }
  assert.throws(()=>validatePair(packs,context),/허용 표기/);
});
test('reviewed short-answer normalization supports declared units and tolerance without inventing equivalence', () => {
  const base=pair()[0].learning_data.memory_items.find(m=>m.kind==='choice')!;
  const text: MemoryItem={...base,kind:'short_answer',accepted_answers:['Arduino','아두이노']};
  assert.equal(reviewedShortAnswerMatches(text,'  ＡＲＤＵＩＮＯ  '),true);
  assert.equal(reviewedShortAnswerMatches(text,'라즈베리 파이'),false);
  const numeric: MemoryItem={...base,kind:'short_answer',numeric_answer:{value:1000,unit:'mL',tolerance:0,accepted_units:['밀리리터']}};
  assert.equal(reviewedShortAnswerMatches(numeric,'1,000 ml'),true);
  assert.equal(reviewedShortAnswerMatches(numeric,'1000.0밀리리터'),true);
  assert.equal(reviewedShortAnswerMatches(numeric,'1 L'),false);
  assert.equal(reviewedShortAnswerMatches(numeric,'1001mL'),false);
  const tolerance={...numeric,numeric_answer:{value:3.5,unit:'g',tolerance:0.1}};
  assert.equal(reviewedShortAnswerMatches(tolerance,'3.6g'),true);
  assert.equal(reviewedShortAnswerMatches(tolerance,'3.7g'),false);
  const learning=pair()[0].learning_data;
  const item=quizSnapshotItem(text,learning),result=evaluateQuizResponse(item,{memoryItemId:item.id,response:'아두이노',rating:'good'});
  assert.equal(result.correct,true);
  assert.equal('accepted_answers' in publicQuizItem(item),false);
  const speech=quizSnapshotItem({...text,kind:'short_speech',category:'experiential',evaluation_method:'self_check'},learning);
  assert.equal(evaluateQuizResponse(speech,{memoryItemId:speech.id,response:'기록한 말하기 내용',rating:'good',selfCheckedMeanings:speech.required_meaning_elements}).correct,null);
  assert.throws(()=>evaluateQuizResponse(speech,{memoryItemId:speech.id,response:'',selectedOptionId:'fake',rating:'good'}));
});
test('stable support target IDs cannot preserve official profiles after campus/year/admission-stage changes',()=>{
  const profile={admission_year:2027,university:'가상 대학',campus:'첫 캠퍼스',department:'가상 학과',admission_type:'첫 전형',interview_stage:'1단계'};
  assert.equal(schoolProfileIdentityMatches(profile,{...profile}),true);
  for(const changed of [{admission_year:2028},{campus:'다른 캠퍼스'},{admission_type:'다른 전형'},{interview_stage:'2단계'}]) assert.equal(schoolProfileIdentityMatches(profile,{...profile,...changed}),false);
  assert.equal(schoolProfileIdentityMatches({},{}),false);
});

const guidebook = () => pair()[0];
const rehash = (pack: LearningPack) => { pack.learning_data_hash = hashLearningData(pack.learning_data); return pack; };
const removeQuizItems = (pack: LearningPack) => {
  pack.learning_data.memory_items = [];
  pack.document.blocks = pack.document.blocks.map(block => block.type === 'memory_item_ref' ? { id: block.id, section_id: block.section_id, type: 'text', text: '훈련 본문' } : block);
  return rehash(pack);
};
const keepQuizItems = (pack: LearningPack, items: MemoryItem[]) => {
  pack.learning_data.memory_items = items;
  const ids = new Set(items.map(item => item.id));
  pack.document.blocks = pack.document.blocks.map(block => block.type === 'memory_item_ref' && !ids.has(block.memory_item_id!) ? { id: block.id, section_id: block.section_id, type: 'text', text: '훈련 본문' } : block);
  return rehash(pack);
};

test('one reviewed final guidebook imports authored activity/question/quiz links without a handbook or mutation', () => {
  const pack = parseLearningHtml(renderLearningHtml(guidebook())).pack;
  const before = structuredClone(pack);
  const result = validateGuidebook(pack, context);
  assert.deepEqual(result.documents.map(document => document.kind), ['guidebook']);
  assert.equal(result.packageId, pack.package_id);
  assert.equal(result.contentVersion, pack.content_version);
  assert.equal(result.learningHash, pack.learning_data_hash);
  assert.deepEqual(pack, before);
  assert.deepEqual(result.learning, before.learning_data);
  for (const item of result.learning.memory_items) {
    const question = result.learning.questions.find(question => question.id === item.question_id)!;
    assert.ok(question);
    assert.ok(item.activity_ids.every(id => question.activity_ids.includes(id)));
  }
});

test('single final import requires reviewed status and rejects handbook-only content', () => {
  const draft = guidebook(); draft.package_status = 'draft';
  assert.throws(() => validateGuidebook(draft, context), /외부 최종 검수/);
  assert.throws(() => validateGuidebook(pair()[1], context), /최종 가이드북 HTML/);
});

test('single final import verifies student ownership, production job and registered support targets', () => {
  assert.throws(() => validateGuidebook(guidebook(), { ...context, studentId: 'other' }), /지정된 학생/);
  assert.throws(() => validateGuidebook(guidebook(), { ...context, productionJobRef: 'other' }), /제작 건/);
  assert.throws(() => validateGuidebook(guidebook(), { ...context, registeredTargetIds: [context.registeredTargetIds[0]] }), /서버에 등록/);
});

test('single final import retains mandatory review evidence, hashes, sources and final TOC checks', () => {
  for (const field of ['production_ref', 'review_ref', 'reviewed_at'] as const) {
    const missing = guidebook(); missing.provenance[field] = ' ';
    assert.throws(() => validateGuidebook(missing, context), new RegExp(`provenance.${field}`));
  }
  const invalidDate = guidebook(); invalidDate.provenance.reviewed_at = 'unreviewed';
  assert.throws(() => validateGuidebook(invalidDate, context), /유효한 검수 시각/);
  const stale = guidebook(); stale.learning_data.activities[0].title += ' 변경';
  assert.throws(() => validateGuidebook(stale, context), /해시/);
  const missingSource = guidebook(); missingSource.learning_data.activities[0].priority_assignments[0].source_ref_ids = ['missing-evaluation-source'];
  assert.throws(() => validateGuidebook(rehash(missingSource), context), /참조 missing-evaluation-source/);
  const wrongToc = guidebook(); wrongToc.document.sections[0].children![0].title = '임의 제목';
  assert.throws(() => validateGuidebook(wrongToc, context), /하위 목차 제목/);
});

test('single final requires evaluations for every included activity/target, retaining legacy paired rules', () => {
  const packs = pair();
  for (const pack of packs) { pack.learning_data.activities[0].priority_assignments.pop(); rehash(pack); }
  assert.doesNotThrow(() => validatePair(packs, context));
  assert.throws(() => validateGuidebook(packs[0], context), /target-2의 활동별 우선도/);
  const noReason = guidebook(); noReason.learning_data.activities[0].priority_assignments[0].reason = '';
  assert.throws(() => validateGuidebook(rehash(noReason), context), /priority_assignments.reason/);
  const wrongCriteria = guidebook(); wrongCriteria.learning_data.activities[0].priority_assignments[0].criteria_version = 'unapproved-criteria';
  assert.throws(() => validateGuidebook(rehash(wrongCriteria), context), /기준 버전/);
});

test('target-specific activity talent, major and representative evaluation survives single import', () => {
  const pack = guidebook();
  Object.assign(pack.learning_data.activities[0].priority_assignments[0], { talent_tags: ['탐구', '책임'], major_relevance: '해당 학과의 수질 측정 탐구와 연결', representative_candidate: true, representative_reason: '본인 역할과 비교 조건을 설명할 수 있는 활동' });
  Object.assign(pack.learning_data.activities[0].priority_assignments[1], { talent_tags: ['협업'], major_relevance: null, representative_candidate: false });
  const result = validateGuidebook(parseLearningHtml(renderLearningHtml(rehash(pack))).pack, context);
  assert.deepEqual(result.learning.activities[0].priority_assignments[0].talent_tags, ['탐구', '책임']);
  assert.equal(result.learning.activities[0].priority_assignments[0].representative_candidate, true);
  assert.equal(result.learning.activities[0].priority_assignments[1].major_relevance, null);
  assert.notDeepEqual(result.learning.activities[0].priority_assignments[0].talent_tags, result.learning.activities[0].priority_assignments[1].talent_tags);
});

test('target-specific activity evaluation rejects malformed optional fields and unsupported representative claims', () => {
  for (const change of [
    { talent_tags: ['탐구', '탐구'] }, { major_relevance: '' },
    { representative_candidate: 'yes' }, { representative_candidate: true },
    { representative_reason: ' ' },
  ]) {
    const pack = guidebook(); Object.assign(pack.learning_data.activities[0].priority_assignments[0], change);
    assert.throws(() => validateGuidebook(rehash(pack), context), /priority_assignments/);
  }
});

test('single final requires an authored reviewed quiz and interview question instead of generating from prose', () => {
  assert.throws(() => validateGuidebook(removeQuizItems(guidebook()), context), /검수된 퀴즈가 적어도 하나/);
  const pendingQuestions = removeQuizItems(guidebook());
  pendingQuestions.learning_data.questions.forEach(question => { question.verification_status = 'needs_confirmation'; });
  assert.throws(() => validateGuidebook(rehash(pendingQuestions), context), /모의면접에 연결할 검수된 질문/);
  const unrelated = guidebook();
  unrelated.learning_data.memory_items[0].activity_ids = [unrelated.learning_data.activities[7].id];
  assert.throws(() => validateGuidebook(rehash(unrelated), context), /연결 질문.*포함되지 않은 활동/);
});

test('single final rejects order-only material that has no usable web quiz, preserving legacy paired imports', () => {
  const packs = pair();
  for (const pack of packs) keepQuizItems(pack, [pack.learning_data.memory_items.find(item => item.kind === 'order')!]);
  assert.doesNotThrow(() => validatePair(packs, context));
  assert.throws(() => validateGuidebook(packs[0], context), /순서 훈련만 있는 교재/);
});

test('single final requires exactly four authored choices even when other usable quizzes are present', () => {
  for (const count of [2, 3, 5]) {
    const packs = pair();
    for (const pack of packs) {
      const choice = pack.learning_data.memory_items.find(item => item.kind === 'choice')!;
      choice.options = count < 4 ? choice.options!.slice(0, count) : [...choice.options!, { id: 'e', text: '검수할 다섯 번째 선택지' }];
      keepQuizItems(pack, [choice]);
    }
    assert.doesNotThrow(() => validatePair(packs, context));
    assert.throws(() => validateGuidebook(packs[0], context), /선택지 정확히 4개/);
  }
  const withOtherQuiz = guidebook();
  withOtherQuiz.learning_data.memory_items.find(item => item.kind === 'choice')!.options!.pop();
  assert.throws(() => validateGuidebook(rehash(withOtherQuiz), context), /선택지 정확히 4개/);
});

test('single final preserves authored order exercises when a usable reviewed web quiz also exists', () => {
  const pack = guidebook();
  const order = pack.learning_data.memory_items.find(item => item.kind === 'order')!;
  const choice = pack.learning_data.memory_items.find(item => item.kind === 'choice')!;
  const result = validateGuidebook(keepQuizItems(pack, [order, choice]), context);
  assert.deepEqual(result.learning.memory_items.map(item => item.kind), ['order', 'choice']);
  assert.equal(result.learning.memory_items[1].options!.length, 4);
});

test('source-grounded general questions need no fabricated personal activity to connect to quizzes', () => {
  const pack = guidebook();
  const item = pack.learning_data.memory_items.find(item => item.kind === 'choice')!;
  const question = pack.learning_data.questions.find(question => question.id === item.question_id)!;
  question.activity_ids = [];
  item.activity_ids = [];
  assert.doesNotThrow(() => validateGuidebook(rehash(pack), context));
});

test('plain or malformed external HTML reports embedded learning-data instructions', () => {
  assert.throws(() => parseLearningHtml('<!doctype html><main data-document-kind="guidebook"><h1>최종 가이드북</h1></main>'), /외부 제작 HTML.*학습 데이터를 내장/);
  const html = renderLearningHtml(guidebook());
  assert.throws(() => parseLearningHtml(html.replace('"schema_version":"1.2.0"', '"schema_version":invalid')), /유효한 JSON/);
});

test('an optional learning target stage preserves unknown legacy snapshots while declared stages remain typed',()=>{
  for(const stage of [undefined,null,'2단계']){
    const pack=guidebook();
    pack.learning_data.support_targets[0].interview_stage=stage;
    assert.doesNotThrow(()=>validateGuidebook(rehash(pack),context));
  }
  for(const stage of ['',4,{}]){
    const pack=guidebook();
    (pack.learning_data.support_targets[0] as any).interview_stage=stage;
    assert.throws(()=>validateGuidebook(rehash(pack),context),/interview_stage/);
  }
});
