import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE_CATALOG, knowledgeSearches, matchKnowledgeVideos } from '../apps/web/src/lib/knowledge-bites-catalog';
import { connectKnowledgeQuestions, knowledgeCheckPrompt } from '../apps/web/src/lib/knowledge-flow-model';

test('microplastics links verified videos to the actual approved activity only', () => {
  const learning = { activities: [{ id: 'plastic', title: '미세 플라스틱 분리 실험', keywords: ['밀도'], activity_summary: '분리 과정의 한계를 비교했다.' }, { id: 'math', title: '수학 오답 기록', keywords: ['단위 확인'] }] };
  const matches = matchKnowledgeVideos(learning);
  const plasticVideos = matches.filter(item => ['lQRsqMiBTsI', '_6xlNyWPpB8'].includes(item.id));
  assert.equal(plasticVideos.length, 2);
  assert.ok(plasticVideos.every(item => item.activities.length === 1 && item.activities[0].id === 'plastic'));
  assert.ok(matches.filter(item => ['E91bGT9BjYk','f2O6mQkFiiw'].includes(item.id)).every(item => item.activities[0].id === 'math'));
  assert.ok(matches.every(item => item.current && item.progress === null));
});
test('reading titles and science keywords are grounded rather than broad major guesses', () => {
  const matches = matchKnowledgeVideos({ activities: [{ id: 'reading', title: '정책 독서 토론', reading_title: '탄소 중립의 원리' }, { id: 'biology', title: '효소 반응 조건', keywords: ['변인 통제'] }] });
  assert.deepEqual(matches.map(item => item.id), ['A4cPmHGegKI', 'qgVFkRn8f10', 'dItUGF8GdTw']);
  assert.deepEqual(matchKnowledgeVideos({ activities: [{ id: 'generic', title: '환경공학과 지원 이유', keywords: ['책임', '협업'] }] }), []);
});
test('short DNA/RNA English tokens require boundaries and do not match unrelated words', () => {
  assert.equal(matchKnowledgeVideos({ activities: [{ id: 'no', title: 'banana journal' }] }).length, 0);
  assert.equal(matchKnowledgeVideos({ activities: [{ id: 'yes', title: 'DNA and protein' }] })[0].id, 'oefAI2x2CQM');
});
test('only the activity-linked approved quote expands a reading topic', () => {
  const matches = matchKnowledgeVideos({ activities: [{ id: 'reading', title: '과학 독서 감상', source_ref_ids: ['reading-record'] }], source_refs: [{ id: 'reading-record', quote: '미세플라스틱의 분리 방법을 다룬 책을 읽고 독후감을 작성함.' }, { id: 'unrelated-record', quote: '항생제 내성을 설명함.' }] });
  assert.deepEqual(matches.map(item => item.id), ['lQRsqMiBTsI', '_6xlNyWPpB8']);
});
test('unmatched topics return honest encoded searches without fabricated thumbnails', () => {
  const learning = { activities: [{ id: 'unmatched', title: '읽고 쓴 이야기', book_title: '지역사 산책 & 독서', keywords: ['구술사'] }] };
  const result = knowledgeSearches(learning, matchKnowledgeVideos(learning));
  assert.equal(result[0].topic, '지역사 산책 & 독서');
  assert.equal(new URL(result[0].url).searchParams.get('search_query'), result[0].topic);
  assert.ok(!('thumbnail' in result[0]));
});
test('a broad stretch video does not replace the original book search', () => {
  const learning={activities:[{id:'ethics',title:'윤리 독서 토론',book_title:'정의란 무엇인가'}]};
  assert.ok(matchKnowledgeVideos(learning).some(video=>video.id==='yg16u_bzjPE'));
  assert.equal(knowledgeSearches(learning,matchKnowledgeVideos(learning))[0].topic,'정의란 무엇인가');
});
test('catalog uses verified publisher links and exact YouTube thumbnail IDs', () => {
  assert.equal(new Set(KNOWLEDGE_CATALOG.map(item => item.id)).size, KNOWLEDGE_CATALOG.length);
  for (const item of KNOWLEDGE_CATALOG) {
    assert.match(item.id, /^[a-zA-Z0-9_-]{11}$/);
    assert.equal(new URL(item.url).hostname, 'www.youtube.com');
    assert.equal(new URL(item.url).searchParams.get('v'), item.id);
    assert.equal(item.thumbnail, `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`);
    assert.ok(['ed.ted.com', 'www.ted.com', 'www.youtube.com'].includes(new URL(item.source).hostname));
    assert.ok(item.title && item.channel && item.verifiedAt);
    assert.ok(item.focus && item.stretch);
  }
});

