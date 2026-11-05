import { dialogueActionGoldMdBasis as basis, type DialogueActionGoldCase, type DialogueGoldMdReference } from './dialogue-action-gold';

export const dialogueActionHistoricalGoldProvenance = {
  version: 'dialogue-action-historical-md-gold-v1',
  labelAuthor: 'Codex (MD-based)',
  provenance: 'MD기반 수동 기대행동 / 사람 검수 대기',
  humanReviewStatus: 'pending',
  humanReviewed: false,
  syntheticCurrentAnswers: true,
  historicalQuestionsAndPrefixUnchanged: true,
  modelOutputsUsedAsGold: false,
  expectedLabelsAreProviderInput: false,
  anchorArtifact: 'artifacts/core-checkpoint-legacy-fixed-20261104.json',
  anchorArtifactSha256: '01d3680639583720dc092d2e8e5d675b872b549269f01703bca80414edd49004',
  countingPolicy: '24 anchored base scenarios; 6 critical scenarios have 3 paraphrases and 18 have 1 answer: 36 planned decisions. Paraphrases are not independent interview samples.',
  limitations: [
    'Action and coverage labels are agent-authored MD interpretations, not independently human-adjudicated truth.',
    'Historical approval belongs only to the exact original question and prefix; never replace either with a synthetic question or rewritten history.',
    'Scientific propositions in synthetic answers test dialogue handling, not independent scientific truth or scoring accuracy.',
    'Allowed action sets retain legitimate interviewer discretion; new-question scope still needs separate review.',
    'Known historical regression families are development cases; fresh answers on the same historical questions do not prove domain-wide generalization.',
  ],
} as const;

export interface DialogueActionHistoricalGoldCase {
  id: string;
  title: string;
  category: string;
  sourceAnchor: { artifactPath: string; sourceRowIndex: number };
  /** Byte-exact assertion against the anchor, not a replacement question. */
  expectedQuestion: string;
  split: 'development' | 'holdout';
  criticalVariants: boolean;
  variants: Array<{ id: string; answer: string }>;
  expected: DialogueActionGoldCase['expected'];
  mdRefs: DialogueGoldMdReference[];
}
type HistoricalInput = Omit<DialogueActionHistoricalGoldCase, 'sourceAnchor' | 'variants' | 'expected'> & {
  row: number;
  answers: readonly string[];
  expected: Omit<DialogueActionGoldCase['expected'], 'allowsDiscretion' | 'scoring'> & { allowsDiscretion?: boolean };
};
const anchored = ({ row, answers, expected, ...rest }: HistoricalInput): DialogueActionHistoricalGoldCase => ({
  ...rest,
  sourceAnchor: { artifactPath: dialogueActionHistoricalGoldProvenance.anchorArtifact, sourceRowIndex: row },
  variants: answers.map((answer, index) => ({ id: `${rest.id}-v${index + 1}`, answer })),
  expected: { ...expected, allowsDiscretion: expected.allowsDiscretion ?? false, scoring: {
    currentAnswer: 'evaluate_only_current_spoken_demand', preserveCurrentCoverageWhenChoosingNext: true,
    nextByAction: expected.actions.map(action => ({ action, independentAnswerScore: action === 'FOLLOW_UP', consumesFollowUp: action === 'FOLLOW_UP', consumesMeaningRephrase: action === 'CLARIFICATION' })),
  } },
});

