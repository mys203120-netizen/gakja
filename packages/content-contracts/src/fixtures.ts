import { FINAL_TOC, SCHEMA_VERSION, TOC_VERSION, hashLearningData, type Activity, type BookBlock, type BookDocument, type LearningData, type LearningPack, type MemoryItem, type Priority } from './index';

type Track = 'environment' | 'biology';
interface Experience {
  title: string; grade: number; area: string; summary: string; motivation: string;
  role: string; process: string; result: string; lessons: string; keywords: string[];
}
const EXPERIENCES: Record<Track, Experience[]> = {
  environment: [
    { title: '학교 주변 하천 수질 탐구', grade: 3, area: '화학Ⅱ 세특', summary: '같은 하천의 세 지점에서 채취한 물의 pH와 탁도를 비교하고 강우 전후 조건을 구분했다.', motivation: '비가 온 뒤 하천 색이 달라지는 이유가 궁금했다.', role: '채취 지점과 비교 조건을 설계하고 측정 기록을 정리했다.', process: '지점별로 같은 시간에 채취하고 측정 도구를 보정한 뒤 반복 측정했다.', result: '강우 직후 탁도 변화가 컸지만 pH만으로 오염 원인을 판단하기 어렵다는 점을 확인했다.', lessons: '측정값을 설명하려면 환경 조건과 측정 한계를 함께 밝혀야 한다.', keywords: ['수질', '대조 조건', '측정 한계'] },
    { title: '급식 잔반 줄이기 프로젝트', grade: 2, area: '자율활동', summary: '일주일 동안 급식 잔반량을 기록하고 메뉴 선호 조사와 연결해 소량 배식 선택안을 제안했다.', motivation: '캠페인만으로 잔반이 줄지 않는 이유를 알아보고 싶었다.', role: '조사 문항을 만들고 학생회와 급식실의 의견을 조율했다.', process: '메뉴와 배식량, 잔반의 관계를 살펴보고 익명 설문을 실시했다.', result: '소량 배식 선택안을 시범 운영하기로 합의했다. 효과 수치는 추가 관찰이 필요하다.', lessons: '실행 가능한 환경 개선은 이용자의 선택과 운영 조건을 함께 고려해야 한다.', keywords: ['환경 실천', '의견 조율', '실행 가능성'] },
    { title: '미세플라스틱 분리 실험', grade: 2, area: '과학 동아리', summary: '입자 밀도 차이를 이용한 분리 실험에서 회수 과정과 오차 요인을 비교했다.', motivation: '미세플라스틱을 실제로 어떻게 분리하는지 궁금했다.', role: '시료 준비와 실험 도구 세척 절차를 맡았다.', process: '염수 농도와 교반 시간을 바꾸고 동일한 체로 입자를 회수했다.', result: '가벼운 입자는 분리되었지만 모든 재질을 같은 조건에서 회수할 수는 없었다.', lessons: '육안 분류를 확정적인 재질 분석으로 표현하지 않도록 주의했다.', keywords: ['밀도', '회수율', '실험 오차'] },
    { title: '도시 열섬 자료 분석', grade: 3, area: '지구과학Ⅱ 세특', summary: '공개 온도 자료를 비교하며 관측 시간과 지표면 조건이 해석에 미치는 영향을 분석했다.', motivation: '같은 도시에서도 체감 온도가 다른 이유를 설명하고 싶었다.', role: '자료의 관측 조건을 확인하고 비교 표를 작성했다.', process: '낮과 밤 자료를 나누고 녹지 비율과 주변 포장 상태를 비교했다.', result: '하나의 관측일로 녹지의 효과를 일반화할 수 없다는 한계를 정리했다.', lessons: '상관관계와 원인을 구분하고 추가 측정 계획을 세웠다.', keywords: ['열섬', '관측 조건', '상관관계'] },
    { title: '흡착 소재 비교 탐구', grade: 2, area: '화학Ⅰ 세특', summary: '활성탄과 다공성 소재의 표면 구조를 조사하고 흡착과 흡수의 차이를 정리했다.', motivation: '정수 필터의 성능을 결정하는 요인이 궁금했다.', role: '문헌의 조건을 비교하고 개념 설명 자료를 만들었다.', process: '표면적, 농도, 접촉 시간에 따른 차이를 구분했다.', result: '서로 다른 실험 조건의 수치를 직접 순위로 비교하면 안 된다는 점을 정리했다.', lessons: '수치 비교에는 동일한 조건과 단위 확인이 선행되어야 한다.', keywords: ['흡착', '표면적', '단위 확인'] },
    { title: '수학 학습 기록 개선', grade: 1, area: '수학 세특', summary: '틀린 문제를 계산 실수와 개념 적용 오류로 나누고 풀이 근거를 말로 설명하는 학습을 지속했다.', motivation: '같은 유형의 오류를 반복하는 원인을 찾고 싶었다.', role: '오답 기록을 스스로 분류하고 학습 계획을 수정했다.', process: '풀이 단계마다 사용한 개념을 적고 친구에게 설명했다.', result: '조건을 빠뜨리는 오류를 먼저 확인하는 습관을 만들었다.', lessons: '결과보다 오류가 생기는 과정을 관찰하는 것이 도움이 됐다.', keywords: ['자기주도', '오류 분석', '설명'] },
    { title: '동아리 실험 역할 조율', grade: 2, area: '공동체 활동', summary: '실험 준비 시간이 겹친 팀원들의 업무를 나누고 공통 기록 양식을 제안했다.', motivation: '참여 시간이 다른 팀원도 실험 과정을 함께 이해하도록 돕고 싶었다.', role: '준비 담당과 측정 담당의 역할을 조율했다.', process: '가능한 시간을 듣고 모든 팀원이 기록을 확인하도록 공유했다.', result: '인수인계 내용을 확인하며 같은 실험을 반복할 수 있었다.', lessons: '리더십은 먼저 역할을 정하는 것보다 상대의 상황을 듣는 일에서 시작했다.', keywords: ['협업', '의사소통', '기록 공유'] },
    { title: '환경 정책 독서 토론', grade: 3, area: '독서·토론', summary: '가상 토론 자료를 바탕으로 탄소 감축 정책의 효과와 비용 부담에 관한 논거를 비교했다.', motivation: '환경 기술이 사회에서 채택되는 조건을 이해하고 싶었다.', role: '찬반 논거를 정리하고 출처 확인 질문을 맡았다.', process: '정책의 목표, 비용 부담 주체, 대안을 나누어 토론했다.', result: '효율성과 형평성을 동시에 검토할 질문을 만들었다.', lessons: '의견을 말할 때 사실과 가치 판단을 구분해야 한다.', keywords: ['탄소 감축', '형평성', '근거 검토'] },
  ],
  biology: [
    { title: '효소 반응 조건 탐구', grade: 3, area: '생명과학Ⅱ 세특', summary: '온도와 pH에 따른 효소 반응을 비교하며 대조군과 반복 측정의 필요성을 정리했다.', motivation: '효소가 작용하기 좋은 조건을 직접 확인하고 싶었다.', role: '변인 통제와 측정 순서 설계를 맡았다.', process: '기질량과 반응 시간을 고정하고 온도 조건을 달리했다.', result: '측정 도구의 해상도 때문에 작은 차이를 확정하기 어렵다는 한계를 밝혔다.', lessons: '관측 결과와 분자 수준의 설명을 구분해야 한다.', keywords: ['효소', '변인 통제', '대조군'] },
    { title: '항생제 내성 자료 탐구', grade: 2, area: '과학 동아리', summary: '미생물 배양 없이 승인된 가상 학습 자료의 내성 변화 그래프를 읽고 선택압을 설명했다.', motivation: '항생제 사용과 내성의 관계를 정확히 이해하고 싶었다.', role: '그래프의 조건과 용어를 확인하고 발표를 맡았다.', process: '변이 발생과 선택 과정을 구분하고 서로 다른 조건의 자료를 비교했다.', result: '항생제가 목적에 맞게 내성을 만들어낸다는 오해를 정정했다.', lessons: '개체 변화와 집단 변화의 설명 수준을 구분했다.', keywords: ['내성', '선택압', '집단 변화'] },
    { title: '삼투 현상 비교 실험', grade: 2, area: '생명과학Ⅰ 세특', summary: '용액 농도에 따른 감자 시료 질량 변화를 반복 측정했다.', motivation: '세포의 수분 이동을 일상적인 재료로 관찰하고 싶었다.', role: '시료 크기와 측정 전 수분 제거 절차를 맞췄다.', process: '농도별 시료를 같은 시간 동안 두고 질량을 비교했다.', result: '표면에 남은 용액이 측정값을 바꿀 수 있음을 확인했다.', lessons: '예상과 다른 결과를 버리지 않고 절차에서 원인을 찾았다.', keywords: ['삼투', '농도', '측정 오차'] },
    { title: '생태 다양성 관찰 기록', grade: 3, area: '진로활동', summary: '학교 화단의 관찰 구역과 시간을 정해 생물 출현을 기록하고 관측 편향을 검토했다.', motivation: '생물 다양성을 관찰한 횟수만으로 비교해도 되는지 궁금했다.', role: '관찰표와 동일한 조사 절차를 제안했다.', process: '날씨와 시간, 관측 구역을 함께 기록했다.', result: '발견되지 않은 생물을 존재하지 않는다고 해석할 수 없음을 정리했다.', lessons: '관측 가능성과 실제 분포의 차이를 고려해야 한다.', keywords: ['다양성', '관측 편향', '기록'] },
    { title: '유전자 발현 개념 발표', grade: 2, area: '생명과학 동아리', summary: 'DNA, RNA, 단백질의 관계를 모델로 표현하고 모델의 한계를 설명했다.', motivation: '유전 정보가 단백질로 연결되는 흐름을 쉽게 설명하고 싶었다.', role: '시각 자료 제작과 질문 답변을 맡았다.', process: '전사와 번역의 위치·역할을 구분하고 개념도를 수정했다.', result: '모든 유전자가 항상 발현된다는 표현을 고쳤다.', lessons: '쉬운 설명에도 조건과 예외를 남겨야 한다.', keywords: ['전사', '번역', '모델의 한계'] },
    { title: '화학 학습 기록 개선', grade: 1, area: '화학Ⅰ 세특', summary: '계산 오류와 개념 연결 오류를 구분하고 분자 수준에서 풀이를 설명했다.', motivation: '암기한 식을 적용해도 틀리는 이유를 찾고 싶었다.', role: '오답을 분류하고 복습 계획을 직접 세웠다.', process: '반응식과 입자 모형을 연결해 설명하는 연습을 했다.', result: '단위와 반응 조건을 먼저 확인하는 습관을 만들었다.', lessons: '개념을 자신의 언어로 설명할 때 이해의 빈틈이 드러났다.', keywords: ['자기주도', '개념 연결', '단위'] },
    { title: '동아리 발표 의견 조율', grade: 2, area: '공동체 활동', summary: '발표 내용의 난이도에 관한 의견 차이를 듣고 핵심 설명과 심화 자료를 분리했다.', motivation: '청중이 이해하면서도 정확성을 유지하는 발표를 만들고 싶었다.', role: '팀원과 청중의 관점을 정리해 대안을 제시했다.', process: '용어를 쉬운 문장으로 바꾸고 심화 질문 자료를 준비했다.', result: '발표 후 질문을 기록해 다음 설명을 보완했다.', lessons: '협업에서는 의견의 목적을 먼저 확인하는 태도가 도움이 됐다.', keywords: ['협업', '의사소통', '청중 이해'] },
    { title: '생명 연구 윤리 토론', grade: 3, area: '독서·토론', summary: '가상 연구 사례에서 동의, 개인정보, 연구 목적을 구분하고 필요한 검토 질문을 만들었다.', motivation: '연구의 가능성과 책임을 함께 생각하고 싶었다.', role: '사례의 사실과 의견을 나누어 정리했다.', process: '연구 참여자의 선택과 데이터 사용 범위를 비교했다.', result: '좋은 목적만으로 모든 연구 방법이 정당화되지는 않는다는 입장을 정리했다.', lessons: '찬반 결론보다 판단에 필요한 조건을 구체화했다.', keywords: ['연구 윤리', '동의', '책임'] },
  ],
};

