import { createDisconnectedModel, type W0Model, type W0Target } from './view-model';

/** Import dynamically from the development-only server route, never a client module. */
export const fixtureScenarios = [
  'ready',
  'empty',
  'loading',
  'pending',
  'error',
  'forbidden',
  'review_required',
  'long-target',
  'one-target',
] as const;

export type FixtureScenario = typeof fixtureScenarios[number];

function exampleTargets(): W0Target[] {
  return [
    {
      id: 'example-target-a',
      university: '예시대학교',
      department: '융합과학과',
      admission: '학생부종합전형 · 예시',
      interviewDate: null,
    },
    {
      id: 'example-target-b',
      university: '가상대학교',
      department: '환경공학과',
      admission: '학생부종합전형 · 예시',
      interviewDate: '2026-11-21',
    },
  ];
}

function readyExample(): W0Model {
  return {
    isExample: true,
    status: 'ready',
    targets: exampleTargets(),
    contentTargetId: 'example-target-a',
    practiceUntil: '2026-11-20',
    tickets: 3,
    strategy: '탐구에서 맡은 역할과 선택한 이유를 연결해 나만의 답변을 정리해 보세요.',
    activities: ['예시 탐구 활동 · 실험 조건 비교', '예시 협업 활동 · 역할과 의사소통'],
    questionPreview: {
      source: '합성 학생부 원문\n\n예시 탐구 활동에서 실험 조건을 비교하는 과정을 기록함. 모둠 안에서 측정 조건을 정리하고, 팀원들과 관찰 내용을 비교하며 결과를 설명하는 방법을 논의함.\n\n이 자료는 화면 검증을 위해 만든 예시이며 실제 학생의 기록이 아닙니다.',
      question: '탐구 활동에서 실험 조건을 비교할 때 어떤 역할을 맡았나요?',
      initialAnswer: '저는 측정 조건을 정리하고 팀원들의 관찰 내용을 모아 비교하는 역할을 맡았습니다. 서로 다르게 기록한 부분은 함께 다시 확인하고, 결과를 어떤 순서로 설명할지 논의했습니다.',
    },
    sessions: [
      {
        id: 'example-practice-1',
        targetId: 'example-target-a',
        title: '탐구 활동 답변 연습 · 예시',
        date: '2026-11-05',
        kind: 'practice',
        evaluation: 'ready',
        // Practice feedback has no numeric score.
        score: null,
      },
      {
        id: 'example-mock-1',
        targetId: 'example-target-a',
        title: '실전 모의면접 1회차 · 예시',
        date: '2026-11-04',
        kind: 'mock',
        evaluation: 'review_required',
        score: null,
      },
    ],
  };
}

/**
 * Explicit fixtures only: an unknown scenario or non-development environment
 * cannot produce a successful example. Production must also reject the route.
 */
export function createDevelopmentFixture(
  scenario: string,
  environment: string,
): W0Model | null {
  if (environment !== 'development' && environment !== 'test') return null;
  if (!fixtureScenarios.some((candidate) => candidate === scenario)) return null;

  if (scenario === 'ready') return readyExample();
  if (scenario === 'one-target') {
    const model = readyExample();
    model.targets = model.targets.slice(0, 1);
    return model;
  }
  if (scenario === 'long-target') {
    const model = readyExample();
    model.targets[0] = {
      ...model.targets[0],
      university: '예시미래융합과학기술대학교 국제캠퍼스',
      department: '지속가능에너지환경소재공학부 융합응용화학전공',
      admission: '학생부종합 미래융합인재 특별전형 · 예시',
    };
    return model;
  }

  const model = { ...createDisconnectedModel(), isExample: true };
  switch (scenario) {
    case 'empty':
    case 'loading':
    case 'error':
    case 'forbidden':
      model.status = scenario;
      return model;
    case 'pending':
      model.status = 'pending';
      model.targets = exampleTargets().slice(0, 1);
      model.contentTargetId = 'example-target-a';
      return model;
    case 'review_required': {
      const review = readyExample();
      review.status = 'review_required';
      review.sessions = review.sessions.filter((session) => session.evaluation === 'review_required');
      return review;
    }
    default:
      return null;
  }
}
