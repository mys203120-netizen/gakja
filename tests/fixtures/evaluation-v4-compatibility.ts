/** Deterministic public synthetic input for the frozen a666f7a v4 serializer.
 * All question/scope approvals below are explicit TEST fixtures, never service approvals. */
import type { InterviewContext } from '../../server/data/load-interview-context';
import type { InterviewSession, RecordedTurn } from '../../server/protocol';
import { reviewedRecordEvaluationFixture } from './reviewed-evaluation-knowledge';

export const V4_COMPATIBILITY_MODEL = 'explicit-synthetic-v4-model';
export function evaluationV4CompatibilityFixture() {
  const recordText = '동아리에서 자료를 비교하고 표로 정리함.';
  const context = {
    target: { university: '합성 대학', department: '합성 학과', academicYear: 2027, admissionTrack: '합성 서류 전형' },
    school: { schoolReferenceId: 'v4-synthetic-school', officialInterviewCriteria: { elements: [{ name: '학업역량' }] } },
    evaluationGuidelines: '합성 v4 평가 지침: 실제 질문의 요구와 확정 답변의 일관성만 검토한다.',
    student: { evidence: [{ id: 'v4-record-1', activityId: 'v4-activity-1', page: 1, text: recordText,
      scientificTruthVerification: 'not_independently_verified', sourceRef: { pdfSha256: 'a'.repeat(64), page: 1, startOffset: 0, endOffset: recordText.length } }] },
  } as unknown as InterviewContext;
  const q0 = { id: 'v4-q0', questionKind: 'main', parentMainQuestionId: 'v4-q0',
    questionText: '자료를 정리했던 활동에서 본인이 맡은 일은 무엇인가요?', evidenceIds: ['v4-record-1'],
    answerId: 'v4-answer-q0', rawTranscript: '저는 자료를 분류하고 비교표를 작성했습니다.', transcriptStatus: 'finalized',
    metadata: { primaryFunction: 'ROLE', questionIntent: '실제 활동에서 본인이 수행한 일을 확인한다.', targetEvidence: ['본인이 직접 수행한 일'], depth: 'D1', activityIds: ['v4-activity-1'] },
    metrics: { speech: { durationMs: 6000, speakingMs: 4000, firstSpeechMs: 250 } },
  } as RecordedTurn;
  const clarification = { id: 'v4-c1', questionKind: 'clarification', parentMainQuestionId: q0.id,
    questionText: '그 활동에서 직접 수행한 일 한 가지를 말씀해 주세요.', evidenceIds: ['v4-record-1'],
    answerId: 'v4-answer-c1', rawTranscript: '비교표에서 항목을 정해 자료를 분류했습니다.', transcriptStatus: 'finalized',
    metadata: { primaryFunction: 'ROLE', questionIntent: q0.metadata.questionIntent, targetEvidence: [...q0.metadata.targetEvidence], depth: 'D1',
      activityIds: ['v4-activity-1'], nonEvaluative: true, clarificationOfTurnId: q0.id },
    metrics: { speech: { durationMs: 5000, speakingMs: 3500, firstSpeechMs: 200 } },
  } as RecordedTurn;
  const f1 = { id: 'v4-f1', questionKind: 'follow_up', parentMainQuestionId: q0.id,
    questionText: '분류할 자료의 항목을 어떤 기준으로 정했나요?', evidenceIds: ['v4-record-1'],
    answerId: 'v4-answer-f1', rawTranscript: '서로 비교할 수 있도록 측정 대상과 조건으로 나눴습니다.', transcriptStatus: 'finalized',
    metadata: { primaryFunction: 'CHOICE', questionIntent: '자료 분류 항목을 선택한 기준을 확인한다.', targetEvidence: ['항목을 선택한 기준 한 가지'], depth: 'D2', activityIds: ['v4-activity-1'] },
    metrics: { speech: { durationMs: 7000, speakingMs: 4500, firstSpeechMs: 300 } },
  } as RecordedTurn;
  const turns = [q0, clarification, f1];
  const session = { id: '82903d41-9c57-4e58-8251-3e39dfe9907b', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z',
    status: 'ending', evaluationStatus: 'pending', target: context.target, turns, elapsedMs: 20000, durationSeconds: 720,
    followUpCountByMainQuestion: { [q0.id]: 1 }, metrics: {},
    questionPresentations: turns.map((turn, index) => ({ turnId: turn.id, rootTurnId: q0.id, questionKind: turn.questionKind,
      clockId: 'v4-synthetic-clock', startedAtMs: 100 + index * 8000, completedAtMs: 400 + index * 8000 })),
  } as unknown as InterviewSession;
  return reviewedRecordEvaluationFixture(context, session);
}