test('whole-record recommendations span courses, autonomy, community, reading and verified plans', () => {
  const videos = matchKnowledgeVideos({ activities: [
    { id:'course',title:'수질과 대조 조건 비교',area:'화학 세특' },
    { id:'autonomy',title:'잔반 줄이기',area:'자율활동' },
    { id:'math',title:'통계 그래프 읽기',area:'수학 세특' },
    { id:'community',title:'동아리 역할 조율',area:'공동체 활동' },
    { id:'reading',title:'생명윤리 독서 토론',area:'독서 활동' },
  ], source_refs:[{id:'goal-record',type:'student_confirmation',quote:'진로 계획 확인'}], student_context:{confirmed_plans:[{text:'알고리즘을 공부할 계획',source_ref_ids:['goal-record'],verification_status:'confirmed_by_student'}]} });
  assert.equal(new Set(videos.map(video => video.focus)).size, 6);
  for (const id of ['course','autonomy','math','community','reading']) assert.ok(videos.some(video => video.activities.some(activity => activity.id===id)),id);
  const technology = videos.find(video => video.id==='6hfOvs8pY1k')!;
  assert.deepEqual(technology.activities,[],'a plan never invents a past activity');
  assert.deepEqual(technology.contexts,[{id:'plan:0',kind:'plan',title:'알고리즘을 공부할 계획',sourceRefIds:['goal-record']}]);
  assert.equal(connectKnowledgeQuestions([technology],[{id:'fake',prompt:'코딩을 한 경험은?',activityIds:['invented']}])[0].relatedQuestions.length,0);
});

test('unattached student-record passages stay sourced; institution and unverified goals are excluded', () => {
  const videos = matchKnowledgeVideos({ source_refs:[
    {id:'music',type:'student_record',area:'음악 세특',quote:'합주에서 악보의 리듬을 비교함.'},
    {id:'school',type:'official_admissions',quote:'알고리즘 인재를 선발함.'},
    {id:'student',type:'student_confirmation',quote:'목표 확인 필요'},
  ], student_context:{confirmed_goals:[
    {text:'항생제 연구자',source_ref_ids:['student'],verification_status:'needs_confirmation'},
    {text:'알고리즘 진로',source_ref_ids:['school'],verification_status:'confirmed'},
    {text:'효소 연구',source_ref_ids:['missing'],verification_status:'confirmed'},
  ]} });
  assert.deepEqual(videos.map(video => video.id),['ZN41d7Txcq0']);
  assert.deepEqual(videos[0].activities,[]);
  assert.deepEqual(videos[0].contexts,[{id:'record:music',kind:'record',title:'음악 세특 기록',sourceRefIds:['music'],area:'음악 세특'}]);
});

test('diverse subject lenses alternate while explicit owned question keeps first priority', () => {
  const videos=matchKnowledgeVideos({activities:[{id:'lab',title:'미세플라스틱과 수질 탐구',keywords:['대조조건','통계','잔반','의사소통']}]});
  const diverse=connectKnowledgeQuestions(videos,[]);
  assert.equal(new Set(diverse.slice(0,4).map(video=>video.focus)).size,4);
  assert.equal(new Set(diverse.map(video=>video.id)).size,videos.length);
  const requested=connectKnowledgeQuestions(videos,[{id:'owned',prompt:'탐구의 한계는?',activityIds:['lab']}],'owned');
  assert.ok(requested.every(video=>video.relatedQuestions[0]?.id==='owned'));
  assert.equal(requested[0].recommendedReason,'방금 연습한 질문과 연결돼요');
});

