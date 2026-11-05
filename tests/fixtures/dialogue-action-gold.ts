import type { QuestionDraft } from '../../server/protocol';

type PrimaryFunction = QuestionDraft['primaryFunction'];

/** Synthetic semantic evaluation data, never a runtime classifier or prompt rule. */
export const dialogueActionGoldProvenance = {
  version: 'dialogue-action-md-gold-v1',
  provenance: 'MD기반 수동 기대행동 / 사람 검수 대기',
  authoringMethod: 'Agent-authored synthetic cases and expectations, manually mapped to canonical MD clauses.',
  labelAuthor: 'Codex (MD-based)',
  humanReviewStatus: 'pending',
  humanReviewed: false,
  sourceStudentDataUsed: false,
  modelOutputsUsedAsGold: false,
  promptExampleOverlap: 'No 토론/미술 examples used by the candidate prompt are included in this fixture.',
  liveRunPolicy: 'Use an exactly matching approved historical question or a fresh explicitly ephemeral independently reviewed contract. Never attach an old approval/hash to a different synthetic question.',
  intendedUse: 'Frozen evaluation cases and repeated-run consistency checks; not executable production meaning rules.',
  countingPolicy: 'Count base scenarios and paraphrase variants separately; variants are not independent interview samples.',
} as const;

export const dialogueActionGoldMdSources = {
  student: '각자의답_MD/5. 학생부_분석_기준_v2.2.md',
  operation: '각자의답_MD/8. 면접엔진_공통운영원칙_v2.0.md',
  question: '각자의답_MD/9. 면접엔진_질문생성_가이드라인_v2.3.md',
  evaluation: '각자의답_MD/10. 면접엔진_답변평가_가이드라인_v2.3.md',
} as const;

export type DialogueGoldAction = 'FOLLOW_UP' | 'CLARIFICATION' | 'REPLAY' | 'TRANSITION' | 'CLOSING';
export type DialogueGoldCoverage = 'met' | 'partial' | 'unknown';
export type DialogueGoldResponse = 'answered' | 'unavailable' | 'unrelated' | 'unclear';
export interface DialogueGoldMdReference {
  document: keyof typeof dialogueActionGoldMdSources;
  clause: string;
  startLine: number;
  endLine: number;
  rationale: string;
}
export interface DialogueGoldHistoryTurn {
  question: string;
  answer: string;
  kind: 'main' | 'follow_up' | 'clarification';
}
export interface DialogueGoldLimits {
  followUpsUsed: number;
  clarificationsUsed: number;
  allowReplay: boolean;
  remainingMs: number;
  phase: 'MAIN' | 'CLOSING';
}
export interface DialogueActionGoldCase {
  id: string;
  category: string;
  title: string;
  question: string;
  currentQuestionKind: 'main' | 'follow_up' | 'clarification' | 'end';
  runtimeEligibility: 'requires_ephemeral_reviewed_contract' | 'prompt_rubric_only';
  primaryFunction: PrimaryFunction;
  depth: 'D1' | 'D2' | 'D3' | 'D4';
  /** Deliberately synthetic source. Never mix with a real student's official record. */
  sourceText: string;
  history: DialogueGoldHistoryTurn[];
  limits: DialogueGoldLimits;
  variants: Array<{ id: string; answer: string }>;
  expected: {
    actions: DialogueGoldAction[];
    coverage: DialogueGoldCoverage[];
    response: DialogueGoldResponse[];
    questionScope: string;
    forbiddenProbes: string[];
    rationale: string;
    /** Alternatives acknowledge legitimate interviewer discretion, not a statistical confidence interval. */
    allowsDiscretion: boolean;
    scoring: {
      currentAnswer: 'evaluate_only_current_spoken_demand' | 'non_evaluative_closing';
      preserveCurrentCoverageWhenChoosingNext: true;
      nextByAction: Array<{
        action: DialogueGoldAction;
        independentAnswerScore: boolean;
        consumesFollowUp: boolean;
        consumesMeaningRephrase: boolean;
      }>;
    };
  };
  mdRefs: DialogueGoldMdReference[];
}

export const dialogueActionGoldMdBasis = {
  sameDemand: { document: 'operation', clause: '제10조 ①·④', startLine: 124, endLine: 127, rationale: '재표현과 새 질문은 의도·확인 대상·답변 요구의 동일성으로 구별한다.' },
  clarifyVsProbe: { document: 'question', clause: '제9조 ③', startLine: 120, endLine: 123, rationale: '새 평가 요소를 확인하는 CLARIFY_CONTENT와 동일 의미 재진술을 구별한다.' },
  responseDriven: { document: 'question', clause: '제15조', startLine: 181, endLine: 188, rationale: '실제 응답의 충족·누락·주장을 보고 필요한 한 지점만 확인한다.' },
  rephrase: { document: 'question', clause: '제16조 ①·②', startLine: 190, endLine: 193, rationale: '원질문 의도·요구 유지 재진술과 새 평가 과제 추가를 구별한다.' },
  offTopic: { document: 'question', clause: '제16조 ③~⑥', startLine: 194, endLine: 197, rationale: '첫 무관 응답은 재안내, 반복은 전환하며 모름·독창적 응답을 장난으로 단정하지 않는다.' },
  sufficiency: { document: 'evaluation', clause: '제2조', startLine: 31, endLine: 37, rationale: '짧은 답변도 실제 질문의 요구를 충족하면 충분하고 요구하지 않은 요소 누락은 불이익 사유가 아니다.' },
  noHiddenRequirement: { document: 'evaluation', clause: '제6조 ①·②', startLine: 81, endLine: 82, rationale: '발화에 없던 조건을 필수로 승격하지 않고 질문이 모호하면 학생에게 유리하게 해석한다.' },
  claimStatus: { document: 'evaluation', clause: '제7조', startLine: 85, endLine: 101, rationale: '새 진술·기록 충돌·확인 불가를 구별하고 미기록 경험을 거짓으로 단정하지 않는다.' },
  facts: { document: 'student', clause: '1.1 사실 우선', startLine: 30, endLine: 51, rationale: '행동·성과·감정을 만들지 않고 원문과 정정의 충돌은 별도 이력으로 보존한다.' },
  meaningNotWording: { document: 'student', clause: '1.4 의미 복원', startLine: 70, endLine: 82, rationale: '문장 일치가 아니라 질문 의도에 맞는 의미를 해석한다.' },
  sourceScope: { document: 'question', clause: '제4조', startLine: 52, endLine: 58, rationale: '새 사실은 후속 확인할 수 있지만 확정 기록으로 승격하거나 미확인 갈등·수치를 전제하지 않는다.' },
  unknown: { document: 'operation', clause: '제14조 ③~⑤', startLine: 189, endLine: 191, rationale: '모름은 정답을 알려주지 않고 필요시 전환하며 같은 내용을 반복 추궁하지 않는다.' },
  budgets: { document: 'operation', clause: '제13조', startLine: 176, endLine: 183, rationale: '묶음당 F 최대2·재진술 원칙1회이며 상한을 채울 의무는 없다.' },
  closing: { document: 'question', clause: '제17조', startLine: 199, endLine: 204, rationale: '시간·충족·반복에 따라 전환하고 CLOSING에서 새 심층 묶음을 시작하지 않는다.' },
  noRetroactiveScoring: { document: 'evaluation', clause: '제4조', startLine: 48, endLine: 54, rationale: 'target_evidence는 실제 질문 의미이며 실제 발화에 없던 요구를 사후 추가하지 않는다.' },
} satisfies Record<string, DialogueGoldMdReference>;
const basis = dialogueActionGoldMdBasis;