export const dialogueActionHistoricalGoldCases: DialogueActionHistoricalGoldCase[] = [
  anchored({
    id: 'DHG-01', row: 3, category: 'same_whole_role', title: '막연한 팀 응답에는 원래 전체 역할 요구 재안내', split: 'development', criticalVariants: true,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?',
    answers: ['팀원들과 함께 준비해서 두 활동을 진행했습니다.', '저희가 같이 준비했고 뉴스카드와 안내 활동을 함께 했습니다.', '특별히 제 일만 나누기보다는 친구들과 같이 활동했습니다.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['partial'], response: ['answered'], questionScope: '현재 질문이 이미 요구한 개인의 직접 행동 한 가지를 같은 의미로 재안내한다.', forbiddenProbes: ['전체 본인 행동 재요구를 새 F로 처리', '역할·성공·갈등 발명', '행동이 특정되지 않았는데 새 선택 기준·성과부터 요구'], rationale: '팀 참여만 진술했으므로 원래 개인 행동 요구가 남아 있으며 같은 전체 요구의 반복은 새 평가 하위 과제가 아니다.' },
    mdRefs: [basis.sameDemand, basis.clarifyVsProbe, basis.rephrase],
  }),
  anchored({
    id: 'DHG-02', row: 9, category: 'listed_activity_single_action', title: '활동 목록에서 한 가지 직접 행동 충족', split: 'development', criticalVariants: true,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?',
    answers: ['뉴스카드에서 작은 글씨를 키우고 어려운 안내 문구를 쉬운 말로 고쳤습니다.', '제가 직접 한 일은 카드 글자 크기를 조정하고 신청 안내 문장을 쉽게 바꾼 것입니다.', '카드의 작은 글자를 크게 만들었고 안내 표현도 직접 다듬었습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '현재 요청한 직접 행동 한 가지의 충족을 보존한다.', forbiddenProbes: ['양로원 활동 미언급을 필수 공백으로 추가', '같은 뉴스카드 행동 재요구', '동기·성과·기준을 사후 필수화'], rationale: '실제 질문은 각 활동 모두를 요구하지 않았으며 현재 단일 행동 요구에 구체적으로 답했다.' },
    mdRefs: [basis.noHiddenRequirement, basis.sufficiency, basis.noRetroactiveScoring],
  }),
  anchored({
    id: 'DHG-03', row: 4, category: 'or_activity_single_action', title: 'OR 질문의 행동 설명 뒤 불완전한 부가 발화', split: 'development', criticalVariants: true,
    expectedQuestion: '뉴스카드를 만들거나 양로원에서 안내할 때, 본인이 직접 맡은 일은 무엇이었나요?',
    answers: ['뉴스카드의 작은 글자를 크게 고친 것이 제가 맡은 일입니다. 양로원에서는 그때 안내를', '카드의 신청 안내 문장을 쉽게 바꿨습니다. 양로원 이야기는 당시 안내가', '저는 카드 글자 크기와 안내 표현을 수정했습니다. 현장에서는 어르신들께'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '이미 설명한 카드 행동은 유지하고 불완전한 다른 활동 설명을 필수 미답으로 확대하지 않는다.', forbiddenProbes: ['끝이 끊긴 부가 설명 때문에 앞의 충족을 취소', 'OR를 양쪽 모두의 의무로 변경', '인식 파편을 완성해 구체적 현장 역할을 발명'], rationale: '선택적 활동 범위의 직접 행동은 이미 명확하며 추가 문장의 불완전성이 그 답변을 무효화하지 않는다.' },
    mdRefs: [basis.noHiddenRequirement, basis.sufficiency, basis.meaningNotWording],
  }),
  anchored({
    id: 'DHG-04', row: 6, category: 'comparison_missing_subpoint', title: '약전해질만 설명한 비교의 아직 미답인 강전해질', split: 'development', criticalVariants: true,
    expectedQuestion: '온도 상승에 따른 약전해질의 전도도 변화를 강전해질과 비교해 설명해 주세요.',
    answers: ['약전해질은 온도가 오르면 해리도와 이온 이동도가 변해서 전도도가 커진다고 이해했습니다.', '제가 이해한 약전해질은 온도가 높아질 때 이온이 늘고 이동도도 커져 전도도가 증가하는 경우입니다.', '약전해질 쪽은 온도가 상승하면서 해리와 이온 이동이 달라져 전도도가 높아진다고 배웠습니다.'],
    expected: { actions: ['FOLLOW_UP'], coverage: ['partial'], response: ['answered'], questionScope: '현재 비교 요구의 미답 부분인 강전해질의 온도 변화 설명만 확인한다.', forbiddenProbes: ['약전해질 설명 전체 재요구', '강전해질 정답·힌트 제공', '온도 외 새 조건·수치 추가'], rationale: '현재 질문의 비교에 필요한 두 범위 중 한쪽은 답했고 다른 쪽만 남았다. 과학적 정오 자체를 이 gold가 승인하지는 않는다.' },
    mdRefs: [basis.responseDriven, basis.noHiddenRequirement, basis.noRetroactiveScoring],
  }),
  anchored({
    id: 'DHG-05', row: 7, category: 'complete_answer_with_term_correction', title: '현재 강전해질 답변과 이전 용어 정정을 함께 보존', split: 'development', criticalVariants: true,
    expectedQuestion: '강전해질은 온도가 올라갈 때 전도도가 어떻게 변하나요?',
    answers: ['강전해질은 이미 거의 해리되어 있어서 온도 상승 때 이온 수보다 이동도 변화로 전도도가 대체로 증가한다고 이해합니다. 앞서 약전해질질이라고 한 단어는 약전해질로 고치겠습니다.', '강전해질에서는 온도가 오르면 이온 이동도가 커져 전도도가 대체로 높아진다고 설명할 수 있습니다. 이전 말의 약전해질질은 약전해질이라는 뜻입니다.', '제가 이해한 범위에서 강전해질은 이온 수 변화는 작고 이동도가 커져 전도도가 대체로 증가합니다. 앞선 약전해질질이라는 표기만 약전해질로 바로잡겠습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '현재 강전해질 변화 설명과 이전의 제한된 용어 정정을 함께 보존한다.', forbiddenProbes: ['한 단어 정정을 이전 원리 설명 전체의 철회로 해석', '이미 말한 강전해질 변화 재요구', '정정 자체를 모순·거짓으로 단정'], rationale: '현재 발화의 요구는 설명됐고 표기 정정이 다른 의미를 취소하지 않는다. 정오는 별도 승인 학술 근거가 필요한 문제다.' },
    mdRefs: [basis.facts, basis.meaningNotWording, basis.sufficiency],
  }),
  anchored({
    id: 'DHG-06', row: 10, category: 'same_question_replay', title: '질문을 그대로 다시 듣는 명확한 요청', split: 'development', criticalVariants: true,
    expectedQuestion: '버추얼 시티의 에너지 순환과 암모니아 운송 탐구가 본인에게 연결된 관심사였다면, 어떤 점에서 이어졌나요?',
    answers: ['죄송하지만 같은 질문을 한 번만 더 말씀해 주시겠어요?', '방금 질문을 다시 듣고 싶습니다.', '질문을 놓쳤습니다. 원래 질문을 한 번 더 말해 주세요.'],
    expected: { actions: ['REPLAY'], coverage: ['unknown'], response: ['answered'], questionScope: '현재 승인 질문의 음성을 그대로 다시 제공하고 새 문장을 생성하지 않는다.', forbiddenProbes: ['의미 풀이로 바꾸기', 'F·의미 재진술 횟수 소비', '명확한 요청을 무관·발화 불명으로 판정'], rationale: '말을 다시 듣는 요청은 의미 풀이 요청과 다르며 평가 내용 답변은 아직 없다.' },
    mdRefs: [basis.sameDemand, basis.rephrase, basis.noRetroactiveScoring],
  }),
  anchored({
    id: 'DHG-07', row: 11, category: 'meaning_request', title: '연결된 관심사라는 말의 뜻 확인', split: 'holdout', criticalVariants: false,
    expectedQuestion: '버추얼 시티의 에너지 순환과 암모니아 운송 탐구가 본인에게 연결된 관심사였다면, 어떤 점에서 이어졌나요?',
    answers: ['연결된 관심사라는 말이 무슨 뜻인지 쉬운 말로 설명해 주세요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['unknown'], response: ['answered'], questionScope: '두 탐구가 관심사로 이어졌다면 그 연결을 설명하라는 조건부 요구를 쉬운 말로 풀어 준다.', forbiddenProbes: ['연결이 실제 존재한다고 단정', '정답·연결 사례를 힌트로 제시', '어려운 원문 재생만으로 의미 풀이를 대체'], rationale: '현재 요청은 재청취가 아니라 뜻풀이이며 새 평가 과제나 허위 연결을 추가하면 안 된다.' },
    mdRefs: [basis.rephrase, basis.sourceScope, basis.sameDemand],
  }),
  anchored({
    id: 'DHG-08', row: 1, category: 'first_unrelated', title: '지원 계기와 무관한 첫 일상 발화', split: 'holdout', criticalVariants: false,
    expectedQuestion: '융합응용화학과를 지원 전공으로 선택하게 된 개인적인 계기가 있나요?', answers: ['오늘 점심에는 국수를 먹었습니다.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['unknown'], response: ['unrelated'], questionScope: '지원 전공 선택의 개인적 계기를 같은 취지로 한 번 재안내한다.', forbiddenProbes: ['점심 메뉴의 근거·이유를 F로 확인', '무관 응답을 장난·인격 문제로 단정', '다른 평가 주제로 변경'], rationale: '첫 명백한 무관 응답이며 기존 질문의 취지를 정중히 확인하는 경로가 맞다.' },
    mdRefs: [basis.offTopic, basis.rephrase],
  }),
  anchored({
    id: 'DHG-09', row: 2, category: 'repeated_unrelated', title: '이전 취지 재안내 뒤 반복 무관 발화', split: 'holdout', criticalVariants: false,
    expectedQuestion: '융합응용화학과에 지원하기로 마음먹게 된 개인적인 계기가 있었나요?', answers: ['여전히 달나라 고양이의 라면 가게 이야기만 하고 싶습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['unknown'], response: ['unrelated'], questionScope: '이전 묶음을 닫고 필요한 짧은 전환만 제공한다.', forbiddenProbes: ['동일 취지 두 번째 재안내', '무관 이야기 후속 질문', '훈계·조롱·인격 판단'], rationale: '보존한 prefix에 첫 무관 응답과 취지 재안내가 이미 있으며 allowClarification도 false다.' },
    mdRefs: [basis.offTopic, basis.budgets, basis.closing],
  }),
  anchored({
    id: 'DHG-10', row: 8, category: 'motive_sufficient', title: '개인적 관심 형성 계기 설명', split: 'holdout', criticalVariants: false,
    expectedQuestion: '융합응용화학과를 지원 전공으로 선택하게 된 개인적인 계기가 있나요?', answers: ['생활용품의 성분이 작동에 어떤 영향을 주는지 찾아보면서 화학을 배워 실생활 문제를 해결하고 싶어졌습니다. 그래서 이 전공을 선택했습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '개인적 관심과 전공 선택의 연결을 현재 요구 충족으로 보존한다.', forbiddenProbes: ['지원 계기 전체 재요구', '성과·전공 지식 시험을 원래 필수로 소급', '분량만으로 부분 답변 처리'], rationale: '현재 질문의 개인적 계기가 구체적인 관심 경험과 함께 설명됐으며 새로운 검증 주장이 없다.' },
    mdRefs: [basis.sufficiency, basis.noHiddenRequirement, basis.budgets],
  }),
  anchored({
    id: 'DHG-11', row: 13, category: 'answer_after_silence', title: '이전 침묵 뒤 실제 계기를 답하면 새 답변을 평가', split: 'holdout', criticalVariants: false,
    expectedQuestion: '융합응용화학과를 지원 전공으로 선택하게 된 개인적인 계기가 있나요?', answers: ['성분이 다른 세제가 왜 다르게 작동하는지 찾아본 경험 때문에 화학을 실제 제품과 연결해 배우고 싶었습니다. 그 관심으로 지원했습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '현재 실제로 말한 개인적 계기를 보존하고 이전 무음이 현재 충족을 취소하지 않게 한다.', forbiddenProbes: ['이전 침묵 때문에 현재도 무응답 처리', '지원 계기 전체 재요구', '표현을 외운 답변처럼 단정'], rationale: '현재 답변은 새로 제공됐으며 이전 실제 침묵과 독립적으로 그 의미를 해석한다.' },
    mdRefs: [basis.sufficiency, basis.meaningNotWording, basis.noRetroactiveScoring],
  }),
  anchored({
    id: 'DHG-12', row: 0, category: 'partial_memory_unavailable', title: '비교 대상은 말하고 남은 근거 기억 불가', split: 'development', criticalVariants: false,
    expectedQuestion: 'CNT 삽입에 따른 정전용량 62% 향상은 어떤 비교 근거에서 나온 수치인가요?', answers: ['CNT를 넣기 전과 넣은 뒤의 전극을 비교한 수치입니다. 다만 당시 측정 조건과 원자료는 기억나지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['partial'], response: ['unavailable'], questionScope: '비교 대상 설명은 보존하며 현재 기억 불가인 조건·원자료를 재요구하지 않는다.', forbiddenProbes: ['조건·원자료 반복 추궁', '앞의 비교 대상까지 폐기', '기억 불가를 거짓·장난·기술 장애로 판단'], rationale: '답한 부분과 현재 미답의 기억 불가 범위를 함께 유지해야 한다.' },
    mdRefs: [basis.unknown, basis.responseDriven, basis.facts],
  }),
  anchored({
    id: 'DHG-13', row: 5, category: 'whole_memory_unavailable', title: '현재 비교 근거 전체를 기억하지 못함', split: 'holdout', criticalVariants: false,
    expectedQuestion: 'CNT 삽입에 따른 정전용량 62% 향상은 어떤 비교 근거에서 나온 수치인가요?', answers: ['그 수치가 어떤 비교에서 나왔는지는 전혀 기억나지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['unknown'], response: ['unavailable'], questionScope: '현재 비교 근거를 기억하지 못한다는 응답을 수용한다.', forbiddenProbes: ['같은 비교 근거 재추궁', '힌트로 비교 대상을 제공', '기억 불가를 무관·장난으로 변경'], rationale: '현재 요구에 유효한 비교 내용은 아직 없고 답변 불가 범위가 분명하다.' },
    mdRefs: [basis.unknown, basis.offTopic],
  }),
  anchored({
    id: 'DHG-14', row: 0, category: 'comparison_basis_sufficient', title: '현재 요청한 수치의 비교 근거 설명', split: 'holdout', criticalVariants: false,
    expectedQuestion: 'CNT 삽입에 따른 정전용량 62% 향상은 어떤 비교 근거에서 나온 수치인가요?', answers: ['제가 본 자료에서 CNT를 넣지 않은 전극과 넣은 전극의 정전용량을 같은 측정 기준으로 비교해, 차이를 CNT 없는 전극 값으로 나눈 비율이 62%였습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '비교 대상·기준·비율의 의미 설명을 현재 요구 충족으로 해석한다.', forbiddenProbes: ['현재 요구에 없던 모든 원자료 수치를 필수화', '답변을 외부 과학적 사실로 확정', '같은 비교 대상 재요구'], rationale: '현재 요청한 비교 근거에 실질적인 설명을 제공했다. 정확성에 대한 독립 학술 검증은 이 gold의 범위가 아니다.' },
    mdRefs: [basis.sufficiency, basis.noHiddenRequirement, basis.claimStatus],
  }),
  anchored({
    id: 'DHG-15', row: 6, category: 'split_comparison_complete', title: '두 전해질을 나눠 설명한 비교 충족', split: 'holdout', criticalVariants: false,
    expectedQuestion: '온도 상승에 따른 약전해질의 전도도 변화를 강전해질과 비교해 설명해 주세요.', answers: ['제가 이해한 약전해질은 온도가 오르면 해리도 변화로 이온 수와 이동도가 함께 영향을 받습니다. 강전해질은 이미 거의 해리되어 있어 이온 수 변화는 작고 이동도 영향이 주로 나타나 전도도가 대체로 커진다고 봅니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '두 쪽의 의미상 대조를 비교 요구 충족으로 보존한다.', forbiddenProbes: ['차이라는 연결어가 없다고 다시 비교 요구', '이미 설명한 강전해질 내용을 재요구', '과학적 정답·진실성을 무근거 확정'], rationale: '양쪽의 차이를 실제로 설명했다. 정확성 검증과 의미상 요구 충족은 별도다.' },
    mdRefs: [basis.meaningNotWording, basis.sufficiency, basis.noRetroactiveScoring],
  }),
  anchored({
    id: 'DHG-16', row: 7, category: 'correction_without_current_answer', title: '이전 표기 정정만으로 새 현재 요구를 충족하지 않음', split: 'holdout', criticalVariants: false,
    expectedQuestion: '강전해질은 온도가 올라갈 때 전도도가 어떻게 변하나요?', answers: ['앞에서 약전해질질이라고 한 단어는 약전해질이라는 뜻으로 바로잡겠습니다.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['unknown'], response: ['answered'], questionScope: '정정은 보존하되 아직 답하지 않은 현재 강전해질 변화 요구를 같은 의미로 재안내한다.', forbiddenProbes: ['이전 약전해질 설명이 현재 강전해질 답변을 대신했다고 처리', '현재 전체 강전해질 요구 재진술을 새 F로 산정', '정정을 전체 원리 설명 철회로 확대'], rationale: '정정 대상은 이전 용어이며 현재 질문의 강전해질 변화 설명은 아직 없다.' },
    mdRefs: [basis.sameDemand, basis.rephrase, basis.facts],
  }),
  anchored({
    id: 'DHG-17', row: 10, category: 'conditional_connection_absent', title: '조건부 연결이 성립하지 않는다는 설명', split: 'holdout', criticalVariants: false,
    expectedQuestion: '버추얼 시티의 에너지 순환과 암모니아 운송 탐구가 본인에게 연결된 관심사였다면, 어떤 점에서 이어졌나요?', answers: ['두 탐구는 따로 진행했고 제 관심사에서는 서로 이어지지 않았습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '조건부 연결이 없었다는 응답을 수용한다.', forbiddenProbes: ['공통 관심사가 반드시 있었다고 단정', '연결 근거 재추궁', '부정을 무관 응답으로 판단'], rationale: '실제 질문의 조건을 보존하면 연결 부재도 유효한 답이다.' },
    mdRefs: [basis.sourceScope, basis.sufficiency, basis.noHiddenRequirement],
  }),
  anchored({
    id: 'DHG-18', row: 9, category: 'role_unavailable', title: '현재 본인 행동을 기억하지 못함', split: 'holdout', criticalVariants: false,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?', answers: ['제가 직접 어떤 일을 했는지는 지금 기억이 나지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['unknown'], response: ['unavailable'], questionScope: '현재 개인 행동의 기억 불가를 수용한다.', forbiddenProbes: ['동일 본인 역할 반복 추궁', '대표 역할 예시로 답변 유도', '기억 불가를 팀 성과로 채워 met 처리'], rationale: '본인 행동에 관한 현재 요구를 답할 수 없다고 명확히 밝혔다.' },
    mdRefs: [basis.unknown, basis.offTopic],
  }),
  anchored({
    id: 'DHG-19', row: 9, category: 'role_presence_negative', title: '있다면 질문에 개인 직접 수행이 없었다고 답함', split: 'holdout', criticalVariants: false,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?', answers: ['카드 제작과 안내는 친구들이 맡았고 저는 옆에서 참여만 했습니다. 제가 직접 맡아 수행한 일은 없었습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '개인 직접 수행의 존재를 부정한 답변을 수용하고 역할을 발명하지 않는다.', forbiddenProbes: ['개인 행동이 반드시 있었다고 재요구', '없었다는 답을 기억 불가나 장난으로 변경', '팀 행동을 개인 역할로 승격'], rationale: '질문이 열어 둔 존재 조건에 명확히 부정 답변을 했으며 개인 역할을 꾸밀 수 없다.' },
    mdRefs: [basis.sourceScope, basis.sufficiency, basis.facts],
  }),
  anchored({
    id: 'DHG-20', row: 9, category: 'other_task_memory', title: '현재 행동은 답하고 다른 측정만 기억 불가', split: 'holdout', criticalVariants: false,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?', answers: ['저는 카드의 글자 크기를 키우고 안내 문장을 고쳤습니다. 이전 전극 탐구의 측정 조건은 지금 기억나지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '현재 카드 행동 설명을 보존하고 다른 과제의 기억 불가를 분리한다.', forbiddenProbes: ['다른 전극 탐구 기억 불가로 현재 역할 취소', '전극 조건 확인으로 현재 주제 확대', '현재 행동을 다시 요구'], rationale: '현재 질문에 구체적으로 답했으며 기억 불가의 범위는 다른 과제다.' },
    mdRefs: [basis.sufficiency, basis.noHiddenRequirement, basis.facts],
  }),
  anchored({
    id: 'DHG-21', row: 9, category: 'met_with_new_universal_claim', title: '현재 행동 뒤 새 보편 주장 확인 재량', split: 'holdout', criticalVariants: false,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?', answers: ['카드의 문구를 쉬운 말로 고쳤습니다. 그래서 누구나 읽자마자 전부 이해할 수 있게 됐다고 생각합니다.'],
    expected: { actions: ['FOLLOW_UP', 'TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: 'F라면 누구나 전부 이해한다는 실제 새 주장에 대한 확인 근거·범위 한 가지만 묻는다.', forbiddenProbes: ['본인 행동 설명을 partial로 낮춤', '동일 역할 전체 재요구', '학생이 모든 대상자의 이해도를 측정했다고 가정'], rationale: '역할은 충족했고 추가 보편 주장에 확인 가치가 있으나 F 횟수는 의무가 아니다.', allowsDiscretion: true },
    mdRefs: [basis.responseDriven, basis.budgets, basis.sourceScope],
  }),
  anchored({
    id: 'DHG-22', row: 9, category: 'new_criterion_after_role', title: '행동에서 선택 기준으로 확장하면 새 평가 요구', split: 'holdout', criticalVariants: false,
    expectedQuestion: '에너지 바우처 뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?', answers: ['제가 안내 문장의 표현을 고르고 중요하다고 본 순서로 배치했습니다.'],
    expected: { actions: ['FOLLOW_UP', 'TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: 'F라면 실제로 언급한 표현 선택·중요도 순서 중 한 기준을 새 하위 요구로 묻는다. 이는 CLARIFICATION이 아니다.', forbiddenProbes: ['기준 설명이 원래 역할 질문의 필수였다고 소급', '새 기준 요구를 같은 뜻 재진술로 산정', '선택한 실제 행동 전체 재요구'], rationale: '현재 본인 행동 요구는 충족했으며 기준은 추가 확인할 수 있는 다른 종속 평가 의미다.', allowsDiscretion: true },
    mdRefs: [basis.clarifyVsProbe, basis.sameDemand, basis.noRetroactiveScoring],
  }),
  anchored({
    id: 'DHG-23', row: 8, category: 'motive_with_unrelated_memory_gap', title: '계기를 답하고 별도 활동의 수치만 모른다고 함', split: 'holdout', criticalVariants: false,
    expectedQuestion: '융합응용화학과를 지원 전공으로 선택하게 된 개인적인 계기가 있나요?', answers: ['에너지 문제를 화학으로 해결하는 사례를 읽고 관심이 생겨 지원했습니다. 별도로 했던 안내 활동의 참여 인원은 기억나지 않습니다.'],
    expected: { actions: ['TRANSITION'], coverage: ['met'], response: ['answered'], questionScope: '현재 전공 선택 계기를 충족으로 보존한다.', forbiddenProbes: ['다른 활동의 수치 기억 불가를 지원 계기 전체 포기로 해석', '참여 인원 확인을 새 필수 과제로 추가', '지원 계기 반복 재요구'], rationale: '현재 질문에 답한 의미와 별도 기억 공백의 범위를 구분해야 한다.' },
    mdRefs: [basis.sufficiency, basis.noHiddenRequirement, basis.meaningNotWording],
  }),
  anchored({
    id: 'DHG-24', row: 11, category: 'partial_content_plus_meaning_request', title: '부분 내용과 뜻 확인 요청을 함께 보존', split: 'holdout', criticalVariants: false,
    expectedQuestion: '버추얼 시티의 에너지 순환과 암모니아 운송 탐구가 본인에게 연결된 관심사였다면, 어떤 점에서 이어졌나요?', answers: ['두 탐구에서 에너지에 관심이 있었던 건 맞습니다. 다만 어떻게 이어졌냐는 질문의 뜻을 잘 모르겠어서 쉬운 말로 설명해 주세요.'],
    expected: { actions: ['CLARIFICATION'], coverage: ['partial'], response: ['answered'], questionScope: '이미 제공한 에너지 관심은 유지하며 조건부 연결 설명 요구를 쉽게 풀어 준다.', forbiddenProbes: ['이전 관심 언급 전체 폐기', '연결의 구체적 인과를 먼저 만들어 제공', '새 평가 기준이나 힌트 추가'], rationale: '일부 내용이 있으나 연결 설명은 아직 없고 학생은 뜻풀이를 명시적으로 요청했다.' },
    mdRefs: [basis.rephrase, basis.meaningNotWording, basis.sourceScope],
  }),
];