test('multiple weak science activities cannot bury other record areas and requested question still anchors first', () => {
  const videos=matchKnowledgeVideos({activities:[
    {id:'plastic',title:'미세플라스틱 분리 실험',keywords:['실험오차']},
    {id:'water',title:'수질 측정 탐구',keywords:['대조조건']},
    {id:'forest',title:'도시숲과 생물다양성 탐구'},
    {id:'math',title:'통계 그래프 분석'},
    {id:'community',title:'동아리 역할 조율'},
    {id:'reading',title:'생명윤리 독서 토론'},
  ]});
  const questions=[{id:'weak-plastic',prompt:'실험의 한계는?',activityIds:['plastic'],needsReview:true},{id:'weak-water',prompt:'대조 조건은?',activityIds:['water'],needsReview:true},{id:'current-reading',prompt:'선택의 책임은?',activityIds:['reading']}];
  const result=connectKnowledgeQuestions(videos,questions);
  assert.equal(new Set(result.slice(0,5).map(video=>video.focus)).size,5,'first five include all five available subject lenses');
  assert.equal(result[0].recommendedReason,'다시 확인할 질문의 활동이에요');
  const science=result.filter(video=>video.focus==='science');
  const firstNonWeak=science.findIndex(video=>!video.relatedQuestions.some(question=>question.needsReview));
  assert.ok(firstNonWeak>0);
  assert.ok(science.slice(firstNonWeak).every(video=>!video.relatedQuestions.some(question=>question.needsReview)),'weak priority is retained within science');
  const requested=connectKnowledgeQuestions(videos,questions,'current-reading');
  assert.equal(requested[0].id,'yg16u_bzjPE');
  assert.equal(requested[0].relatedQuestions[0].id,'current-reading');
  assert.equal(new Set(requested.slice(0,5).map(video=>video.focus)).size,5);
  assert.equal(new Set(result.map(video=>video.id)).size,videos.length);
});
test('unpublished or empty learning cannot produce public recommendations', () => {
  assert.deepEqual(matchKnowledgeVideos({}), []);
  assert.deepEqual(knowledgeSearches({}, []), []);
  assert.deepEqual(matchKnowledgeVideos({ activities: [{ id: '', title: '미세플라스틱' }] }), []);
});
test('requested question and current weak questions rank only genuinely connected videos', () => {
  const videos = matchKnowledgeVideos({ activities: [{ id:'plastic',title:'미세플라스틱 분리' },{id:'enzyme',title:'효소 반응 조건'}] });
  const questions = [{id:'q-plastic',prompt:'분리 조건은?',activityIds:['plastic'],needsReview:true},{id:'q-enzyme',prompt:'온도 조건은?',activityIds:['enzyme']},{id:'q-other',prompt:'대학 지원 이유는?',activityIds:['unknown']}];
  const weakFirst = connectKnowledgeQuestions(videos,questions);
  assert.equal(weakFirst[0].id,'lQRsqMiBTsI');
  assert.equal(weakFirst[0].recommendedReason,'다시 확인할 질문의 활동이에요');
  const selected = connectKnowledgeQuestions(videos,questions,'q-enzyme');
  assert.equal(selected[0].id,'qgVFkRn8f10');
  assert.deepEqual(selected[0].relatedQuestions.map(question=>question.id),['q-enzyme']);
  assert.ok(selected.every(video=>video.relatedQuestions.every(question=>question.id!=='q-other')));
});
test('historical video snapshots do not gain current questions and selfchecks do not invent an answer', () => {
  const [video]=matchKnowledgeVideos({activities:[{id:'plastic',title:'미세플라스틱 활동'}]});
  const result=connectKnowledgeQuestions([{...video,current:false}],[{id:'q',prompt:'분리 조건은?',activityIds:['plastic']}],'q');
  assert.equal(result[0].relatedQuestions.length,0);
  assert.equal(result[0].recommendedReason,'');
  assert.match(knowledgeCheckPrompt('미세플라스틱'),/기억할 개념 하나와 아직 확인할 점/);
  const check=knowledgeCheckPrompt('미세플라스틱',{id:'q',prompt:'분리 조건은?',activityIds:['plastic']});
  assert.match(check,/위 질문/);assert.match(check,/내 활동의 근거/);assert.doesNotMatch(check,/\?에/);
});