type CaseInput = Omit<DialogueActionGoldCase, 'history' | 'limits' | 'variants' | 'expected' | 'currentQuestionKind' | 'runtimeEligibility'> & {
  currentQuestionKind?: DialogueActionGoldCase['currentQuestionKind'];
  runtimeEligibility?: DialogueActionGoldCase['runtimeEligibility'];
  history?: DialogueGoldHistoryTurn[];
  limits?: Partial<DialogueGoldLimits>;
  answers: readonly [string, string, string];
  expected: Omit<DialogueActionGoldCase['expected'], 'allowsDiscretion' | 'scoring'> & { allowsDiscretion?: boolean };
};
const scenario = ({ answers, history = [], limits = {}, expected, currentQuestionKind = 'main', runtimeEligibility = 'requires_ephemeral_reviewed_contract', ...rest }: CaseInput): DialogueActionGoldCase => ({
  ...rest,
  currentQuestionKind,
  runtimeEligibility,
  history,
  limits: { followUpsUsed: 0, clarificationsUsed: 0, allowReplay: true, remainingMs: 480_000, phase: 'MAIN', ...limits },
  variants: answers.map((answer, index) => ({ id: `${rest.id}-v${index + 1}`, answer })),
  expected: { ...expected, allowsDiscretion: expected.allowsDiscretion ?? false, scoring: {
    currentAnswer: currentQuestionKind === 'end' ? 'non_evaluative_closing' : 'evaluate_only_current_spoken_demand',
    preserveCurrentCoverageWhenChoosingNext: true,
    nextByAction: expected.actions.map(action => ({ action, independentAnswerScore: action === 'FOLLOW_UP', consumesFollowUp: action === 'FOLLOW_UP', consumesMeaningRephrase: action === 'CLARIFICATION' })),
  } },
});

