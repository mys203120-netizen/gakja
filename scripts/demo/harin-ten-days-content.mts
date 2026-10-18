import { createHash } from 'node:crypto';
import {
  createDemoPack, hashLearningData, parseLearningHtml, renderLearningHtml,
  validateGuidebook, validatePair, type Activity, type BookBlock, type BookDocument,
  type LearningData, type LearningPack, type MemoryItem, type Question, type SupportTarget,
} from '../../packages/content-contracts/src/index';

export const HARIN_TEN_DAYS_NOTICE = '10일 사용 예시용 합성 자료';
const syntheticStatus = 'synthetic_reviewed' as const;
type RegisteredTarget = Record<string, unknown> & { id: string; data?: Record<string, unknown> };
export interface HarinTenDaysContentInput {
  studentId: string;
  studentName: string;
  target: RegisteredTarget;
  version: number;
  packageId: string;
  productionJobRef: string;
}
type DemoDocument = BookDocument & { title: string; synthetic: true; demo_notice: string };
type DemoPack = LearningPack & { document: DemoDocument };
export interface HarinPracticeExample {
  questionId: string;
  activityIds: string[];
  earlyAnswer: string;
  assistedAnswer: string;
  delayedAnswer: string;
  reviewFocus: string[];
  synthetic: true;
  demoNotice: string;
}