/** Deliberately fabricated testing content; it never impersonates a real institution. */
export function createDemoPack(studentId: string, name: string, track: Track): [LearningPack, LearningPack] {
  if (!studentId.trim() || !name.trim() || !EXPERIENCES[track]) throw new Error('studentId, name, environment/biology track are required');
  const experiences = EXPERIENCES[track];
  const major = track === 'environment' ? '환경공학과' : '생명과학과';
  const goal = track === 'environment' ? '측정과 검증을 바탕으로 환경 문제를 해결하는 연구자' : '생명 현상을 탐구하고 연구의 책임을 함께 고민하는 연구자';
  const priorities: Priority[] = ['S', 'A', 'A', 'B', 'B', 'C', 'A', 'B'];
  const sourceId = (i: number) => `${studentId}-src-${i + 1}`;
  const activityId = (i: number) => `${studentId}-act-${i + 1}`;
  const questionId = (i: number) => `${studentId}-q-${i + 1}`;
  const scriptId = (i: number) => `${studentId}-answer-${i + 1}`;
  const targetId = (i: number) => `${studentId}-target-${i + 1}`;
  const syntheticStatus = 'synthetic_reviewed';
  const sourceRefs: LearningData['source_refs'] = experiences.map((e, i) => ({ id: sourceId(i), type: 'student_record', revision: 1, page: i + 3, area: e.area, quote: `${e.summary} ${e.role} ${e.lessons}`, synthetic: true }));
  sourceRefs.push({ id: `${studentId}-src-goal`, type: 'student_confirmation', revision: 1, quote: `${name} 테스트 학생의 가상 목표: ${goal}. 대학에서 기초 과학과 통계를 배우고 학부 탐구 프로젝트에 참여하고 싶다.`, synthetic: true });
  sourceRefs.push({ id: `${studentId}-src-target`, type: 'synthetic_institution', revision: 1, quote: '한빛모의대학교·새봄모의대학교는 기능 확인을 위해 만든 가상 기관이다. 교육과정·전형·평가요소·면접 일정 모두 테스트 자료이며 실제 입학 정보를 뜻하지 않는다.', synthetic: true });
  sourceRefs.push({ id: `${studentId}-src-concept`, type: 'synthetic_learning_material', revision: 1, quote: track === 'environment' ? '흡착은 물질이 다른 물질의 표면에 붙는 현상이다. 측정 실험에서 대조 조건은 비교의 기준이며 하나의 변인을 바꾸어 결과를 관찰한다.' : '효소는 반응의 활성화 에너지를 낮추는 생체 촉매다. 전사는 DNA의 정보를 RNA로 옮기는 과정이며 번역은 RNA 정보에 따라 단백질을 합성하는 과정이다.', synthetic: true });
  const criteriaVersion = 'activity-priority-v1.0';
  const supportTargets: LearningData['support_targets'] = ['한빛모의대학교', '새봄모의대학교'].map((university, i) => ({
    id: targetId(i), student_id: studentId, university, campus: '가상 본교', department: major,
    admission_type: i === 0 ? '가상 학생부종합 탐구전형' : '가상 학생부종합 성장전형', admission_year: 2027,
    verification_status: syntheticStatus,
    field_sources: Object.fromEntries(['university', 'campus', 'department', 'admission_type', 'admission_year'].map(field => [field, { source_ref_ids: [`${studentId}-src-target`], verification_status: syntheticStatus }])),
    talent_tags: ['탐구', '협업', '책임'], evaluation_elements: ['탐구 과정', '본인 역할', '학습 확장'],
    major_connection: `${major}와 연결한 탐구의 과정·한계·다음 질문을 설명한다. 가상 지원처의 테스트 평가 맥락이다.`,
    source_ref_ids: [`${studentId}-src-target`], knowledge_release_refs: [], synthetic: true,
  }));
  const activities: Activity[] = experiences.map((e, i) => ({
    id: activityId(i), title: e.title, grade: e.grade, area: e.area, activity_summary: e.summary,
    interview_priority: priorities[i], priority_reason: `${e.role} ${e.lessons}`,
    priority_assignments: supportTargets.map((target, j) => ({ support_target_id: target.id, priority: j === 1 && i === 3 ? 'A' : priorities[i], reason: `${target.university}의 가상 평가 맥락에서 ${e.keywords[0]}와 ${e.keywords[2]}을 설명할 소재로 검토했다. 등급은 기능 확인용 판정이다.`, source_ref_ids: [sourceId(i), `${studentId}-src-target`], criteria_version: criteriaVersion })),
    talent_tags: i === 6 ? ['협업', '의사소통'] : ['탐구', '자기주도'], major_relevance: i === 5 || i === 6 ? '학습 태도와 협업 경험' : `${major}와 연결되는 ${e.keywords[0]} 탐구`,
    source_ref_ids: [sourceId(i)], fact_confirmation: syntheticStatus,
    motivation: e.motivation, role: e.role, process: e.process, result: e.result, lessons: e.lessons, keywords: e.keywords,
  }));
  const concepts = track === 'environment' ? [
    { prompt: '흡착을 설명하는 문장을 골라보세요.', keywords: ['흡착', '표면'], options: ['물질이 다른 물질의 표면에 붙는 현상', '물질이 다른 물질의 내부로 스며드는 현상', '표면에 붙은 물질을 모두 제거하는 현상', '표면의 접촉 없이 물질이 사라지는 현상'] },
    { prompt: '측정 실험에서 대조 조건은 어떤 역할을 하나요?', keywords: ['대조 조건', '비교 기준'], options: ['결과를 비교하는 기준이 된다', '실험 결과를 미리 결정한다', '비교에서 제외할 자료를 정한다', '모든 변인을 동시에 바꾸는 조건이 된다'] },
    { prompt: '측정 실험에서 변인을 바꾸는 방법으로 알맞은 것은?', keywords: ['하나의 변인', '결과 관찰'], options: ['하나의 변인을 바꾸고 결과를 관찰한다', '여러 변인을 동시에 바꾸고 결과만 기록한다', '변인을 바꾸지 않고 결과를 미리 확정한다', '결과는 관찰하지 않고 변인 이름만 기록한다'] },
  ] : [
    { prompt: '효소의 역할을 설명하는 문장을 골라보세요.', keywords: ['효소', '활성화 에너지'], options: ['반응의 활성화 에너지를 낮추는 생체 촉매', '반응이 끝날 때마다 반드시 소모되는 물질', '어떤 온도에서도 동일한 속도로 작용하는 물질', '활성화 에너지를 높여 반응을 느리게 만드는 물질'] },
    { prompt: '전사는 어떤 과정인가요?', keywords: ['전사', 'DNA', 'RNA'], options: ['DNA의 정보를 RNA로 옮기는 과정', 'RNA 정보에 따라 단백질을 합성하는 과정', '단백질의 정보를 DNA로 옮기는 과정', 'DNA의 정보를 직접 단백질로 옮기는 과정'] },
    { prompt: '번역은 어떤 과정인가요?', keywords: ['번역', 'RNA', '단백질'], options: ['RNA 정보에 따라 단백질을 합성하는 과정', 'DNA의 정보를 RNA로 옮기는 과정', '단백질의 정보를 RNA로 옮기는 과정', 'RNA의 정보를 DNA로 옮기는 과정'] },
  ];
  const conceptQuestions:LearningData['questions']=concepts.map((concept,i)=>({
    id:`${studentId}-concept-q-${i+1}`,
    prompt:concept.prompt.replace(/설명하는 문장을 골라보세요[.!]?$/,'내 말로 설명해 주세요.').replace(/방법으로 알맞은 것은[?？]?$/,'방법을 내 말로 설명해 주세요.'),
    question_intent:'검수된 학습 자료의 개념을 자신의 말로 설명하는지 확인한다.',grounding_types:['document_based'],question_types:['concept','major'],
    activity_ids:[activityId((track==='environment'?[4,0,2]:[0,4,4])[i])],support_target_ids:supportTargets.map(target=>target.id),source_ref_ids:[`${studentId}-src-concept`],
    evaluation_links:[],answer_elements:concept.keywords,answer_structure:['핵심 개념','관련 조건과 구분'],followup_question_ids:[],verification_status:syntheticStatus,interview_priority:'A',
  }));
  const prompts = [
    `‘${experiences[0].title}’에서 본인이 맡은 역할과 가장 어려웠던 점은 무엇인가요?`,
    `‘${experiences[1].title}’를 시작한 이유와 진행 과정을 설명해 주세요.`,
    `‘${experiences[2].title}’의 비교 조건을 어떻게 맞추었나요?`,
    `‘${experiences[3].title}’에서 결과를 해석할 때 주의한 점은 무엇인가요?`,
    `‘${experiences[4].title}’에서 배운 핵심 개념을 설명해 주세요.`,
    '학습 과정에서 반복했던 오류를 어떻게 발견하고 개선했나요?',
    '팀원과 의견이 달랐을 때 어떤 행동으로 문제를 풀었나요?',
    `‘${experiences[7].title}’에서 자신의 의견을 바꾸거나 보완한 이유가 있나요?`,
    '자신을 세 가지 키워드로 소개해 주세요.',
    `${major}에 관심을 갖게 된 계기와 지원 이유는 무엇인가요?`,
    '입학 후 배우고 싶은 내용과 탐구 계획을 설명해 주세요.',
    '지금의 탐구를 다시 진행한다면 무엇을 바꾸겠어요?',
  ];
  const questionActivities = prompts.map((_, i) => i < 8 ? [activityId(i)] : i === 8 ? [activityId(0), activityId(6)] : i === 11 ? [activityId(0)] : [activityId(0), activityId(4)]);
  const questions: LearningData['questions'] = prompts.map((prompt, i) => ({
    id: questionId(i), prompt, question_intent: i === 6 ? '본인의 실제 행동과 상대 의견을 존중하는 태도를 확인한다.' : i >= 8 && i <= 10 ? '확인된 목표와 활동 사이의 연결을 확인한다.' : '활동의 동기·본인 역할·과정·결과·한계를 구체적으로 확인한다.',
    grounding_types: i >= 8 && i <= 10 ? ['student_confirmed', 'document_based'] : ['document_based'],
    question_types: i === 6 ? ['community', 'talent'] : i === 8 ? ['self_introduction', 'common'] : i === 9 ? ['motivation', 'university'] : i === 10 ? ['academic_plan', 'career'] : i === 11 ? ['followup', 'verification'] : ['activity', i === 5 ? 'academic' : 'major'],
    activity_ids: questionActivities[i], support_target_ids: supportTargets.map(t => t.id),
    source_ref_ids: i >= 8 && i <= 10 ? [sourceId(0), sourceId(6), `${studentId}-src-goal`, `${studentId}-src-target`] : [sourceId(i < 8 ? i : 0)],
    evaluation_links: supportTargets.map(t => ({ support_target_id: t.id, element: i === 6 ? '본인 역할' : '탐구 과정', source_ref_ids: [`${studentId}-src-target`] })),
    answer_elements: i >= 8 && i <= 10 ? ['핵심 목표', '대표 경험', '확인된 학업 계획'] : ['동기', '본인 역할', '실제 행동', '결과와 한계', '배운 점'],
    answer_structure: i >= 8 && i <= 10 ? ['목표', '경험', '계획'] : ['동기', '역할', '과정', '결과', '배운 점'],
    followup_question_ids: i === 0 || i === 3 ? [questionId(11)] : [], verification_status: syntheticStatus, interview_priority: i === 0 || i === 9 ? 'S' : i <= 7 ? priorities[i] : 'A',
  }));
  const answerScripts: LearningData['answer_scripts'] = questions.map((q, i) => {
    const e = experiences[i < 8 ? i : 0];
    // The first question asks about the student's role. A difficulty was never
    // recorded, so the hint starts with the recorded role and invents no obstacle.
    const text = i === 0 ? `${e.role} ${e.process} ${e.result} ${e.lessons}` : i < 8 ? `${e.motivation} ${e.role} ${e.process} ${e.result} ${e.lessons}`
      : i === 8 ? `저를 설명하는 키워드는 탐구, 검증, 협업입니다. ${experiences[0].role} ${experiences[6].lessons} 이러한 경험을 바탕으로 ${goal}가 되고 싶습니다.`
      : i === 9 ? `${experiences[0].motivation} ${experiences[0].lessons} 현상을 측정하고 설명하는 방법을 더 배우고 싶어 ${major}에 관심을 갖게 됐습니다.`
      : i === 10 ? `기초 과학과 통계를 체계적으로 배우고 싶습니다. ${experiences[0].title}에서 확인한 측정 한계를 바탕으로 학부 탐구 프로젝트에 참여해 더 정교한 비교 방법을 익히고 싶습니다.`
      : `조건을 더 엄밀하게 기록하고 반복 측정 횟수를 늘리고 싶습니다. ${experiences[0].result} 결과를 일반화하기 전에 관측 조건을 먼저 확인하겠습니다.`;
    return { id: scriptId(i), question_id: q.id, revision: 1, text, verification_status: syntheticStatus, source_ref_ids: q.source_ref_ids, claims: text.split(/(?<=[.!?])\s+/).filter(Boolean).map(sentence => ({ text: sentence, fact_kind: i >= 8 ? 'confirmed_plan_or_interpretation' : 'student_record_experience', source_ref_ids: q.source_ref_ids, verification_status: syntheticStatus })) };
  });
  const kinds: MemoryItem['kind'][] = ['keyword_recall', 'order', 'choice', 'flip_card'];
  const memoryItems: MemoryItem[] = questions.map((q, i) => {
    const kind = kinds[i % kinds.length];
    const e = experiences[i < 8 ? i : 0];
    const common: MemoryItem = { id: `${studentId}-memory-${i + 1}`, kind, question_id: q.id, answer_script_id: scriptId(i), activity_ids: q.activity_ids, prompt: kind === 'keyword_recall' ? '10초 안에 답변을 복원할 핵심어를 떠올려 보세요.' : kind === 'order' ? '내 답변의 흐름을 구성해 보세요.' : kind === 'flip_card' ? q.prompt : track === 'environment' ? '흡착을 설명하는 문장을 골라보세요.' : '효소의 역할을 설명하는 문장을 골라보세요.', memory_keywords: e.keywords, default_time_limit_seconds: kind === 'keyword_recall' ? 10 : 30, evaluation_method: kind === 'choice' ? 'reviewed_correct_answer' : 'self_check', source_ref_ids: kind === 'choice' ? [`${studentId}-src-concept`] : q.source_ref_ids, verification_status: syntheticStatus };
    if (kind === 'choice') {
      // Each definition is quoted by src-concept; the alternatives test a
      // different mistaken relation rather than repeating the same distractor.
      const ci=Math.floor(i / kinds.length) % concepts.length,concept = concepts[ci];
      return { ...common, category:'concept', question_id:conceptQuestions[ci].id, activity_ids:conceptQuestions[ci].activity_ids, prompt: concept.prompt, answer_script_id: null, options: concept.options.map((text, index) => ({ id: ['a','b','c','d'][index], text })), correct_option_id: 'a', memory_keywords: concept.keywords };
    }
    if (kind === 'order') return { ...common, sequence: [{ id: 'motivation', text: '왜 시작했는지' }, { id: 'role', text: '내가 맡은 역할' }, { id: 'process', text: '실제로 한 행동' }, { id: 'result', text: '결과와 한계' }, { id: 'lesson', text: '배운 점' }], correct_order: ['motivation', 'role', 'process', 'result', 'lesson'] };
    if (kind === 'flip_card') return { ...common, back: `${e.keywords.join(' → ')}\n${e.lessons}` };
    return common;
  });
  questions.push(...conceptQuestions);
  const learning: LearningData = {
    criteria_version: criteriaVersion, knowledge_release_refs: [],
    student_context: { student_id: studentId, name, core_keywords: ['탐구', '검증', '협업', ...experiences[0].keywords], career_academic_flow: [{ grade: 1, focus: '기초 과목의 개념과 학습 방법 점검', source_ref_ids: [sourceId(5)] }, { grade: 2, focus: '동아리와 교과 탐구에서 비교 조건·본인 역할 확인', source_ref_ids: [sourceId(1), sourceId(2), sourceId(4)] }, { grade: 3, focus: `${major} 관심을 측정·해석·책임 있는 탐구로 연결`, source_ref_ids: [sourceId(0), sourceId(3), sourceId(7)] }], representative_activity_ids: [activityId(0), activityId(1), activityId(6)], confirmed_goals: [{ text: goal, source_ref_ids: [`${studentId}-src-goal`], verification_status: syntheticStatus }], confirmed_plans: [{ text: '기초 과학과 통계를 배우고 학부 탐구 프로젝트에 참여한다.', source_ref_ids: [`${studentId}-src-goal`], verification_status: syntheticStatus }], source_ref_ids: [sourceId(0), sourceId(6), `${studentId}-src-goal`], synthetic: true },
    support_targets: supportTargets, source_refs: sourceRefs, activities, questions,
    answer_designs: questions.map((q, i) => ({ id: `${studentId}-design-${i + 1}`, question_id: q.id, materials: q.activity_ids.map(id => activities.find(a => a.id === id)!.title), structure: q.answer_structure, required_meanings: q.answer_elements, source_ref_ids: q.source_ref_ids })),
    answer_scripts: answerScripts,
    memory_keywords: answerScripts.map((script, i) => ({ id: `${studentId}-keywords-${i + 1}`, answer_script_id: script.id, activity_ids: questions[i].activity_ids, keywords: experiences[i < 8 ? i : 0].keywords, logical_structure: questions[i].answer_structure, example: experiences[i < 8 ? i : 0].process })),
    memory_items: memoryItems,
  };
  const guideTexts: string[][] = [
    ['대표 활동의 원문과 내가 한 행동을 확인한다. 질문별 답변을 내 언어로 정리한 뒤 키워드를 회상하고 모의면접에서 말해 본다.', '우선도는 지원처별 판정과 사유를 함께 읽는다. 확인 필요 표시가 있다면 경험을 확정해서 말하기 전에 먼저 확인한다.'],
    [supportTargets.map(t => `${t.university} · ${t.department} · ${t.admission_type}`).join('\n'), learning.student_context.career_academic_flow.map(f => `${f.grade}학년: ${f.focus}`).join('\n'), learning.student_context.core_keywords.join(' · '), activities.filter(a => learning.student_context.representative_activity_ids.includes(a.id)).map(a => `${a.title}: ${a.role}`).join('\n'), '같은 활동이라도 지원처에 따라 먼저 준비할 이유가 다르다. 등급과 함께 해당 지원처·판정 사유·근거를 확인한다.'],
    ['가상 학생 자료에는 실제 학적번호·주소·주민등록번호·연락처를 넣지 않았다. 출결·수상·자격의 사실 확인은 별도 원문 확인 대상이다.', `${experiences[1].summary}\n${experiences[6].role}`, `${experiences[0].summary}\n${experiences[5].lessons}`, `${experiences[7].summary}\n${experiences[6].lessons}`, `${experiences[5].lessons}\n${experiences[0].lessons}`],
    [`${supportTargets[0].university} ${major}는 테스트용 가상 지원처다. 실제 교육과정은 등록·승인된 공식 근거를 통해 확인한다.`, supportTargets[0].evaluation_elements.join(' · '), '가상 전형에서는 활동의 본인 역할·탐구 과정·한계를 묻는 상황으로 기능을 확인한다. 실제 방식과 평가 구조는 공식 자료 확인이 필요하다.', `${experiences[0].title}: ${experiences[0].keywords.join(' · ')}\n${experiences[6].title}: ${experiences[6].keywords.join(' · ')}`, `${experiences[0].role}\n${experiences[0].lessons}`],
    [questions.filter(q => q.interview_priority === 'S').map(q => q.prompt).join('\n'), questions.slice(0, 4).map(q => q.prompt).join('\n'), questions.slice(4, 6).map(q => q.prompt).join('\n'), questions[6].prompt, questions.slice(8, 11).map(q => q.prompt).join('\n'), '핵심 메시지 → 내가 맡은 역할 → 실제 행동 → 결과와 한계 → 배운 점. 문장 전체보다 질문에 필요한 의미 요소를 먼저 확인한다.', questions[11].prompt],
    ['동기 → 역할 → 과정 → 결과 → 배운 점. 순서를 고정된 정답으로 외우기보다 질문에 맞는 요소를 복원한다.', '첫 문장에 질문에 대한 답을 두고, 본인이 한 행동을 구체적으로 말한다. 연습 후 답변 길이와 빠진 요소를 확인한다.', '질문의 조건을 확인한다. 기억나지 않는 사실은 추측하지 않는다. 한계를 인정한 뒤 확인 가능한 근거로 설명한다.', '내용 연습은 채팅, 발화 연습은 질문별 녹화를 활용한다. 끝난 뒤 빠진 요소를 확인하고 같은 질문을 다시 연습한다.', '지원처·일정·이동 경로·준비물을 확인한다. 활동명·수치·책 제목처럼 헷갈리기 쉬운 사실을 다시 점검한다.'],
    [questions.map((q, i) => `${i + 1}. ${q.prompt}`).join('\n'), sourceRefs.slice(0, 8).map(s => `${s.area} · 원문 ${s.page}쪽\n${s.quote}`).join('\n'), `${sourceRefs.find(s => s.id === `${studentId}-src-concept`)?.quote}\n지원처 정보는 가상 테스트 자료다.`, '질문 / 말한 내용 / 빠진 요소 / 다시 확인할 사실 / 다음 연습. 모의면접 기록과 리포트에서 이어서 작성한다.'],
  ];
  const handbookTexts: string[][] = [
    [`${supportTargets[0].university} · ${major}\n${goal}`, `${learning.student_context.core_keywords.join(' · ')}\n${activities[0].title} · ${activities[6].title}`, questions.filter(q => q.interview_priority === 'S').map(q => q.prompt).join('\n')],
    [`동기: ${experiences[0].motivation}\n역할: ${experiences[0].role}\n과정: ${experiences[0].process}\n결과: ${experiences[0].result}\n배운 점: ${experiences[0].lessons}`, `${experiences[5].motivation}\n${experiences[5].process}\n${experiences[5].lessons}`, `${experiences[6].motivation}\n${experiences[6].role}\n${experiences[6].lessons}`, `${experiences[7].summary}\n${experiences[7].lessons}`],
    ['탐구 · 검증 · 협업 → 대표 경험 → 전공 관심', '강점: 조건과 근거를 확인하는 습관\n보완점: 설명이 길어질 때 핵심부터 전달하는 연습', '기초 과학 · 통계 → 학부 탐구 → 측정 한계 보완', `${experiences[0].keywords.join(' → ')}\n동기 → 본인 역할 → 실제 행동 → 결과와 한계 → 배운 점`],
    [experiences.slice(0, 5).map(e => `${e.title}: ${e.keywords.join(' · ')}`).join('\n'), `${experiences[7].keywords.join(' · ')}\n학습 근거와 내 판단을 구분한다.`, `${experiences[6].keywords.join(' → ')}\n${experiences[6].role}`, `${supportTargets[0].university} · ${major}\n탐구 과정 · 본인 역할 · 학습 확장\n가상 기관 정보`],
    ['활동명 · 학년 · 본인 역할 · 비교 조건 · 측정 한계. 말하기 전에 원문과 일치하는지 확인한다.', track === 'environment' ? '흡착: 표면에 붙음\n흡수: 내부로 스며듦\n상관관계는 원인의 증명이 아니다.' : '전사: DNA → RNA\n번역: RNA → 단백질\n관측 결과와 해석을 구분한다.', '최우선 질문에 핵심어로 답할 수 있는가?\n본인 역할을 구체적으로 설명할 수 있는가?\n지원처·일정·준비물을 확인했는가?'],
  ];
  function document(kind: 'guidebook' | 'handbook'): BookDocument {
    const texts = kind === 'guidebook' ? guideTexts : handbookTexts;
    const sections = FINAL_TOC[kind].map(([title, children], ci) => ({ id: `${studentId}-${kind}-chapter-${ci + 1}`, title, children: children.map((title, si) => ({ id: `${studentId}-${kind}-section-${ci + 1}-${si + 1}`, title })) }));
    const blocks: BookBlock[] = [];
    const block = (sectionId: string, extra: Omit<BookBlock, 'id' | 'section_id'>) => blocks.push({ id: `${studentId}-${kind}-block-${blocks.length + 1}`, section_id: sectionId, ...extra });
    sections.forEach((chapter, ci) => chapter.children.forEach((section, si) => {
      block(section.id, { type: 'text', text: texts[ci][si] });
      if (kind === 'guidebook') {
        if (ci === 1 && si === 0 || ci === 3 && si <= 2) supportTargets.forEach(t => block(section.id, { type: 'support_target_ref', support_target_id: t.id }));
        if (ci === 1 && si === 3 || ci === 2 && si === 4) activities.slice(0, 3).forEach(a => block(section.id, { type: 'activity_ref', activity_id: a.id }));
        if (ci === 2 && si === 2) activities.filter(a => a.area.includes('세특')).forEach(a => block(section.id, { type: 'activity_ref', activity_id: a.id }));
        if (ci === 4) {
          const selected = si === 0 ? [0, 9] : si === 1 ? [0, 1, 2, 3] : si === 2 ? [4, 5] : si === 3 ? [6] : si === 4 ? [8, 9, 10] : si === 5 ? [0, 9] : [11];
          selected.forEach(i => block(section.id, { type: si === 5 ? 'answer_script_ref' : 'question_ref', ...(si === 5 ? { answer_script_id: scriptId(i) } : { question_id: questionId(i) }) }));
        }
        if (ci === 6 && si === 1) sourceRefs.slice(0, 8).forEach(s => block(section.id, { type: 'source_ref', source_ref_id: s.id }));
      } else {
        if (ci === 1) block(section.id, { type: 'activity_ref', activity_id: activityId([0, 5, 6, 7][si]) });
        if (ci === 2) block(section.id, { type: 'answer_script_ref', answer_script_id: scriptId([8, 6, 10, 0][si]) });
        if (ci === 0 && si === 2 || ci === 4 && si === 2) block(section.id, { type: 'memory_item_ref', memory_item_id: memoryItems[0].id });
        if (ci === 3 && si === 0) block(section.id, { type: 'memory_item_ref', memory_item_id: memoryItems[2].id });
      }
    }));
    return { id: `${studentId}-doc-${kind}`, kind, document_revision: 1, template_version: 'gakja-web-v1.0', toc_version: TOC_VERSION, sections, blocks };
  }
  const base: Omit<LearningPack, 'document'> = { schema_version: SCHEMA_VERSION, package_id: `${studentId}-pack`, content_version: 1, package_status: 'reviewed', production_job_ref: `${studentId}-job`, learning_data_hash: hashLearningData(learning), criteria_version: criteriaVersion, knowledge_release_refs: [], learning_data: learning, provenance: { production_ref: `${studentId}-demo-production`, review_ref: `${studentId}-demo-review`, reviewed_at: '2026-10-07T00:00:00.000Z', contract_version: SCHEMA_VERSION, synthetic: true } };
  return [{ ...base, document: document('guidebook') }, { ...structuredClone(base), document: document('handbook') }];
}