export const dialogueActionGoldCases: DialogueActionGoldCase[] = [
  scenario({
    id: 'DG-01', category: 'same_demand_role', title: '막연한 팀 답변에 원래 본인 행동 요구 재진술',
    question: '자료 비교 활동에서 본인이 직접 한 일은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '팀으로 자료 비교 활동에 참여함.',
    answers: ['그냥 다 같이 했어요.', '특별히 나누지 않고 함께 했습니다.', '친구들과 같이 진행한 거예요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['partial'], response: ['answered'], questionScope: '원래 물은 본인 행동 한 가지를 같은 의미로 다시 안내한다.', forbiddenProbes: ['새 역할·갈등·성공을 가정', '동일한 전체 역할 요구를 FOLLOW_UP으로 산정', '선택 기준·성과 등 새 평가 과제 추가'], rationale: '현재 답변은 팀 참여만 말했으며 새 하위 과제에 앞서 원래 요구를 보존해 재안내한다.' },
    mdRefs: [basis.sameDemand, basis.clarifyVsProbe, basis.rephrase],
  }),
  scenario({
    id: 'DG-02', category: 'same_demand_process', title: '과정 전체를 아직 설명하지 않은 답변의 재진술',
    question: '설문 응답을 정리한 순서를 말씀해 주세요.', primaryFunction: 'PROCESS', depth: 'D2', sourceText: '설문 응답을 수합하고 정리하는 활동에 참여함.',
    answers: ['그냥 응답을 정리했습니다.', '결과를 보고 정리한 겁니다.', '수합한 내용을 정리했어요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['partial'], response: ['answered'], questionScope: '이미 요청한 정리 순서를 쉽게 다시 묻는다.', forbiddenProbes: ['순서 전체의 재요구를 새 F로 처리', '통계 도구·표본 제거 수행을 단정', '새 성과 검증 추가'], rationale: '순서의 특정 미답 하위 부분을 고를 근거가 없으며 동일한 전체 과정 요구만 남아 있다.' },
    mdRefs: [basis.sameDemand, basis.rephrase, basis.responseDriven],
  }),
  scenario({
    id: 'DG-03', category: 'same_demand_concept', title: '개념의 전체 의미를 다시 묻는 경우',
    question: '자료의 신뢰성이 무엇을 뜻하는지 설명해 주세요.', primaryFunction: 'CONCEPT', depth: 'D1', sourceText: '자료의 출처와 신뢰성을 살펴보는 탐구를 진행함.',
    answers: ['좋은 자료라는 뜻입니다.', '믿을 만하다는 말인 것 같습니다.', '괜찮은 내용이라는 뜻이에요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['partial'], response: ['answered'], questionScope: '원래의 신뢰성 의미 설명을 쉬운 말로 재안내한다.', forbiddenProbes: ['전체 개념 정의 재요구를 새로운 F로 산정', '미확인 지식 오류 단정', '다른 전문 개념의 정의 추가'], rationale: '막연한 동의어만 나온 상황에서 원래 개념의 뜻을 다시 묻는 것은 동일 요구다.' },
    mdRefs: [basis.sameDemand, basis.rephrase, basis.meaningNotWording],
  }),
  scenario({
    id: 'DG-04', category: 'single_action_satisfied', title: '구체적인 본인 행동 하나면 충분',
    question: '안내 자료를 준비하며 본인이 직접 한 일 한 가지는 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '팀원들과 행사 안내 자료를 준비함.',
    answers: ['제가 안내문에서 어려운 용어를 쉬운 말로 고쳤습니다.', '어려운 단어를 찾아 안내문 표현을 바꾼 것이 제가 한 일입니다.', '저는 읽기 어려운 안내 문구를 직접 쉽게 수정했어요.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '추가 질문 없이 현재 요구 충족을 보존한다.', forbiddenProbes: ['원래 본인 행동 재요구', '성과·동기·협업 사례를 현재 필수 요소로 추가', '분량이 짧다는 이유로 partial 판정'], rationale: '현재 요구는 한 가지 직접 행동이며 구체적 행동이 제공됐다. 이 사례에는 새 검증을 유발하는 별도 주장이 없다.' },
    mdRefs: [basis.sufficiency, basis.noHiddenRequirement, basis.budgets],
  }),
  scenario({
    id: 'DG-05', category: 'or_scope', title: 'OR로 제시된 활동 중 한 활동의 행동',
    question: '전시 안내를 하거나 홍보 카드를 만들 때 본인이 한 일은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '전시 안내와 홍보 카드 제작 활동에 참여함.',
    answers: ['홍보 카드의 글자 크기를 조정하고 안내 문구를 고쳤습니다.', '카드에서 작은 글씨를 크게 만들고 문장을 다듬은 일을 했어요.', '제가 한 일은 홍보 카드 문구를 쉽게 고치고 글씨를 키운 것입니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '선택 범위 안의 한 활동에서 나온 행동으로 충족한다.', forbiddenProbes: ['나머지 전시 안내 행동을 필수 보완으로 요구', 'OR를 각 활동 모두의 응답 의무로 변경', '다른 활동 미언급을 partial 사유로 사용'], rationale: '질문이 선택적으로 제시한 활동 중 하나에서 본인 행동을 답했다.' },
    mdRefs: [basis.noHiddenRequirement, basis.sufficiency, basis.noRetroactiveScoring],
  }),
  scenario({
    id: 'DG-06', category: 'listed_context_scope', title: '여러 활동은 맥락이며 각각 모두를 요구하지 않음',
    question: '학교 축제 안내와 포스터 제작 활동에서 본인이 직접 한 일이 있다면 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '학교 축제 안내와 포스터 제작 활동에 참여함.',
    answers: ['포스터에 들어갈 행사 시간을 확인하고 잘못된 부분을 고쳤습니다.', '저는 포스터의 시간 정보를 검토해서 오류를 수정했습니다.', '행사 시각이 틀리지 않았는지 확인해 포스터 내용을 바로잡았어요.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '명시적으로 각 활동을 모두 요구하지 않은 단일 본인 행동 요구로 해석한다.', forbiddenProbes: ['축제 현장 안내 행동까지 반드시 요구', '학생이 말하지 않은 다른 활동을 미답으로 추가', '모호한 목록을 두 개의 필수 과제로 확대'], rationale: '한 가지 실제 행동이 질문의 자연스러운 해석을 충족하며 모호한 요구는 학생에게 불리하게 확장하지 않는다.' },
    mdRefs: [basis.noHiddenRequirement, basis.sufficiency, basis.sameDemand],
  }),
  scenario({
    id: 'DG-07', category: 'explicit_both_scope', title: '각각 모두를 명시한 한 역할 확인 요구의 미답 부분',
    question: '축제 안내와 포스터 제작 각각에서 본인이 한 일을 하나씩 말씀해 주세요.', primaryFunction: 'ROLE', depth: 'D1', sourceText: '학교 축제 안내와 포스터 제작 활동에 참여함.',
    answers: ['포스터에 들어갈 행사 시간을 확인하고 고쳤습니다.', '저는 포스터의 잘못된 시간 정보를 수정했습니다.', '포스터 제작에서는 행사 시각 오류를 바로잡았어요.'],
    expected: { actions: ['FOLLOW_UP'], coverage: ['partial'], response: ['answered'], questionScope: '아직 설명하지 않은 축제 안내의 본인 행동만 확인한다.', forbiddenProbes: ['이미 설명한 포스터 행동을 다시 요구', '양쪽 활동의 동기·성과 추가', '미답인 안내 행동이 있었다고 먼저 단정'], rationale: '현재 발화가 각각의 행동을 명시했으며 한 부분은 답하고 다른 하위 범위는 아직 답하지 않았다.' },
    mdRefs: [basis.responseDriven, basis.noHiddenRequirement, basis.sourceScope],
  }),
  scenario({
    id: 'DG-08', category: 'explicit_comparison_missing_part', title: '비교의 한쪽만 설명한 경우',
    question: '두 자료 A와 B의 작성 시점은 어떻게 달랐나요?', primaryFunction: 'CONCEPT', depth: 'D3', sourceText: '자료 A와 B의 작성 시점을 비교함.',
    answers: ['A는 작년에 작성됐습니다.', '자료 A의 작성 시점은 지난해입니다.', '제가 본 A 자료는 전년도에 나온 자료였습니다.'],
    expected: { actions: ['FOLLOW_UP'], coverage: ['partial'], response: ['answered'], questionScope: '비교를 완성할 아직 미답인 B의 작성 시점만 확인한다.', forbiddenProbes: ['A의 작성 시점을 다시 요구', '작성 시점에서 진실성·인격을 추론', 'B의 특정 연도를 발명'], rationale: '비교 자체가 하나의 인지 요구이며 현재 질문에 실제로 포함된 B의 비교 정보가 빠졌다.' },
    mdRefs: [basis.responseDriven, basis.noHiddenRequirement, basis.facts],
  }),
  scenario({
    id: 'DG-09', category: 'comparison_semantic_completion', title: '대조 표현 없이 나눠 설명한 비교도 충족',
    question: '자료 A와 B는 조사 대상에서 어떤 차이가 있었나요?', primaryFunction: 'CONCEPT', depth: 'D3', sourceText: '자료 A와 B의 조사 대상을 비교함.',
    answers: ['A는 전국 학생을 조사했습니다. B에는 우리 지역 학생만 들어갔습니다.', '전국의 학생이 A의 조사 대상이고, B의 대상은 이 지역 학생입니다.', 'A 자료는 전국 학생 이야기예요. 지역 안의 학생만 조사한 것은 B였습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '두 대상의 의미상 대조를 충족으로 보존한다.', forbiddenProbes: ['차이라는 단어가 없다는 이유로 재비교 요구', '같은 A/B 대상 설명 반복', '더 많은 수치·결과를 사후 필수화'], rationale: '양쪽의 범위가 분명하여 문장 순서나 특정 연결어 없이도 차이가 전달됐다.' },
    mdRefs: [basis.meaningNotWording, basis.sufficiency, basis.noRetroactiveScoring],
  }),
  scenario({
    id: 'DG-10', category: 'explicit_unanswered_subpart', title: '명시된 검토 과정의 아직 설명하지 않은 부분',
    question: '자료를 고르며 출처와 작성 시점을 각각 어떻게 확인했나요?', primaryFunction: 'PROCESS', depth: 'D2', sourceText: '자료의 출처와 작성 시점을 확인하며 탐구 자료를 선택함.',
    answers: ['출처는 해당 기관의 공식 홈페이지인지 확인했습니다.', '기관이 직접 올린 자료인지 확인해서 출처를 검토했습니다.', '작성 기관의 공식 누리집에 있는 자료인지 먼저 봤습니다.'],
    expected: { actions: ['FOLLOW_UP'], coverage: ['partial'], response: ['answered'], questionScope: '아직 말하지 않은 작성 시점 확인 방법만 묻는다.', forbiddenProbes: ['기관 출처 확인을 같은 말로 재요구', '자료의 정확성을 이미 검증했다고 단정', '수치·통계 분석을 추가'], rationale: '하나의 검토 과정에서 실제 질문이 각각 요구한 두 범위 중 출처 확인만 제공됐다.' },
    mdRefs: [basis.responseDriven, basis.noHiddenRequirement, basis.facts],
  }),
  scenario({
    id: 'DG-11', category: 'partial_unavailable_memory', title: '비교는 답하고 남은 조건만 기억 불가',
    question: '두 결과를 같은 기준으로 비교하기 위해 맞춘 조건은 무엇이었나요?', primaryFunction: 'PROCESS', depth: 'D2', sourceText: '두 조건의 측정 결과를 비교하는 탐구를 진행함.',
    answers: ['같은 장비를 썼습니다. 측정 시간과 나머지 조건은 지금 기억나지 않습니다.', '장비는 동일하게 사용했지만 시간이나 다른 조건은 기억이 안 납니다.', '동일한 장비로 측정했습니다. 다만 그 밖의 조건은 떠오르지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['partial'], response: ['unavailable'], questionScope: '답한 동일 장비 정보를 보존하고 현재 기억 불가인 나머지 조건은 다시 요구하지 않는다.', forbiddenProbes: ['시간·나머지 조건 재추궁', '앞의 장비 설명까지 없는 답변으로 폐기', '기억 불가를 met·장난·기술 장애로 변경'], rationale: '현재 미답 범위를 직접 기억 불가로 밝혔으며 이미 답한 부분과 구별해야 한다.' },
    mdRefs: [basis.unknown, basis.responseDriven, basis.facts],
  }),
  scenario({
    id: 'DG-12', category: 'whole_demand_unavailable', title: '현재 요구 전체를 기억하지 못함',
    question: '그 자료를 선택한 이유는 무엇이었나요?', primaryFunction: 'CHOICE', depth: 'D2', sourceText: '탐구에 사용할 자료를 선택함.',
    answers: ['당시 왜 골랐는지는 기억나지 않습니다.', '자료 선택 이유는 지금 답하기 어렵습니다.', '왜 그 자료를 택했는지 떠오르지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['unknown'], response: ['unavailable'], questionScope: '현재 선택 이유의 기억 불가를 수용한다.', forbiddenProbes: ['선택 이유를 다시 반복 추궁', '선택 기준 힌트·정답 제공', '기억 불가를 무관 응답이나 인격 문제로 단정'], rationale: '유효한 선택 이유는 아직 없고 현재 요구를 답할 수 없다는 명확한 의사를 보였다.' },
    mdRefs: [basis.unknown, basis.offTopic, basis.closing],
  }),
  scenario({
    id: 'DG-13', category: 'unavailable_other_scope', title: '다른 과제의 기억 불가가 현재 답변을 취소하지 않음',
    question: '홍보 카드 제작에서 본인이 직접 한 일은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '홍보 카드 제작과 별도의 설문 활동에 참여함.',
    answers: ['카드 문구를 쉬운 말로 고쳤습니다. 별도로 했던 설문의 응답 수는 기억나지 않습니다.', '제가 한 것은 카드의 어려운 표현을 고친 일입니다. 다른 설문의 인원수는 모르겠습니다.', '홍보 카드 문장을 쉽게 바꾸는 일을 했어요. 설문 참여자 수는 떠오르지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '현재 카드 제작의 행동 설명을 충족으로 보존한다.', forbiddenProbes: ['다른 설문의 기억 불가를 현재 역할 전체 포기로 해석', '설문 응답 수 확인으로 주제 확대', '현재 역할을 재진술·재요구'], rationale: '기억 불가의 주어와 범위는 별도 설문이며 현재 요구한 행동은 명확히 답했다.' },
    mdRefs: [basis.sufficiency, basis.noHiddenRequirement, basis.meaningNotWording],
  }),
  scenario({
    id: 'DG-14', category: 'negative_answer_open_presence', title: '존재를 여는 질문에 없었다고 답한 경우',
    question: '안내 활동에서 본인이 직접 작성한 문서가 있었나요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '안내 활동에 참여함. 개인의 문서 작성 여부는 기록만으로 확인되지 않음.',
    answers: ['없었습니다. 문서는 다른 친구가 작성했습니다.', '문서를 직접 쓴 일은 없습니다.', '저는 작성하지 않았고 팀원이 문서를 썼습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '문서 작성이 없었다는 존재 확인 답변을 수용한다.', forbiddenProbes: ['작성한 문서 내용이나 성과를 묻기', '부정을 회피·무응답으로 해석', '학생이 작성했다고 전제'], rationale: '열린 존재 확인에는 부정도 완전한 답이며 없는 행동을 계속 요구하지 않는다.' },
    mdRefs: [basis.sourceScope, basis.sufficiency, basis.facts],
  }),
  scenario({
    id: 'DG-15', category: 'term_correction_scope', title: '용어 하나의 정정이 주변 설명을 철회하지 않음',
    question: '자료를 선택할 때 어떤 기준을 사용했나요?', primaryFunction: 'CHOICE', depth: 'D2', sourceText: '기관과 자료의 갱신 시점 등을 검토해 자료를 선택함.',
    answers: ['발행 기관과 작성 연도를 봤습니다. 작성 연도라는 말은 갱신 연도로 고치겠습니다.', '기관이 어디인지와 작성 시점을 확인했어요. 정확히는 작성이 아니라 갱신 시점입니다.', '출처 기관과 작성 날짜를 기준으로 골랐습니다. 방금 작성 날짜는 갱신 날짜를 뜻했습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '정정된 갱신 시점과 유효한 기관 기준을 함께 보존한다.', forbiddenProbes: ['전체 선택 설명을 철회한 것으로 해석', '정정 전 용어를 다시 비판·추궁', '정정 자체를 모순·거짓말로 단정'], rationale: '한 용어의 범위를 명시적으로 바로잡았으며 선택 기준 설명은 유지된다.' },
    mdRefs: [basis.facts, basis.meaningNotWording, basis.claimStatus],
  }),
  scenario({
    id: 'DG-16', category: 'number_correction_scope', title: '수치 정정 후 현재 유효한 비교 설명 보존',
    question: '첫 번째와 두 번째 측정값은 어떻게 달랐나요?', primaryFunction: 'RESULT', depth: 'D1', sourceText: '두 번의 측정 결과를 비교함. 세부 측정값은 원문에 없음.',
    answers: ['처음 10, 다음 15였습니다. 처음 값은 10이 아니라 12로 정정하겠습니다.', '첫 값이 10이고 둘째가 15였어요. 첫 값은 다시 말하면 12가 맞습니다.', '10에서 15가 됐다고 했는데 시작 값만 12로 바로잡겠습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '첫 값 12·둘째 값 15라는 현재 유효한 진술을 비교 응답으로 보존한다.', forbiddenProbes: ['철회된 10을 학생의 현재 주장으로 유지', '숫자 정정을 거짓말·인격으로 확대', '답변 수치를 공식 기록의 확정 사실로 승격'], rationale: '정정 범위와 최종 유효 진술이 분명하며 정정 자체가 새 검증을 의무화하지 않는다.' },
    mdRefs: [basis.facts, basis.claimStatus, basis.sufficiency],
  }),
  scenario({
    id: 'DG-17', category: 'new_claim_after_sufficient_answer', title: '충족한 행동 뒤 새 보편 주장 검증',
    question: '자료 정리를 돕기 위해 본인이 만든 기능은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '자료 정리를 돕는 간단한 프로그램을 제작함.',
    answers: ['중복 항목을 표시하는 기능을 만들었습니다. 어떤 자료를 넣어도 절대로 오류가 나지 않습니다.', '제가 만든 건 중복 표시 기능입니다. 모든 입력에서 오류 없이 작동한다고 생각합니다.', '겹치는 항목을 찾아 표시하게 만들었어요. 어떤 상황에도 오류는 없다고 봅니다.'],
    expected: { actions: ['FOLLOW_UP', 'TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: 'F를 선택한다면 실제 새로 한 오류 없음 주장의 적용 범위나 확인 근거 한 가지만 묻는다.', forbiddenProbes: ['만든 기능 전체를 다시 요구', '새 검증 실익 때문에 현재 역할 답변을 partial로 낮춤', '오류가 실제 발생했다거나 모든 입력 시험을 수행했다고 단정'], rationale: '현재 역할은 충족했고 새 주장에는 검증 실익이 있으나 MD는 F를 반드시 발화하도록 강제하지 않는다.', allowsDiscretion: true },
    mdRefs: [basis.responseDriven, basis.sourceScope, basis.budgets],
  }),
  scenario({
    id: 'DG-18', category: 'actual_statement_pair', title: '서로 다른 실제 진술의 관계 확인',
    question: '자료 분류 프로그램에서 본인이 직접 한 일은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '팀으로 자료 분류 프로그램 제작에 참여함. 개인별 구현 범위는 확인되지 않음.',
    history: [{ kind: 'main', question: '프로그램의 코드를 직접 작성했나요?', answer: '코드는 직접 쓰지 않았고 친구가 만든 코드를 사용했습니다.' }],
    answers: ['프로그램 코드는 전부 제가 직접 작성했습니다.', '전체 코드를 제가 쓴 것이 본인이 한 일입니다.', '코드 작성은 모두 제가 직접 했습니다.'],
    expected: { actions: ['FOLLOW_UP'], coverage: ['met'], response: ['answered'], questionScope: '직접 작성하지 않았다는 앞선 실제 진술과 전부 작성했다는 현재 진술의 차이를 중립적으로 확인한다.', forbiddenProbes: ['거짓말·인성·부정행위 단정', '관계없는 기록 부재를 모순 증거로 추가', '이미 해명했다고 가정'], rationale: '현재 역할 진술은 존재하며 두 실제 발화의 범위 차이에 확인 가치가 있다. 공식 사실의 오류 판정은 아니다.' },
    mdRefs: [basis.claimStatus, basis.responseDriven, basis.facts],
  }),
  scenario({
    id: 'DG-19', category: 'resolved_correction', title: '기본 틀과 수정 범위를 구분해 해소한 정정',
    question: '자료 분류 프로그램에서 본인이 직접 한 일은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '팀으로 자료 분류 프로그램 제작에 참여함.',
    history: [{ kind: 'main', question: '프로그램의 코드를 직접 작성했나요?', answer: '친구가 만든 코드를 사용했습니다.' }],
    answers: ['앞서 쓴 코드는 기본 틀을 말한 겁니다. 기본 틀은 친구에게 받았고 저는 분류 조건을 추가했습니다.', '친구 코드를 썼다는 것은 공통 틀 이야기였어요. 제가 직접 바꾼 부분은 분류 조건입니다.', '기본 코드는 친구 것이지만 분류 조건을 추가한 것은 저입니다. 앞선 말은 그 기본 코드를 뜻했습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '기본 틀과 개인 수정이라는 서로 다른 범위를 보존한다.', forbiddenProbes: ['해소된 진술 차이를 다시 모순으로 추궁', '전체를 직접 작성했다고 바꿔 기록', '기본 틀 사용 때문에 개인 행동을 무응답으로 처리'], rationale: '앞선 발화의 범위를 구체화했고 현재 개인 행동도 설명했으며 새로운 검증 주장은 없다.' },
    mdRefs: [basis.claimStatus, basis.facts, basis.sufficiency],
  }),
  scenario({
    id: 'DG-20', category: 'first_unrelated', title: '첫 무관 응답은 같은 취지 재안내',
    question: '자료를 고를 때 사용한 기준은 무엇인가요?', primaryFunction: 'CHOICE', depth: 'D2', sourceText: '탐구 자료를 고르는 활동에 참여함.',
    answers: ['오늘 점심에는 국수를 먹었습니다.', '제가 오늘 점심으로 먹은 것은 국수입니다.', '점심 메뉴는 국수였고 오늘 그걸 먹었어요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['unknown'], response: ['unrelated'], questionScope: '현재 자료 선택 기준의 취지를 한 차례만 정중히 재안내한다.', forbiddenProbes: ['무관한 음식·영화·게임 주장의 근거를 F로 확인', '장난·인성·성실성 단정', '새 주제로 질문 의도 변경'], rationale: '질문과 명백히 무관하지만 첫 응답이므로 정중한 동일 취지 재안내가 맞다.' },
    mdRefs: [basis.offTopic, basis.rephrase, basis.sameDemand],
  }),
  scenario({
    id: 'DG-21', category: 'repeated_unrelated', title: '취지 재안내 후 반복 무관 응답은 묶음 종료',
    currentQuestionKind: 'clarification',
    question: '자료를 선택할 때 실제로 살펴본 기준을 말씀해 주세요.', primaryFunction: 'CHOICE', depth: 'D2', sourceText: '탐구 자료를 고르는 활동에 참여함.',
    history: [{ kind: 'main', question: '자료를 고를 때 사용한 기준은 무엇인가요?', answer: '오늘 점심에는 국수를 먹었습니다.' }],
    limits: { clarificationsUsed: 1 },
    answers: ['계속 점심 메뉴만 생각납니다.', '여전히 점심 메뉴 생각만 하고 있습니다.', '지금도 점심에 뭘 먹었는지만 떠오릅니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['unknown'], response: ['unrelated'], questionScope: '현재 묶음을 종료하고 필요한 짧은 전환만 제공한다.', forbiddenProbes: ['두 번째 동일 취지 재안내', '무관 주제 후속 질문', '설교·조롱·인성 평가'], rationale: '현재 질문이 이미 원래 취지의 재안내이며 같은 묶음에서 무관 응답이 반복됐다.' },
    mdRefs: [basis.offTopic, basis.budgets, basis.closing],
  }),
  scenario({
    id: 'DG-22', category: 'replay_request', title: '원 질문을 다시 듣는 요청',
    question: '발표 자료에서 본인이 수정한 부분은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '발표 자료를 검토하고 수정함.',
    answers: ['질문을 한 번만 다시 말씀해 주시겠어요?', '방금 질문을 다시 듣고 싶습니다.', '죄송하지만 같은 질문을 한 번 더 말해 주세요.'],
    expected: { actions: ['REPLAY'], coverage: ['unknown'], response: ['answered'], questionScope: '현재 승인 질문과 같은 음성을 다시 재생하고 질문을 새로 작성하지 않는다.', forbiddenProbes: ['질문 의미를 바꾸는 재진술', 'F·의미 재진술 횟수 소비', '명확한 재청취 요청을 무관·내용 불명으로 분류'], rationale: '평가 내용 답변은 아직 없지만 재청취 의사는 명확하며 의미 풀이를 요청하지 않았다.' },
    mdRefs: [basis.sameDemand, basis.rephrase, basis.noRetroactiveScoring],
  }),
  scenario({
    id: 'DG-23', category: 'meaning_request', title: '뜻을 쉽게 풀어 달라는 요청',
    question: '두 자료의 전제가 달랐다면 해석에서 어떤 점을 유의했나요?', primaryFunction: 'LIMIT', depth: 'D4', sourceText: '서로 다른 자료의 전제를 확인하고 해석 범위를 검토함.',
    answers: ['전제가 다르다는 말이 무슨 뜻인지 쉽게 설명해 주세요.', '질문의 뜻을 잘 모르겠습니다. 쉬운 말로 풀어 주실 수 있나요?', '무엇을 말씀드려야 하는지 이해가 안 돼서 질문을 쉽게 바꿔 주세요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['unknown'], response: ['answered'], questionScope: '동일한 자료 해석의 유의점 요구를 쉬운 말로 풀되 조건부 전제를 보존한다.', forbiddenProbes: ['어려운 원문을 그대로 재생하는 것으로만 처리', '조건부를 두 자료 전제가 실제 달랐다는 단정으로 변경', '정답·한계 사례 힌트 제공', '새 평가 기준 추가'], rationale: '뜻풀이를 명시적으로 요청했으므로 단순 재청취와 구분한다.' },
    mdRefs: [basis.rephrase, basis.sameDemand, basis.sourceScope],
  }),
  scenario({
    id: 'DG-24', category: 'partial_answer_plus_replay', title: '부분 답변과 함께 나온 재청취 요청',
    question: '자료 A와 B는 조사 대상에서 어떤 차이가 있었나요?', primaryFunction: 'CONCEPT', depth: 'D3', sourceText: '자료 A와 B의 조사 대상을 비교함.',
    answers: ['A는 전국 학생을 조사했습니다. 질문을 한 번 더 말씀해 주실 수 있나요?', '전국 학생을 다룬 것이 A입니다. 방금 질문을 다시 듣고 싶어요.', 'A의 대상은 전국 학생입니다. 뒤의 질문을 놓쳐서 같은 질문을 다시 말해 주세요.'],
    expected: { actions: ['REPLAY'], coverage: ['partial'], response: ['answered'], questionScope: '이미 답한 A 정보를 보존한 채 원 질문을 재생한다.', forbiddenProbes: ['재청취 전에 B의 새 F부터 발화', '앞의 A 답변을 없는 것으로 폐기', '같은 음성 재생을 F 또는 의미 재진술로 산정'], rationale: '명확한 재청취 요청이 현재 응답에 포함돼 있으나 실제로 제공한 부분 의미까지 지우면 안 된다.' },
    mdRefs: [basis.sameDemand, basis.rephrase, basis.meaningNotWording],
  }),
  scenario({
    id: 'DG-25', category: 'non_template_sufficient_answer', title: '특정 평가 단어 없이도 선택 기준을 전달',
    question: '읽을 책을 고를 때 어떤 기준을 사용했나요?', primaryFunction: 'CHOICE', depth: 'D2', sourceText: '탐구 주제와 관련된 책을 선택해 읽음.',
    answers: ['목차를 펼쳐 보고 제가 알아보고 싶은 내용이 들어 있는 책을 골랐습니다.', '관심 있는 질문을 다루는 장이 있는지 살펴보고 그 책을 읽기로 했어요.', '제가 궁금한 주제를 설명하는 부분이 있는 책부터 찾아 읽었습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '선택 기준의 의미를 충족으로 해석한다.', forbiddenProbes: ['기준·근거라는 특정 단어 부재로 partial 판정', '동일 선택 기준 재요구', '읽지 않은 책 내용 암기 질문 추가'], rationale: '현재 요구에 직접 답하는 기준과 선택 행동이 실제 언어로 드러났다.' },
    mdRefs: [basis.meaningNotWording, basis.sufficiency, basis.noHiddenRequirement],
  }),
  scenario({
    id: 'DG-26', category: 'new_criterion_is_follow_up', title: '이미 설명한 행동에서 선택 기준을 새로 묻는 경우',
    question: '검토표를 만들며 본인이 한 일은 무엇인가요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '팀에서 검토표를 제작하고 항목을 정리함.',
    answers: ['제가 검토 항목을 모아서 중요도 순으로 배열했습니다.', '검토할 항목을 정리한 뒤 중요하다고 본 순서대로 배치한 일을 했습니다.', '팀에서 제가 한 일은 항목을 취합하고 중요도 순서를 정한 것입니다.'],
    expected: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], response: ['answered'], questionScope: 'F를 선택하면 중요도 순서를 정한 기준이라는 새 하위 검증 요구 한 가지만 묻는다. 이 새 기준 질문은 CLARIFICATION이 아니다.', forbiddenProbes: ['기준 설명이 원래 역할 질문의 필수였다고 소급', '기준이라는 새 평가 요구를 재진술로 산정', '이미 설명한 항목 취합·배열 행동 전체 재요구'], rationale: '본인 행동은 충족했고, 선택 기준은 요청할 수 있는 별도의 종속 확인이며 의무 F는 아니다.', allowsDiscretion: true },
    mdRefs: [basis.sameDemand, basis.clarifyVsProbe, basis.noRetroactiveScoring, basis.budgets],
  }),
  scenario({
    id: 'DG-27', category: 'new_unrecorded_experience', title: '기록에 없는 새 경험의 중립적 수용',
    question: '자료가 부족했을 때 본인이 보완한 일이 있었나요?', primaryFunction: 'ROLE', depth: 'D1', sourceText: '지역 관련 자료를 조사함. 자료 보완 방식은 자세히 기록되지 않음.',
    answers: ['관련 항목이 부족해서 제가 짧은 설문을 만들어 추가로 물어봤습니다.', '빈 부분을 채우려고 설문 문항을 만들어 의견을 더 받았습니다.', '자료에 없는 내용을 보완하기 위해 제가 설문을 작성해 추가 응답을 모았습니다.'],
    expected: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], response: ['answered'], questionScope: 'F를 선택하면 실제 새 진술의 설문 작성·수행 범위 한 가지만 열린 표현으로 확인한다.', forbiddenProbes: ['학생부에 없으므로 거짓이라고 판정', '미확인 설문 인원·성과·정확성을 발명', '새 경험을 공식 기록으로 덮어쓰기'], rationale: '직접 진술한 경험은 현재 요구에 답하며 필요시 확인할 수 있지만 미기록 자체가 모순·거짓 증거는 아니다.', allowsDiscretion: true },
    mdRefs: [basis.claimStatus, basis.sourceScope, basis.facts],
  }),
  scenario({
    id: 'DG-28', category: 'partial_refusal_scope', title: '한 부분을 답한 뒤 남은 요구만 답변 거절',
    question: '자료 A와 B의 조사 대상은 각각 누구였나요?', primaryFunction: 'FACT', depth: 'D1', sourceText: '자료 A와 B의 조사 대상을 살펴봄.',
    answers: ['A는 전국 학생입니다. B에 대해서는 답변하지 않겠습니다.', '자료 A는 전국의 학생을 다룹니다. 나머지 B는 말씀드리고 싶지 않습니다.', 'A의 대상은 전국 학생이었어요. B의 조사 대상은 답하지 않겠습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['partial'], response: ['unavailable'], questionScope: 'A에 관한 실제 응답은 보존하고 B 범위의 명시적 답변 거절을 수용한다.', forbiddenProbes: ['B를 반복 추궁', '전체가 무응답이라고 A 내용 폐기', '거절을 인성·장난·STT 오류로 판단'], rationale: '거절 범위는 현재 미답 부분으로 한정돼 있고 이미 제공한 답변은 유지된다.' },
    mdRefs: [basis.unknown, basis.noHiddenRequirement, basis.offTopic],
  }),
  scenario({
    id: 'DG-29', category: 'follow_up_budget', title: 'F2 이후 남은 공백은 F3로 추궁하지 않음',
    currentQuestionKind: 'follow_up',
    question: '그 판단에 사용한 실제 관찰 한 가지는 무엇인가요?', primaryFunction: 'EVIDENCE', depth: 'D2', sourceText: '자료를 비교하고 결과 해석을 논의함.',
    history: [{ kind: 'main', question: '자료를 어떤 방식으로 비교했나요?', answer: '두 표를 비교했습니다.' }, { kind: 'follow_up', question: '두 표에서 무엇을 비교했나요?', answer: '같은 항목을 봤습니다.' }],
    limits: { followUpsUsed: 2 },
    answers: ['표의 같은 항목에서 A는 10, B는 20이었습니다. 그래서 제 결론은 어떤 경우에도 틀릴 수 없다고 봅니다.', '같은 항목 값이 A에서 10이고 B에서 20인 것을 봤습니다. 제 결론은 모든 경우에 맞다고 생각합니다.', 'A의 10과 B의 20이라는 동일 항목의 값을 관찰했습니다. 그러니 언제나 제 결론이 옳다고 봅니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '관찰 요구 충족을 보존하며 추가 보편 주장은 확인 필요로만 남기고 묶음을 종료한다.', forbiddenProbes: ['새 보편 주장에 대한 F3 생성', '이름을 재진술·새 묶음으로 바꿔 같은 주장 추궁', '예산 소진을 이유로 현재 충족을 partial로 낮춤'], rationale: '현재 관찰은 답했고 새 주장에 확인 가치가 있어도 F2까지 사용했다면 평가용 추가 질문은 허용되지 않는다.' },
    mdRefs: [basis.budgets, basis.closing, basis.responseDriven],
  }),
  scenario({
    id: 'DG-30', category: 'rephrase_budget', title: '동일 취지 재안내 뒤 같은 전체 요구 재반복 제한',
    currentQuestionKind: 'clarification',
    question: '그 활동에서 본인이 직접 했던 일을 하나 말씀해 주세요.', primaryFunction: 'ROLE', depth: 'D1', sourceText: '팀 프로젝트에 참여함.',
    history: [{ kind: 'main', question: '팀 프로젝트에서 본인이 한 일은 무엇인가요?', answer: '그냥 팀원들과 같이 했습니다.' }],
    limits: { clarificationsUsed: 1 },
    answers: ['다 같이 했다는 것 외에는 더 말할 게 없습니다.', '같이 했고 더 구체적인 내용은 답하기 어렵습니다.', '함께 한 활동이고 제 일만 따로 말씀드리기는 어렵습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['partial'], response: ['unavailable'], questionScope: '추가 구체화를 답하기 어렵다는 범위를 수용하고 현재 묶음을 종료한다.', forbiddenProbes: ['동일 전체 역할 요구 두 번째 재진술', '같은 요구를 F1으로 이름만 변경', '학생에게 역할 예시를 알려 답변 유도'], rationale: '한 번 재안내한 동일 요구이고 학생은 현재 공백에 더 답하기 어렵다는 의사를 보였다.' },
    mdRefs: [basis.budgets, basis.unknown, basis.closing],
  }),
  scenario({
    id: 'DG-31', category: 'closing_phase', title: '마무리 단계에서 새 심층 질문을 열지 않음',
    currentQuestionKind: 'end', runtimeEligibility: 'prompt_rubric_only',
    question: '마지막으로 덧붙이고 싶은 내용이 있나요?', primaryFunction: 'VALUE', depth: 'D1', sourceText: '면접 마무리의 선택적 자유 발언. 특정 학생 활동의 사실 전제를 포함하지 않음.',
    limits: { phase: 'CLOSING', remainingMs: 3_000 },
    answers: ['오늘 설명한 경험을 바탕으로 더 배우고 싶습니다. 감사합니다.', '제 경험을 더 깊이 공부해 보고 싶습니다. 말씀은 여기까지입니다.', '앞으로도 계속 배우겠다는 말씀을 덧붙이고 싶습니다. 감사합니다.'],
    expected: { actions: ['CLOSING'], coverage: ['met'], response: ['answered'], questionScope: '종료 안내로 마무리하고 새 평가 질문은 작성하지 않는다.', forbiddenProbes: ['새 Q0나 심층 F 시작', '새 목표·가치관 근거 요구', '시간을 늘려 질문 개수 채우기'], rationale: '현재 단계와 실제 남은 시간을 지키며 선택적 마지막 발언 뒤 본론으로 돌아가지 않는다.' },
    mdRefs: [basis.closing, basis.budgets],
  }),
  scenario({
    id: 'DG-32', category: 'conditional_negative_answer', title: '조건부 연결 질문에서 연결되지 않았다는 답변',
    question: '독서와 설문 활동이 관심사로 이어졌다면 어떤 점에서 연결됐나요?', primaryFunction: 'CONNECTION', depth: 'D2', sourceText: '독서 활동과 설문 활동이 각각 기록됨. 두 활동 사이 인과·연결은 확인되지 않음.',
    answers: ['두 활동은 따로 했고 제 관심사로 이어지지는 않았습니다.', '저에게는 별개의 활동이라 직접 연결됐다고 생각하지 않습니다.', '독서와 설문은 서로 다른 이유로 한 일이어서 이어진 관심사는 없었습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '조건부 연결이 성립하지 않는다는 답변을 수용한다.', forbiddenProbes: ['연결이 반드시 있다고 전제', '연결 근거를 계속 재요구', '부정을 무관·불충분으로 바꾸기'], rationale: '열린 조건부 질문에 대해 연결 부재를 분명히 답했으며 없는 인과관계를 만들 수 없다.' },
    mdRefs: [basis.sourceScope, basis.sufficiency, basis.noHiddenRequirement],
  }),
];
