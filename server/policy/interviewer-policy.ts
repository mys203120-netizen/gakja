import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const INTERVIEWER_POLICY_VERSION = 'interviewer-policy-v2';
export const INTERVIEWER_POLICY_PATH = 'data/prepared/interviewer-policy.json';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceSpecs = [
  { role: 'glossary', path: '각자의답_MD/1. 프로젝트_용어집_v2.2.md', version: '2.2', title: '# 각자의답 프로젝트 공식 용어집 v2.2', sha256: 'eeef8c854b8eb24d60325d4c8cc1deaa1442ee95908fc3729a9726770e13a6dd' },
  { role: 'brand', path: '각자의답_MD/2. 브랜드_정체성_v1.2.md', version: '1.2', title: '# 각자의답 브랜드 정체성 v1.2', sha256: '30799c136ba56293f29030b89c1c584da449e5de5224b2bff84155445ea9684d' },
  { role: 'student', path: '각자의답_MD/5. 학생부_분석_기준_v2.2.md', version: '2.2', title: '# 각자의답 학생부 분석·데이터 계약 기준 v2.2', sha256: 'cf518370c24d72b7ebe00573d59de40d88341d370f130ca45c344389a4f24541' },
  { role: 'school', path: '각자의답_MD/6. 대학별_면접_기준_v1.3.md', version: '1.3', title: '# 각자의답 대학별 면접 특징 및 콘텐츠 적용 기준 v1.3', sha256: '996d95f71740a244452da6c6557d42e0164d75d4cfe6b1bcc28434e7c3532370' },
  { role: 'operating', path: '각자의답_MD/8. 면접엔진_공통운영원칙_v2.0.md', version: '2.0', title: '# 각자의답 면접 엔진 공통 운영 원칙 v2.0', sha256: '680d4665eac82bd2f8e9ba257e09dd62927ce1a439f08a2a9b08a3d83375cd53' },
  { role: 'question', path: '각자의답_MD/9. 면접엔진_질문생성_가이드라인_v2.3.md', version: '2.3', title: '# 각자의답 서류기반 모의면접 질문 생성 가이드라인 v2.3', sha256: '12f0095424dbcbe2de1052b5d2a953fc2387dac3ae8fbbb5d0b1ea4f28de9580' },
  { role: 'evaluation', path: '각자의답_MD/10. 면접엔진_답변평가_가이드라인_v2.3.md', version: '2.3', title: '# 각자의답 서류기반 모의면접 답변 분석·평가·코칭 가이드라인 v2.3', sha256: '5924fc1ddb27ae9723bfc3814765832315a73b887693e1fe67eacdeade13162a' },
  {"role": "guidebook", "path": "각자의답_MD/3. 웹가이드북_목차_콘텐츠배치_v3.0.md", "version": "3.0", "title": "# 각자의답 웹 가이드북 목차 및 학습 콘텐츠 배치 기준 v3.0", "sha256": "5e530c961e11eb7e6a350af3b590ec416636138a1f3ec1269a8c1b559e15ebe7"},
  {"role": "prd", "path": "각자의답_MD/4. 서비스_PRD_v3.0.md", "version": "3.0", "title": "# 각자의답 서비스 PRD 및 MVP v3.0", "sha256": "e56262e3962caceb5303140f2f10879b46019150ea77e933c0cea7febb8f013c"},
  {"role": "production", "path": "각자의답_MD/7. 웹가이드북_통합제작프로세스_v2.2.md", "version": "2.2", "title": "# 각자의답 웹 가이드북 통합 제작·검수·발행 프로세스 v2.2", "sha256": "e28d4f71fb1e62dda58f8ae0d624e631b496e0d774c6f6087f742ecdbf4e4c54"},
  {"role": "termsDraft", "path": "각자의답_MD/11. 요금제_결제및환불_약관_v0.2_검토초안.md", "version": "0.2", "title": "---", "sha256": "7dca58ac244c3bd9732989027a27f34776025fb0160b0a1b64c68da55dfbba94"},
  {"role": "studentUx", "path": "각자의답_MD/12. 학생용_IA및UX_정밀설계_v1.2.md", "version": "1.2", "title": "# 각자의답 학생용 통합 IA · 화면·버튼·UX 상세설계 v1.2", "sha256": "0c7ed031c26890dbe0d5edfc0e7780e8a3e375c379a55dee40fe1ba963587a44"},
] as const;
type SourceRole = typeof sourceSpecs[number]['role'];
interface RuleSpec { id: string; role: SourceRole; clause: string; needle: string; instruction: string; guards: string[]; regressions: string[] }
const rules: RuleSpec[] = [
  { id: 'TARGET_FIRST', role: 'question', clause: '제1·6조', needle: '검증 대상 선택', instruction: '현재 학생의 근거에서 확인할 한 대상을 먼저 정한 다음 질문 전략과 표현을 선택한다. 학생부 문장을 그대로 의문문으로 바꾸지 않는다.', guards: ['QuestionBlueprint', 'createStudentObjectiveCandidates'], regressions: ['question-objective.test.ts'] },
  { id: 'SOURCE_AUTHORITY', role: 'question', clause: '제3조', needle: 'AI_INFERENCE', instruction: '학생 사실은 허용된 원문·학생 확인·실제 확정 답변에서만 얻는다. 추론·책 사례·학교 인재상은 학생의 수행 사실이 아니다.', guards: ['source-range', 'source-role'], regressions: ['question-objective.test.ts', 'question-strategy-catalog.test.ts'] },
  { id: 'OPEN_UNKNOWN', role: 'question', clause: '제4조', needle: '존재 여부를 여는 질문', instruction: '기록에 없는 동기·갈등·역할·결과는 존재를 열어 확인한다. 공동 활동을 개인 행동·성공으로 승격하지 않는다.', guards: ['presupposition-prerequisites', 'QuestionIR'], regressions: ['question-realization.test.ts'] },
  { id: 'ONE_DEMAND', role: 'question', clause: '제5조', needle: '다중 과제형 질문', instruction: '발화 한 번에 핵심 인지 요구 하나만 요청한다. 비교 자체는 한 목적이며 STAR 전 요소를 한꺼번에 요구하지 않는다.', guards: ['single-demand', 'final-surface'], regressions: ['question-realization.test.ts', 'question-guards.test.ts'] },
  { id: 'OPEN_TARGET_FIXED_CODES', role: 'question', clause: '제7·9조', needle: '기능 분류는 다음과 같이 고정한다', instruction: '실제 확인 대상·주제는 책 밖으로 확장할 수 있다. 관리 분류는 기존15기능 중 하나이며 임의 기능 코드를 만들지 않는다. 확장에는 출발 근거와 연결 이유가 필요하다.', guards: ['primary-function', 'expansion-rationale'], regressions: ['question-objective.test.ts'] },
  { id: 'DEPTH_INDEPENDENT', role: 'question', clause: '제10조', needle: '질문 깊이는 개별 발화의 요구 수준', instruction: 'D1 사실·기초, D2 과정·이유, D3 적용·비교, D4 한계·반례·대안으로 실제 요구를 분류한다. 회차 난이도와 구별하고 새 전문 개념이나 압박 말투로 난도를 올리지 않는다.', guards: ['depth-operation-match'], regressions: ['question-realization.test.ts'] },
  { id: 'NATURAL_SURFACE', role: 'question', clause: '제11·12조', needle: '예시 템플릿을 그대로 반복해서는 안 되며', instruction: '근거 인용은 내부에 보존하되 발화마다 원문을 읽지 않는다. 짧은 맥락·직접 질문·정중한 종결을 문맥에 맞게 선택하며 의도와 요구를 바꾸지 않는다.', guards: ['surface-registry', 'utterance-history'], regressions: ['question-realization.test.ts'] },
  { id: 'FINAL_UTTERANCE', role: 'question', clause: '제12·23조', needle: '실제 출력 문장 기준', instruction: '승인 객체는 실제 최종 발화와 의도·요구·깊이·근거·검수 방식을 함께 고정한다. 인용 하나의 일치나 자기 검토를 독립 의미 검수 완료로 표시하지 않는다.', guards: ['ApprovedQuestionContract', 'assertQuestionContractIntegrity'], regressions: ['question-objective.test.ts'] },
  { id: 'FOLLOW_UP_BUDGET', role: 'question', clause: '제14조', needle: '후속 평가 질문은 묶음당 최대 두 개', instruction: 'F1/F2는 같은 묶음 목적에 종속되는 후속 검증이며 최대2회는 목표가 아닌 상한이다. 면접관 교대·재표현·새ID로 상한을 우회하지 않는다.', guards: ['cluster-subordination', 'follow-up-budget'], regressions: ['question-guards.test.ts', 'protocol.test.ts'] },
  { id: 'FULFILLMENT_ACTION_SPLIT', role: 'question', clause: '제15조', needle: '질문 의도에 충분히 답했으면', instruction: '관련성·요구 충족·다음 행동을 구별한다. 충분한 답이면 전환하거나 같은 묶음 목적에 필요한 다른 확인을 선택한다. 이미 답한 내용을 누락으로 만들지 않는다.', guards: ['core-decision', 'ConversationLedger'], regressions: ['realtime-core.test.ts', 'conversation-ledger.test.ts'] },
  { id: 'BOOK_REFERENCE_ONLY', role: 'question', clause: '부록A', needle: '질문 사례와 방법론', instruction: '책은 질문 전략과 표현의 참고다. 책의 예시답안·인명·활동·수치·대학 운영 정보를 현재 학생의 답변이나 정책으로 복사하지 않는다. 일치하는 책 문항은 생성의 필수 조건이 아니다.', guards: ['runtime-strategy-projection'], regressions: ['question-strategy-catalog.test.ts'] },
  { id: 'SOURCE_BOUND_TRAJECTORY', role: 'student', clause: '5.5', needle: '학년 간 변화', instruction: '학년별 관심·활동의 연결을 후보로 활용하되 실제 원문 근거와 가능성 상태를 유지한다. 같은 단어가 있다는 이유로 발전이나 인과를 확정하지 않는다.', guards: ['buildStudentTrajectory'], regressions: ['question-objective.test.ts'] },
  { id: 'NEW_EXPERIENCE_NOT_FALSE', role: 'evaluation', clause: '제7조', needle: '그 자체로 거짓말의 증거는 아니다', instruction: '기록 밖의 새 경험은 미검증 학생 진술이다. 실제 충돌하는 두 진술이 있어야 모순 확인 후보이며 정정을 먼저 고려한다.', guards: ['claim-status', 'correction-markers'], regressions: ['conversation-ledger.test.ts'] },
  { id: 'EVALUATION_SEPARATE', role: 'operating', clause: '제11조', needle: '질문 생성과 그에 대한 정식 답변 평가 기준은 분리한다', instruction: '실시간 해석은 진행 목적이며 점수·합격 판단이 아니다. 종료 평가에 실제 질문 계약과 답변을 넘기고 질문하지 않은 조건을 추가하지 않는다.', guards: ['evaluation-contract-integrity'], regressions: ['evaluation-turns.test.ts', 'question-objective.test.ts'] },
  { id: 'SEMANTIC_DUPLICATES', role: 'question', clause: '제24조', needle: '질문 텍스트만이 아니라 의도·근거·요구 의미', instruction: '중복은 표현뿐 아니라 확인 대상·의도·요구·출처를 함께 본다. 이미 해결한 요구를 단어만 바꿔 다시 묻지 않는다.', guards: ['ledger-target-key', 'asked-target-check'], regressions: ['conversation-ledger.test.ts', 'question-guards.test.ts'] },
  {"id": "PHASES", "role": "operating", "clause": "제5~8조", "needle": "도입 → 본론 → 마무리 → 종료", "instruction": "도입·본론·마무리·종료를실제상태로연결한다. 선택적인아이스브레이킹·자기소개를강제하지않고인사를첫회에만제공한다.", "guards": ["runtime-phase"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "DIALOGUE_REQUESTS", "role": "question", "clause": "제15~16조", "needle": "질문 이해 여부", "instruction": "실제답변과재청취·의미설명·정정·기억불확실성은동시에존재할수있다. 문자열분류하나로전체발화를무관으로만들지않는다.", "guards": ["naturalCoreWireSchema"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "CLARIFICATION_UNIT", "role": "operating", "clause": "제13조", "needle": "재진술은 동일 질문에 원칙적으로 1회", "instruction": "재진술은현재질문별원칙1회이며F평가수와구분한다. Q0재진술이F1재진술을차단하지않는다.", "guards": ["mayAskClarification"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "APPROVED_COMMON", "role": "question", "clause": "제7·22조", "needle": "COMMON_APPROVED", "instruction": "공통문항은승인모듈과지원처에연결하며가짜학생부원문ID를만들지않는다. 단순인사·자유마무리에독립점수를강제하지않는다.", "guards": ["commonApproval"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "ANSWER_BOUND_F", "role": "question", "clause": "제15조", "needle": "미리 써 둔 F1·F2", "instruction": "F는직전실제답변의주장·공백에서생성한다. 사전F트리를순서대로재생하지않는다.", "guards": ["approveNaturalQuestion"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "TECHNICAL_UNCERTAINTY", "role": "operating", "clause": "제21·30조", "needle": "심각한 STT 오류", "instruction": "인식오류를지식부족으로단정하지않는다. 실제침묵은마이크·스트림관찰과구분하며VAD0이나빈전사만으로확정하지않는다.", "guards": ["answerObservation"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "NO_LIVE_COACHING", "role": "operating", "clause": "제8조", "needle": "정답·답변 전략·점수", "instruction": "실전중정답·점수·교정힌트·전략코칭을제공하지않고면접종료후별도평가한다.", "guards": ["assertInterviewQuestionSpeech"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "SPEAKER_CONSISTENCY", "role": "operating", "clause": "제16~18조", "needle": "회차 안에서 일관성", "instruction": "면접관음성과역할은회차내일관되게하고기계적인교대나재인사를하지않는다. 교대해도묶음과F예산유지.", "guards": ["voiceSettings"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "FIRST_DELIVERY", "role": "operating", "clause": "제27조", "needle": "최초 평가 질문이 학생에게 정상 제시", "instruction": "생성·파일존재와실제정상전달을구분하며실제재생관찰만평가대상에포함한다.", "guards": ["questionPresentations"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "SAME_SESSION_RECOVERY", "role": "operating", "clause": "제27조", "needle": "10분 안에 재접속", "instruction": "10분내재접속은질문·답변·F·시간·진행단계가고정된동일회차로복구한다. 없는음성이나재생완료를만들지않는다.", "guards": ["SessionRuntimeState"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "PREPARATION_PRIORITY", "role": "student", "clause": "제7절", "needle": "숫자 총점", "instruction": "S/A/B/C/F는지원처별준비우선도이며서술근거를보존한다. 활동우수성점수나답변점수로자동환산하지않는다.", "guards": ["TargetStudentAnalysis"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "NO_RETROACTIVE_TARGET", "role": "evaluation", "clause": "제4·18조", "needle": "사후에 추가", "instruction": "F의새요구를Q0의필수요구로소급하지않으며당시실제질문과답변으로독립평가한다.", "guards": ["meaningCoverage"], "regressions": ["natural-interview-core.test.ts"]},
  {"id": "SOURCE_VIEW_BOUNDARY", "role": "production", "clause": "데이터재사용", "needle": "정본 데이터를 참조", "instruction": "가이드북은원문·분석·질문정본의뷰다. 예시답안문장일치를채점하지않고질문저장시원본ID를참조한다.", "guards": ["question-version"], "regressions": ["natural-interview-core.test.ts"]},
];
export interface InterviewerPolicyPack {
  version: typeof INTERVIEWER_POLICY_VERSION; contentSha256: string;
  sourceFiles: Array<{ role: string; path: string; version: string; sha256: string }>;
  rules: Array<{ id: string; requirement: 'required'; precedence: number; source: { role: string; path: string; version: string; sha256: string; clause: string; startLine: number; endLine: number; quote: string }; instruction: string; guards: string[]; regressions: string[] }>;
  userOverrides: Array<{ id: string; precedence: 1000; instruction: string }>;
}
export const userInterviewerOverrides = [
  { id: 'USER_NO_RECORD_ANNOUNCEMENT', precedence: 1000 as const, instruction: '학생부부터 질문하겠다는 예고·검수하겠다는 멘트를 발화하지 않는다. 인사는 세션 첫 질문에서만 짧게 하며 면접관이 바뀌어도 다시 하지 않는다.' },
  { id: 'USER_EXAMPLE_PARTITION', precedence: 1000 as const, instruction: '해당학생·지원처의공개가이드북예제와동일문장·동일확인목적을실전신규Q0에서제외한다. 같은활동의독립목적은허용하고연습의예제재사용은유지한다.' },
  { id: 'USER_CAMERA_OPTIONAL', precedence: 1000 as const, instruction: '카메라는선택사항이며미사용을내용점수감점으로바꾸지않는다. 영상관찰은미측정으로구분한다.' },
  { id: 'USER_TIME_BASED', precedence: 1000 as const, instruction: '주질문수는종료상한이아니다. 검증된후보·시간·진행단계를보고다음독립목적을선정하고실제마무리발화로종료한다.' },
  { id: 'USER_SINGLE_REALTIME_CORE', precedence: 1000 as const, instruction: '실시간 반응·맥락·질문을 별도 LLM 호출로 나누지 않는다. 사전 Q0 캐시·단일 코어·종료 후 평가를 유지한다.' },
] as const;

/** Explicit reviewed mapping, not LLM policy interpretation. Changed MD bytes require a mapping review. */
export async function compileInterviewerPolicy(root = process.cwd(), options: {
  inputs?: readonly { path: string; bytes: Buffer | null; readError?: unknown }[];
} = {}): Promise<InterviewerPolicyPack> {
  const loaded = await Promise.all(sourceSpecs.map(async spec => {
    // A context compiles from the exact MD bytes already pinned in its source
    // snapshot. Standalone preparation callers retain the original file read.
    const captured = options.inputs?.find(input => input.path === spec.path);
    const bytes = options.inputs ? captured?.bytes : await readFile(resolve(root, spec.path));
    if (!bytes) {
      if (captured?.readError !== undefined) throw captured.readError;
      throw new Error('INTERVIEWER_POLICY_SOURCE_CHANGED:' + spec.role);
    }
    const text = bytes.toString('utf8');
    if (sha(bytes) !== spec.sha256 || text.split(/\r?\n/u)[0] !== spec.title) throw new Error('INTERVIEWER_POLICY_SOURCE_CHANGED:' + spec.role);
    return { ...spec, text };
  }));
  const compiledRules = rules.map(rule => {
    const source = loaded.find(file => file.role === rule.role)!;
    const start = source.text.indexOf(rule.needle);
    if (start < 0) throw new Error('INTERVIEWER_POLICY_CLAUSE_MISSING:' + rule.id);
    const startLine = source.text.slice(0, start).split('\n').length;
    return { id: rule.id, requirement: 'required' as const, precedence: 100, source: { role: source.role, path: source.path, version: source.version, sha256: source.sha256, clause: rule.clause, startLine, endLine: startLine, quote: rule.needle }, instruction: rule.instruction, guards: rule.guards, regressions: rule.regressions };
  });
  const body: Omit<InterviewerPolicyPack, 'contentSha256'> = { version: INTERVIEWER_POLICY_VERSION, sourceFiles: loaded.map(({ role, path, version, sha256 }) => ({ role, path, version, sha256 })), rules: compiledRules, userOverrides: [...userInterviewerOverrides] };
  return { ...body, contentSha256: sha(JSON.stringify(body)) };
}

/** Only compact implementation instructions are inserted in prompts; book/student text stays data. */
export function compactInterviewerPolicyInstructions(pack?: InterviewerPolicyPack): string {
  return [...(pack?.userOverrides ?? userInterviewerOverrides).map(rule => rule.instruction), ...(pack?.rules ?? rules).map(rule => rule.instruction)].join('\n');
}