/** Pure authoring helper. Importing or calling it never reads/writes a DB or file. */
export function createHarinTenDaysContent(input: HarinTenDaysContentInput) {
  const { studentId, studentName, version, packageId, productionJobRef } = input;
  if (![studentId, studentName, packageId, productionJobRef].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('학생·이름·패키지·제작 건 식별자가 필요합니다.');
  }
  if (!Number.isInteger(version) || version < 1) throw new Error('version은 1 이상의 정수여야 합니다.');
  const supplied = input.target.data ? { ...input.target.data, id: input.target.id, student_id: input.target.student_id ?? input.target.data.student_id } : input.target;
  if (supplied.student_id && supplied.student_id !== studentId) throw new Error('다른 학생의 지원처로 데모 자료를 만들 수 없습니다.');
  // Use the same serializable snapshot for flat and DB-row inputs; undefined
  // optional properties must not disappear between hashing and HTML parsing.
  const registered: Record<string, unknown> = JSON.parse(JSON.stringify({ ...supplied, student_id: studentId }));
  const stringField = (key: string, alias?: string) => {
    const value = registered[key] ?? (alias ? registered[alias] : undefined);
    if (typeof value !== 'string' || !value.trim()) throw new Error(`등록 지원처의 ${key} 값이 필요합니다. 이 생성기는 학교 정보를 추측하지 않습니다.`);
    return value;
  };
  const targetId = stringField('id'), university = stringField('university'), department = stringField('department', 'major');
  const campus = stringField('campus'), admissionType = stringField('admission_type', 'track');
  const admissionYear = registered.admission_year;
  if (!Number.isInteger(admissionYear) || Number(admissionYear) < 2000) throw new Error('등록 지원처의 admission_year 정수가 필요합니다.');
  const prefix = `harin10demo-${studentId}`;
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const ids = {
    activities: { survey: id('act-survey'), festival: id('act-festival'), incentives: id('act-incentives') },
    questions: { surveyRole: id('q-survey-role'), inventory: id('q-inventory'), incentives: id('q-incentives'), surveyLimits: id('q-survey-limits'), profit: id('q-profit'), fairness: id('q-fairness') },
    memoryItems: { surveyRole: id('memory-survey-role'), inventory: id('memory-inventory'), incentives: id('memory-incentives'), surveyLimits: id('memory-survey-limits'), profit: id('memory-profit'), fairness: id('memory-fairness') },
  };
  const sources = { survey: id('src-survey'), festival: id('src-festival'), incentives: id('src-incentives'), concept: id('src-concept'), notice: id('src-notice'), target: id('src-registered-target') };
  const criteriaVersion = 'harin10demo-practice-order-v1';
  const notice = `${HARIN_TEN_DAYS_NOTICE}. 실제 학생부·실제 학생의 경험·실제 성적이 아닙니다. 활동, 수치, 발화 예시는 모두 기능 시연을 위해 만들었습니다. 등록 지원처 정보와 합성 경험을 구분하며, 답변 길이·사용 횟수만으로 실력 향상이나 합격 가능성을 판정하지 않습니다.`;
  const priorities: Activity['interview_priority'][] = ['S', 'A', 'A'];
  const experience = [
    {
      id: ids.activities.survey, source: sources.survey, title: '학교 매점 소비·가격 설문', grade: 2, area: '합성 경제 탐구 활동',
      motivation: '친구들이 매점을 덜 찾는 이유를 가격 때문이라고 단정하기 전에 선택 기준을 확인하고 싶었다.',
      role: '저는 설문 문항 작성, 중복 응답 점검, 집계표 작성을 맡았다. 친구 두 명은 배포를 맡았고, 제가 모든 응답을 직접 받은 것은 아니다.',
      process: '10일 사용 예시용 가상 조사에서 두 학급의 자발적 응답 32건을 모았다. 유도 문항인 “가격이 비싸지 않나요?”를 “가장 먼저 고려하는 한 가지는 무엇인가요?”로 바꿨다. 같은 익명 응답표에 가격·맛·편의성 중 한 가지를 고르게 하고, 1,000원과 1,500원 상황의 구매 의향을 각각 물었다. 집계 전에 중복 제출 여부와 빈 응답을 확인했다.',
      result: '합성 집계는 가격 19명, 맛 8명, 편의성 5명이었다. 같은 32명 중 1,000원 상황에서 22명, 1,500원 상황에서 14명이 구매 의향을 표시했다. 실제 판매를 측정하거나 가격을 바꾸지는 않았다. 저는 두 가격의 의향 차이를 표로 정리하고 매점 담당자에게는 추가 조사 제안까지만 했다.',
      limitation: '두 학급의 편의표집이고 가격에 관한 가정 응답이다. 32명의 응답을 전교생 수요로 일반화하거나 가격 인하가 매출을 늘린다는 인과효과로 해석할 수 없다.',
      lesson: '응답 수보다 질문 방식과 표본 범위를 먼저 설명해야 한다. 다시 조사한다면 학년과 이용 빈도별로 응답자를 나누고, 동의를 받은 실제 구매 기록을 별도로 비교하겠다.',
      keywords: ['중립 문항', '32명 편의표집', '구매 의향과 실제 구매 구분'],
    },
    {
      id: ids.activities.festival, source: sources.festival, title: '축제 친환경 부스의 재고·수익 의사결정', grade: 3, area: '합성 창의적 체험활동',
      motivation: '축제 부스에서 판매량만 늘리기보다 남는 재료와 운영 비용도 함께 살펴보고 싶었다.',
      role: '저는 재료 수량·원가표와 현금 기록을 담당했다. 팀원들은 제작과 판매를 맡았으며, 재고를 줄이는 안을 비교표로 제안했다.',
      process: '팀의 최초 제안은 40개 준비였지만 구매 의향을 물은 12명 중 8명이라는 작은 표본만으로 확정하기는 어려웠다. 저는 먼저 24개를 준비하고 여건이 되면 8개를 추가하는 안을 제시했다. 합성 시나리오에서는 개당 판매가 1,500원, 재료비 900원, 공동 준비비 6,000원으로 계산하고 두 차례에 12개씩 제작했다. 주문·제작·판매 수량을 각각 기록했다.',
      result: '데모 장부에서는 준비한 24개가 모두 판매됐다. 매출은 36,000원, 재료비는 21,600원, 공동 준비비는 6,000원이며 이 장부에 포함한 비용을 뺀 잔액은 8,400원이다. 판매 결과만으로 분할 제작이 원인이라고 말하지 않았다. 추가 제작은 하지 않았고, 이 시나리오의 완제품 잔여는 0개였다.',
      limitation: '판매 수량·금액은 모두 합성 수치다. 인건비·운송비·환경 부담을 모두 산정한 실제 순이익이 아니며, 친환경 명칭만으로 환경 효과가 검증된 것도 아니다. 다른 날 같은 판매량을 보장하지 않는다.',
      lesson: '매출과 남는 돈을 구분하고 계산에 넣은 비용을 밝혀야 한다. 다음에는 판매가 부진한 경우의 재고 처리와 추가 제작을 멈출 기준도 사전에 정하겠다.',
      keywords: ['24개부터 분할 제작', '매출과 비용 분리', '비용 범위의 한계'],
    },
    {
      id: ids.activities.incentives, source: sources.incentives, title: '독서 토론으로 살펴본 공정한 인센티브', grade: 1, area: '합성 독서·토론 활동',
      motivation: '같이 한 일의 보상을 똑같이 나누는 것이 언제나 공정한지 궁금했다.',
      role: '저는 네 명의 토론에서 발언 요약과 반례 질문을 맡았다. 말수가 적은 팀원의 준비·정리 노동이 기록에서 빠지지 않는지 질문했다.',
      process: '실제 출판물 대신 이 데모를 위해 쓴 “기여와 보상” 합성 발췌문을 읽었다. 네 사람이 100점을 똑같이 나누는 안과 보이는 성과에 따라 나누는 안을 비교했다. 발표만 점수화하면 준비·정리 역할이 빠질 수 있다는 반례를 들고, 역할을 미리 정한 기여 기록과 당사자의 확인 절차를 제안했다.',
      result: '합성 토론에서는 공통 몫 60점을 네 명에게 15점씩 배분하고, 나머지 40점은 사전에 합의한 역할별 근거로 검토하는 초안을 만들었다. 저는 처음의 “똑같이 나누면 된다”는 의견을 수정했다. 실제 보상 지급이나 참여율 변화는 측정하지 않았다.',
      limitation: '60대 40은 모든 조직에 적합한 정답이 아니라 토론용 가정이다. 시간만으로 기여를 판단하거나 다수결로 소수의 설명을 지우면 다른 불공정이 생길 수 있다.',
      lesson: '공정성을 말할 때 결과뿐 아니라 사전 기준, 보이지 않는 기여, 이의 제기 절차를 함께 설명하겠다.',
      keywords: ['사전 합의', '보이지 않는 기여', '이의 제기 절차'],
    },
  ];
  const narrative = (e: typeof experience[number]) => `${HARIN_TEN_DAYS_NOTICE}\n동기: ${e.motivation}\n본인 역할: ${e.role}\n방법: ${e.process}\n결과: ${e.result}\n한계: ${e.limitation}\n다음 질문: ${e.lesson}`;
  const conceptText = `${HARIN_TEN_DAYS_NOTICE}. 편의표집은 접근하기 쉬운 참여자를 모으므로 전체 집단을 대표한다고 보장할 수 없다. 가정 상황의 구매 의향은 실제 구매와 다르며, 설문 응답 차이만으로 가격의 인과효과를 확정하지 않는다. 매출은 판매가와 판매 수량의 곱이며 남는 금액을 말하려면 비용 범위를 명시해야 한다. 합성 부스 장부의 단순 계산은 1,500원×24개−900원×24개−6,000원=8,400원이다. 이 금액은 장부에 포함한 비용을 차감한 잔액이며 인건비 등 모든 비용을 반영한 실제 순이익을 의미하지 않는다. 공정한 보상 방식을 검토할 때는 사전 기준, 드러나지 않는 기여, 이의 제기 절차를 함께 고려한다.`;
  const sourceRefs: LearningData['source_refs'] = [
    ...experience.map((e, index) => ({ id: e.source, type: 'synthetic_learning_material', revision: 1, page: index + 1, area: e.area, quote: narrative(e), synthetic: true })),
    { id: sources.concept, type: 'synthetic_learning_material', revision: 1, quote: conceptText, synthetic: true },
    { id: sources.notice, type: 'synthetic_demo_notice', revision: 1, quote: `${notice}\n합성 진로 맥락: 소비자 선택과 조직의 의사결정을 데이터와 공정성의 관점에서 배우고 싶다. 확률·통계와 기초 회계의 개념을 익혀 표본의 한계와 비용 범위를 설명하는 연습을 계획한다. 이 계획도 학생에게 실제 확인한 진로 사실은 아니다.`, synthetic: true },
    { id: sources.target, type: 'registered_support_target_snapshot', revision: 1, quote: `현재 앱에 등록된 지원처의 입력 스냅샷: ${JSON.stringify(registered)}. 이 스냅샷은 새로운 공식 모집요강·기출·평가요소·면접 방식의 근거가 아니다. 최신 공식 정보 확인 여부는 등록된 information_status를 따른다.` },
  ];
  const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
  const registeredElements = stringList(registered.evaluation_elements);
  // The contract requires an evaluation label. This explicit placeholder states
  // missing information; questions never claim it is a university criterion.
  const target: SupportTarget = {
    ...registered,
    id: targetId, student_id: studentId, university, department, campus,
    admission_type: admissionType, admission_year: Number(admissionYear),
    verification_status: 'needs_confirmation',
    field_sources: Object.fromEntries(['university', 'campus', 'department', 'admission_type', 'admission_year'].map(key => [key, { source_ref_ids: [sources.target], verification_status: 'needs_confirmation' }])),
    talent_tags: stringList(registered.talent_tags),
    evaluation_elements: registeredElements.length ? registeredElements : ['공식 평가요소 미확인 — 등록 자료에서 확인 필요'],
    major_connection: `${university} ${department}라는 등록 지원처를 선택해 소비자 선택·재고·보상에 관한 합성 경험을 연습한다. 아래 질문과 우선도는 대학의 실제 기출·평가 기준이 아니다.`,
    source_ref_ids: [sources.target], knowledge_release_refs: stringList(registered.knowledge_release_refs),
  };
  const activities: Activity[] = experience.map((e, index) => ({
    id: e.id, title: e.title, grade: e.grade, area: e.area,
    activity_summary: `${HARIN_TEN_DAYS_NOTICE}. ${e.role} ${e.result} ${e.limitation}`,
    interview_priority: priorities[index], priority_reason: '10일 예시에서 본인 역할·판단 근거·한계를 복원하기 위한 연습 순서이며 대학의 평가나 학생 역량 등급이 아니다.',
    priority_assignments: [{ support_target_id: targetId, priority: priorities[index], reason: `${e.title}의 역할과 근거를 먼저 설명하는 합성 연습 순서. 대학별 우수성·합격 가능성에 관한 판정이 아니다.`, source_ref_ids: [e.source, sources.notice], criteria_version: criteriaVersion }],
    talent_tags: ['근거 설명', '한계 확인'], major_relevance: '소비자 선택과 조직 의사결정에 대한 관심을 설명하는 합성 연습 소재',
    source_ref_ids: [e.source], fact_confirmation: syntheticStatus,
    motivation: e.motivation, role: e.role, process: e.process, result: `${e.result} ${e.limitation}`, lessons: e.lesson, keywords: e.keywords,
  }));
  const questionSpecs = [
    { key: 'surveyRole', activity: 0, prompt: '학교 매점 설문에서 본인이 맡은 역할과 조사 문항을 바꾼 이유를 설명해 주세요.', intent: '본인의 역할을 팀 활동과 구분하고 중립적인 문항으로 바꾼 근거를 복원한다.', types: ['activity', 'major'], depth: 'D1', elements: ['문항 작성·중복 점검·집계의 본인 역할', '유도 문항을 중립 문항으로 수정', '32명 편의표집과 해석 한계'], structure: ['본인 역할', '문항을 바꾼 이유', '방법과 결과', '해석 한계'], follow: 'surveyLimits' },
    { key: 'inventory', activity: 1, prompt: '축제 부스에서 40개 대신 24개부터 준비하자고 제안한 이유와 실제로 한 일을 설명해 주세요.', intent: '작은 수요 자료의 불확실성, 재고 선택과 자신의 계산·기록 역할을 연결한다.', types: ['activity', 'major'], depth: 'D2', elements: ['수량·원가표와 현금 기록 역할', '작은 표본 때문에 24개부터 분할 제작', '판매 기록과 포함 비용의 한계'], structure: ['의사결정 상황', '본인 제안과 근거', '실행과 기록', '결과와 한계'], follow: 'profit' },
    { key: 'incentives', activity: 2, prompt: '공정한 보상을 토론하면서 처음 의견을 바꾼 계기와 본인이 제안한 절차는 무엇인가요?', intent: '합성 독서 자료를 바탕으로 반례를 듣고 보이지 않는 기여를 반영한 이유를 설명한다.', types: ['activity', 'community', 'reading'], depth: 'D2', elements: ['동일 배분이라는 초기 의견', '준비·정리 노동이라는 반례', '사전 기준과 이의 제기 절차'], structure: ['처음 의견', '반례와 수정 이유', '제안한 절차', '적용 한계'], follow: 'fairness' },
    { key: 'surveyLimits', activity: 0, prompt: '편의표집과 구매 의향, 이 설문 결과의 해석 한계를 내 말로 설명해 주세요.', intent: '개념 자료의 표본·응답·인과의 구분을 합성 설문에 적용한다.', types: ['concept', 'verification', 'followup'], depth: 'D3', elements: ['두 학급 자발적 참여의 편의표집', '가정 의향과 실제 행동의 구분', '표본 확장·동의한 실제 기록으로 추가 확인'], structure: ['개념 구분', '이 자료의 한계', '추가 확인 방법'], follow: null },
    { key: 'profit', activity: 1, prompt: '매출과 비용을 구분하고, 합성 부스 장부의 8,400원이 무엇을 뜻하는지 설명해 주세요.', intent: '계산 과정과 포함한 비용의 범위를 밝히고 실제 순이익으로 확대하지 않는다.', types: ['concept', 'major', 'followup'], depth: 'D2', elements: ['매출 36,000원', '재료비 21,600원과 공동 준비비 6,000원', '잔액 8,400원과 제외 비용의 한계'], structure: ['매출의 의미', '포함 비용과 계산', '잔액을 해석할 범위'], follow: null },
    { key: 'fairness', activity: 2, prompt: '성과가 잘 보이지 않는 준비·정리 역할을 맡은 팀원이 보상 기준에 이의를 제기한다면 어떻게 하겠어요?', intent: '새로운 상황에서 기록 확인과 상대의 설명을 듣는 절차를 제시한다. 아직 시도하지 않은 후속 질문으로도 사용할 수 있다.', types: ['community', 'followup', 'application'], depth: 'D3', elements: ['이의 내용과 빠진 기여를 먼저 확인', '사전 기준과 근거 기록을 함께 검토', '당사자 설명을 듣고 기준 수정 여부를 합의'], structure: ['먼저 확인할 사실', '검토 절차', '수정과 재합의'], follow: null },
  ] as const;
  const questions: Question[] = questionSpecs.map(spec => ({
    id: ids.questions[spec.key], prompt: spec.prompt, question_intent: `${HARIN_TEN_DAYS_NOTICE}. ${spec.intent} 실제 대학 기출을 뜻하지 않는다.`,
    grounding_types: ['document_based'], question_types: [...spec.types], depth: spec.depth,
    activity_ids: [experience[spec.activity].id], support_target_ids: [targetId],
    source_ref_ids: [experience[spec.activity].source, sources.concept], evaluation_links: [],
    answer_elements: [...spec.elements], answer_structure: [...spec.structure],
    followup_question_ids: spec.follow ? [ids.questions[spec.follow]] : [], verification_status: syntheticStatus,
    interview_priority: spec.key === 'surveyRole' ? 'S' : 'A',
  }));
  const answerTexts = [
    '저는 설문 문항 작성과 중복 응답 점검, 집계표 작성을 맡았습니다. “가격이 비싸지 않나요?”라는 문항은 답을 유도할 수 있어 “가장 먼저 고려하는 한 가지”를 묻는 문장으로 바꿨습니다. 두 학급에서 자발적으로 응답한 32명의 합성 자료를 정리했고, 가격 19명·맛 8명·편의성 5명으로 집계했습니다. 하지만 이것은 두 학급의 구매 의향이라 전교생의 실제 구매나 가격 인하 효과를 증명하지 않습니다.',
    '저는 부스의 수량·원가표와 현금 기록을 맡았습니다. 구매 의향 자료가 12명에 불과해 처음부터 40개를 준비하기보다 24개를 먼저 준비하고 필요할 때 8개를 추가하자고 제안했습니다. 데모에서는 12개씩 두 번 제작해 24개를 판매했고 주문·제작·판매를 따로 기록했습니다. 매출 36,000원에서 재료비 21,600원과 공동 준비비 6,000원을 빼면 8,400원입니다. 이 계산에는 인건비 등이 빠져 있고, 한 번의 판매 결과로 제안의 효과를 확정할 수 없습니다.',
    '처음에는 네 명이 보상을 똑같이 나누면 공정하다고 생각했습니다. 합성 독서 토론에서 발표 성과만 보이면 준비·정리를 맡은 사람의 기여가 빠진다는 반례를 듣고 의견을 보완했습니다. 저는 발언을 정리하고 역할 기록과 당사자 확인 절차를 제안했습니다. 공통 몫 60점과 역할별 40점을 검토하는 초안을 만들었지만 그 비율 자체를 정답으로 보지는 않습니다. 기준을 미리 합의하고 이의를 말할 통로를 두는 것이 필요하다고 생각했습니다.',
    '편의표집은 참여시키기 쉬운 사람에게서 자료를 모으는 방식이라 전체 집단을 대표한다고 보장할 수 없습니다. 이번 합성 설문은 두 학급의 자발적 응답 32건이고, 1,000원일 때 22명·1,500원일 때 14명이라는 값도 가정 상황의 의향입니다. 실제 구매가 아니며 가격을 바꾼 비교 실험도 아니어서 인과효과를 확정할 수 없습니다. 다음에는 학년과 이용 빈도를 나눠 표본을 넓히고, 동의를 받은 실제 구매 기록을 별도로 확인하겠습니다.',
    '매출은 판매가와 판매 수량의 곱이라 합성 장부에서는 1,500원에 24개를 곱한 36,000원입니다. 재료비 900원에 24개를 곱한 21,600원과 공동 준비비 6,000원을 빼면 8,400원이 남습니다. 이 금액은 이 장부에 적힌 비용만 차감한 잔액입니다. 인건비·운송비 같은 모든 비용이나 환경 부담을 산정하지 않았으므로 실제 순이익이나 환경 성과로 확대해서 설명하지 않겠습니다.',
    '먼저 어떤 준비·정리 기여가 기록에서 빠졌는지 팀원의 설명을 듣겠습니다. 그다음 사전에 정한 역할 기준과 실제 작업 기록을 함께 확인하고 다른 사람의 판단과 구분하겠습니다. 기준 자체가 보이지 않는 기여를 놓쳤다면 당사자를 포함해 수정 여부를 논의하겠습니다. 단순히 다수결로 이의를 끝내거나, 기억에 없는 기여를 제가 대신 만들어 적지는 않겠습니다.',
  ];
  const answerScripts: LearningData['answer_scripts'] = questions.map((q, index) => ({
    id: id(`answer-${questionSpecs[index].key}`), question_id: q.id, revision: 1, text: answerTexts[index],
    verification_status: syntheticStatus, source_ref_ids: q.source_ref_ids,
    claims: answerTexts[index].split(/(?<=[.!?])\s+/).map(text => ({ text, fact_kind: 'synthetic_demo_example', source_ref_ids: q.source_ref_ids, verification_status: syntheticStatus })),
  }));
  const memoryItems: MemoryItem[] = questions.map((q, index) => ({
    id: ids.memoryItems[questionSpecs[index].key], kind: 'short_speech', question_id: q.id, answer_script_id: answerScripts[index].id,
    activity_ids: q.activity_ids, prompt: q.prompt, memory_keywords: [...questionSpecs[index].elements],
    default_time_limit_seconds: 60, evaluation_method: 'self_check', category: 'experiential',
    source_ref_ids: q.source_ref_ids, verification_status: syntheticStatus,
  }));
  Object.assign(memoryItems[0], { kind: 'keyword_recall', prompt: '매점 설문의 본인 역할·문항 수정·해석 한계를 핵심어 세 묶음으로 떠올려 보세요.', default_time_limit_seconds: 20 });
  Object.assign(memoryItems[2], { kind: 'flip_card', prompt: '같은 보상만으로 공정성이 해결되지 않는 이유와 확인할 절차를 떠올려 보세요.', back: '준비·정리 같은 보이지 않는 기여 → 사전에 합의한 역할 기준 → 당사자 설명과 이의 제기 절차. 60대 40은 합성 토론의 초안이며 정답 비율이 아니다.' });
  Object.assign(memoryItems[3], {
    kind: 'choice', category: 'concept', answer_script_id: null, evaluation_method: 'reviewed_correct_answer',
    prompt: '편의표집과 구매 의향, 이 설문 결과의 해석 한계를 설명하는 문장을 골라보세요.',
    options: [
      { id: id('option-survey-a'), text: '응답이 32건이면 전교생의 수요를 확정할 수 있다.' },
      { id: id('option-survey-b'), text: '편의표집과 가정 의향이므로 실제 구매와 전체 집단에 대한 추가 확인이 필요하다.' },
      { id: id('option-survey-c'), text: '가격별 의향 차이는 가격 인하의 매출 증가 효과를 증명한다.' },
      { id: id('option-survey-d'), text: '가격을 가장 많이 골랐으므로 맛과 편의성 응답은 제외해야 한다.' },
    ], correct_option_id: id('option-survey-b'), default_time_limit_seconds: 30,
  });
  Object.assign(memoryItems[4], {
    kind: 'short_speech', category: 'concept', answer_script_id: answerScripts[4].id, evaluation_method: 'self_check',
    prompt: '합성 부스의 매출 36,000원과 비용을 내 말로 구분해 보세요. 8,400원의 계산 과정과 이 잔액을 해석할 때의 한계를 함께 설명해 주세요.',
    default_time_limit_seconds: 60,
  });
  const learning: LearningData & { student_context: LearningData['student_context'] & { demo_notice: string } } = {
    criteria_version: criteriaVersion, knowledge_release_refs: [],
    student_context: {
      student_id: studentId, name: studentName, synthetic: true, demo_notice: notice,
      core_keywords: ['소비자 선택', '근거 있는 의사결정', '공정한 절차'],
      career_academic_flow: [
        { grade: 1, focus: `${HARIN_TEN_DAYS_NOTICE}: 보상 기준과 보이지 않는 기여를 독서 토론으로 살펴봄`, source_ref_ids: [sources.incentives] },
        { grade: 2, focus: `${HARIN_TEN_DAYS_NOTICE}: 소비·가격 설문에서 문항과 표본의 한계를 확인함`, source_ref_ids: [sources.survey] },
        { grade: 3, focus: `${HARIN_TEN_DAYS_NOTICE}: 축제 부스의 수량·비용·불확실성을 함께 기록함`, source_ref_ids: [sources.festival] },
      ],
      representative_activity_ids: experience.map(e => e.id),
      confirmed_goals: [{ text: `${HARIN_TEN_DAYS_NOTICE}: 소비자 선택과 조직 의사결정을 데이터와 공정성의 관점에서 배우고 싶다는 가상 목표. 실제 진로 확인 기록이 아니다.`, source_ref_ids: [sources.notice], verification_status: syntheticStatus }],
      confirmed_plans: [{ text: `${HARIN_TEN_DAYS_NOTICE}: 확률·통계와 기초 회계 개념을 익혀 표본의 한계와 비용 범위를 설명하는 연습을 한다는 가상 계획. 대학의 실제 개설 교과목을 뜻하지 않는다.`, source_ref_ids: [sources.notice], verification_status: syntheticStatus }],
      source_ref_ids: [sources.notice, sources.survey, sources.festival, sources.incentives],
    },
    support_targets: [target], source_refs: sourceRefs, activities, questions,
    answer_designs: questions.map((q, index) => ({ id: id(`design-${questionSpecs[index].key}`), question_id: q.id, materials: q.activity_ids.map(activityId => activities.find(a => a.id === activityId)!.title), structure: q.answer_structure, required_meanings: q.answer_elements, source_ref_ids: q.source_ref_ids })),
    answer_scripts: answerScripts,
    memory_keywords: questions.map((q, index) => ({ id: id(`keywords-${questionSpecs[index].key}`), answer_script_id: answerScripts[index].id, activity_ids: q.activity_ids, keywords: q.answer_elements, logical_structure: q.answer_structure, example: answerTexts[index] })),
    memory_items: memoryItems,
  };
  const targetSummary = `${university} · ${department} · ${campus} · ${admissionType} · ${admissionYear}학년도. 앱에 등록된 정보만 사용했다. 전형의 모집요강·실제 기출·면접 방식은 이 자료에서 새로 확정하지 않는다.`;
  const guideTexts = [
    [notice + '\n1~2일: 자료와 질문 연결 → 3~4일: 첫 답변과 자료 확인 → 5~7일: 피드백에 따라 다시 답하기 → 8~10일: 같은 질문을 도움 없이 다시 떠올리기. 모든 날짜와 발화는 사용 흐름을 위한 예시다.', '활동 원문에서 내 역할·방법·결과·한계를 먼저 찾는다. 질문과 답변 설계, 기억 항목이 같은 ID로 연결된다. 도움을 본 답변과 나중에 독립적으로 답한 기록을 구분하고, 빠진 의미 요소를 비교한다.'],
    [targetSummary, learning.student_context.career_academic_flow.map(f => `${f.grade}학년: ${f.focus}`).join('\n'), learning.student_context.core_keywords.join(' · '), experience.map(e => `${e.title}: ${e.role}`).join('\n'), 'S/A는 이 데모의 연습 순서다. 학생의 능력 등급이나 대학의 공식 평가가 아니다. 먼저 역할·문항·한계를 설명하는 매점 설문을 연습하고 재고 판단과 공정한 절차로 연결한다.'],
    ['실제 학생부를 제공받지 않았다. 학적·출결·수상·자격·성적은 생성하지 않는다. 활동의 학년과 내용도 합성 설정이다.', narrative(experience[1]), narrative(experience[0]), narrative(experience[2]), '공정한 기준을 질문한 독서 토론 → 소비자의 응답을 살핀 설문 → 재고와 비용을 비교한 부스 운영. 실제 성장 사실의 증명이 아닌 합성 콘텐츠의 연결 흐름이다.'],
    [targetSummary, registeredElements.length ? `등록 데이터에 포함된 항목: ${registeredElements.join(' · ')}. 이 생성기는 새 평가요소를 추가하지 않았다.` : '현재 전달된 지원처 정보에는 공식 인재상·평가요소 근거가 없다. 이를 확인하기 전 대학별 역량이나 배점을 만들지 않는다.', '실제 면접 시간·면접위원 수·질문 수·전형 배점은 여기에서 설정하지 않는다. 아래 6개는 학습용 합성 질문이다.', experience.map(e => `${e.title}: ${e.keywords.join(' · ')}`).join('\n'), '소비자 선택, 제한된 자원, 보상 기준이라는 관심을 경험의 역할·근거·한계로 설명한다. 대학이 반드시 선호한다고 주장하지 않는다.'],
    [questions[0].prompt, questions.slice(0, 3).map(q => q.prompt).join('\n'), questions.slice(3, 5).map(q => q.prompt).join('\n'), questions[2].prompt, '지원처 관련 답변에서는 등록 정보와 확인되지 않은 공식 정보를 구분한다. 제공하지 않은 시사 사건이나 실제 출판물 내용을 만들어 넣지 않는다.', questions.map((q, i) => `${q.prompt}\n${q.answer_structure.join(' → ')}\n합성 발화 예시: ${answerTexts[i]}`).join('\n\n'), [questions[3].prompt, questions[4].prompt, questions[5].prompt].join('\n')],
    ['문장 전체를 복제하는 대신 역할·행동·근거·한계 묶음으로 회상한다. 개념 문항은 검수된 설명과 수치 계산으로 확인하고 개인 경험 발화는 의미 요소를 스스로 점검한다.', '첫 답: “설문을 만들고 조사했습니다.” → 자료 확인 후: 문항 수정 이유와 집계 역할·32명 표본의 한계까지 설명한다. 길어졌다는 사실만으로 향상을 판정하지 않고 어떤 근거가 추가됐는지 확인한다.', '같은 답을 반복하기보다 “무엇을 확정할 수 없는가?”에 답한다. 없는 경험이나 수치를 추가하지 않는다.', '첫 답변 → 도움 확인 여부 기록 → 빠진 요소 피드백 → 재답변 → 며칠 뒤 독립 재답변. 리포트에서는 도움 사용과 실제 답변 근거를 함께 본다.', '합성 수치를 실제 경험처럼 말하지 않는가? 본인 역할을 팀 전체의 일과 구분했는가? 지원처 공식 정보를 추측하지 않았는가?'],
    [questions.map((q, i) => `${i + 1}. ${q.prompt}`).join('\n'), notice + '\n' + experience.map(narrative).join('\n\n'), conceptText + '\n' + targetSummary, '기록 칸: 질문 ID / 실제 입력한 합성 답 / 확인한 자료·도움 / 설명에 빠진 의미 / 나중의 재답. 시도하지 않은 질문은 미시도로 남겨 둔다.'],
  ];
  const handbookTexts = [
    [notice + '\n' + targetSummary, experience.map(e => `${e.title}: ${e.keywords.join(' → ')}`).join('\n'), questions[0].prompt],
    [narrative(experience[0]), '학업 성적·성취 향상은 생성하지 않았다. 매출과 비용, 표본과 모집단의 구분을 합성 개념 문제로 확인한다.\n' + conceptText, narrative(experience[2]), narrative(experience[1])],
    ['가상 관심: 소비자 선택·조직 의사결정·공정한 절차. 자기소개나 지원동기를 쓸 때 실제 학교 활동으로 주장하지 않는다.', '의견을 바꾼 이유를 반례와 함께 설명한다. 동등 배분과 공정성을 같은 말로 처리하지 않고 보이지 않는 기여를 확인한다.', learning.student_context.confirmed_plans[0].text, answerTexts[0]],
    [experience.slice(0, 2).map(e => e.keywords.join(' · ')).join('\n'), '“기여와 보상”은 실제 책명이 아니라 이 데모를 위한 합성 발췌문이다. 사전 합의 → 보이지 않는 기여 → 이의 제기 절차.', '근거 설명과 한계 확인은 데모의 연습 초점이다. 대학 공식 인재상이나 역량 평가 결과가 아니다.', targetSummary],
    [notice + '\n32명·24개·8,400원·60대 40은 데모 수치다. 원문의 조건과 단위를 함께 확인한다.', '구매 의향 ≠ 실제 구매. 매출 ≠ 모든 비용을 뺀 순이익. 동일 배분 ≠ 언제나 공정한 절차. 합성 시연 ≠ 실제 학생부 사실.', '자료를 보지 않고 역할·방법·결과·한계를 말해 보고, 자료를 본 시도와 구분해 기록한다. 마지막 후속 질문을 아직 풀지 않았다면 미시도로 남긴다.'],
  ];
  const templates = createDemoPack(prefix, studentName, 'environment');
  const learningHash = hashLearningData(learning);
  const buildPack = (template: LearningPack): DemoPack => {
    const kind = template.document.kind, sections = structuredClone(template.document.sections);
    const texts = kind === 'guidebook' ? guideTexts : handbookTexts;
    const blocks: BookBlock[] = [];
    const add = (sectionId: string, content: Omit<BookBlock, 'id' | 'section_id'>) => blocks.push({ id: id(`${kind}-block-${blocks.length + 1}`), section_id: sectionId, ...content });
    sections.forEach((chapter, ci) => chapter.children!.forEach((section, si) => {
      add(section.id, { type: 'text', text: texts[ci][si] });
      if (kind === 'guidebook') {
        if (ci === 1 && si === 0) add(section.id, { type: 'support_target_ref', support_target_id: targetId });
        if (ci === 1 && si === 3) activities.forEach(a => add(section.id, { type: 'activity_ref', activity_id: a.id }));
        if (ci === 4 && si === 0) add(section.id, { type: 'question_ref', question_id: questions[0].id });
        if (ci === 4 && si === 5) answerScripts.forEach(a => add(section.id, { type: 'answer_script_ref', answer_script_id: a.id }));
        if (ci === 5 && si === 0) memoryItems.forEach(m => add(section.id, { type: 'memory_item_ref', memory_item_id: m.id }));
        if (ci === 6 && si === 0) questions.forEach(q => add(section.id, { type: 'question_ref', question_id: q.id }));
        if (ci === 6 && si === 1) sourceRefs.forEach(s => add(section.id, { type: 'source_ref', source_ref_id: s.id }));
      } else {
        if (ci === 1) add(section.id, { type: 'activity_ref', activity_id: activities[[0, 0, 2, 1][si]].id });
        if (ci === 2 && si === 3) add(section.id, { type: 'answer_script_ref', answer_script_id: answerScripts[0].id });
        if (ci === 4 && si === 2) memoryItems.forEach(m => add(section.id, { type: 'memory_item_ref', memory_item_id: m.id }));
      }
    }));
    const title = `${studentName} · ${HARIN_TEN_DAYS_NOTICE} · ${kind === 'guidebook' ? '가이드북' : '암기 핸드북'}`;
    const document: DemoDocument = { ...template.document, document_revision: version, title, synthetic: true, demo_notice: notice, sections, blocks };
    return {
      ...template, package_id: packageId, content_version: version, production_job_ref: productionJobRef,
      learning_data: structuredClone(learning), learning_data_hash: learningHash,
      criteria_version: criteriaVersion, knowledge_release_refs: [], document,
      provenance: { ...template.provenance, production_ref: productionJobRef, review_ref: id(`review-v${version}`), reviewed_at: '2026-10-08T00:00:00.000Z', synthetic: true },
    } satisfies DemoPack;
  };
  const packs: [DemoPack, DemoPack] = [buildPack(templates[0]), buildPack(templates[1])];
  const context = { studentId, productionJobRef, registeredTargetIds: [targetId] };
  validatePair(packs, context);
  validateGuidebook(packs[0], context);
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const documents = packs.map(pack => {
    // The shared renderer names books from student_context.name. Keep that real
    // display name intact and put the demo warning explicitly in the HTML title.
    const html = renderLearningHtml(pack).replace(/<title>[^]*?<\/title>/, `<title>${escapeHtml(pack.document.title)}</title>`);
    return { kind: pack.document.kind, title: pack.document.title, data: pack.document, html, fileHash: createHash('sha256').update(html).digest('hex') };
  });
  validatePair(documents.map(document => parseLearningHtml(document.html).pack), context);
  const earlyAnswers = ['설문을 만들고 친구들에게 조사했습니다. 가격이 중요하다는 것을 알았습니다.', '재고가 남지 않게 적게 준비하자고 했습니다. 계산도 했습니다.', '다 같이 똑같이 나누는 것보다 공정하게 나눠야 한다고 생각했습니다.', '조사한 사람이 많지 않아서 더 조사해야 합니다.', '물건을 팔아서 번 돈에서 비용을 빼면 됩니다.', '팀원의 이야기를 듣고 다시 이야기하겠습니다.'];
  const delayedAnswers = [
    '문항 작성과 중복 확인, 집계가 제 역할이었습니다. 답을 유도하는 표현을 바꾸고 두 학급 32명의 응답을 정리했습니다. 가격이 19명으로 많았지만 실제 구매가 아닌 편의표집 의향 자료라 전교생 수요로 확대하면 안 됩니다.',
    '작은 의향 표본만으로 40개를 준비하기에는 불확실해서 24개부터 나눠 제작하자고 제안했습니다. 저는 수량·원가표와 현금을 기록했습니다. 8,400원은 일부 비용만 차감한 합성 장부의 잔액이며 실제 순이익이나 제안의 인과효과를 뜻하지 않습니다.',
    '준비와 정리처럼 보이지 않는 역할이 빠질 수 있다는 반례 때문에 동일 배분이라는 생각을 수정했습니다. 역할 기준을 미리 정하고 당사자가 기록을 확인하거나 이의를 말할 절차를 제안했습니다. 60대 40은 이 토론의 가정일 뿐입니다.',
    '두 학급의 자발적 응답은 전교생을 대표한다고 할 수 없고, 구매 의향도 실제 구매와 다릅니다. 학년과 이용 빈도로 표본을 넓히고 동의를 받은 실제 기록을 따로 확인해야 합니다. 설문 차이만으로 가격의 효과를 확정할 수는 없습니다.',
    '매출 36,000원에서 재료비 21,600원과 준비비 6,000원을 빼면 8,400원입니다. 인건비 등은 포함하지 않아 이 범위의 잔액이라고 말해야 합니다.',
    '기록에서 빠진 준비·정리 기여가 무엇인지 먼저 듣고, 사전에 합의한 역할 기준과 자료를 같이 보겠습니다. 기준이 잘못됐으면 당사자를 포함해 수정 여부를 합의하겠습니다.',
  ];
  const practiceExamples: HarinPracticeExample[] = questions.map((q, index) => ({ questionId: q.id, activityIds: q.activity_ids, earlyAnswer: earlyAnswers[index], assistedAnswer: answerTexts[index], delayedAnswer: delayedAnswers[index], reviewFocus: q.answer_elements, synthetic: true, demoNotice: notice }));
  return { packs, learning, learningHash, documents, ids, practiceExamples, demoNotice: notice };
}
