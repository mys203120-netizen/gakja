import { matchKnowledgeVideos } from '../../apps/web/src/lib/knowledge-bites-catalog.ts';
import { knowledgeTarget } from '../../apps/web/src/lib/knowledge-target-model.ts';
import { experienceSchema } from '../../apps/web/src/lib/armory-model.ts';
import { planTargetHref, validPlanDay } from '../../apps/web/src/lib/planner-model.ts';
import { eligibleQuizItems } from '../../apps/web/src/lib/quiz-rules.ts';

type Row = Record<string, any>;
export type HarinTenDayExtrasInput = {
  studentId: string;
  target: Row;
  learning: Row;
  contentVersion: number;
  packageId: string;
  endDate: string;
  id: (label: string) => string;
  practiceExamples?: unknown;
  documents?: { kind: string; data: Row }[];
};

const scenario = 'harin-ten-days-v1';
const marker = { synthetic: true, demoScenario: scenario };
const copy = <T,>(value: T): T => structuredClone(value);
const words = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
const identifiers = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const label = (value: string, max = 75) => value.length > max ? value.slice(0, max - 1) + '…' : value;

function dayAt(endDate: string, offset: number): string {
  const day = new Date(`${endDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}
function koreaTime(day: string, hour: number, minute = 0): string {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`).toISOString();
}

/** Pure fixture construction: no database, network, filesystem, provider call or current-time dependency. */
export function createHarinTenDayExtras(input: HarinTenDayExtrasInput) {
  const { studentId, learning, contentVersion, packageId, endDate, id } = input;
  if (!studentId || !packageId || !input.target?.id || !Number.isInteger(contentVersion) || contentVersion < 1 || !validPlanDay(endDate)) {
    throw new Error('A student, published package/version, owned target and YYYY-MM-DD endDate are required.');
  }
  const target = copy(input.target);
  const questions = list(learning.questions).filter(question => words(question.id) && words(question.prompt)
    && (!identifiers(question.support_target_ids).length || identifiers(question.support_target_ids).includes(target.id)));
  const activities = list(learning.activities).filter(activity => words(activity.id) && words(activity.title));
  const sourceRefs = list(learning.source_refs);
  if (!questions.length || activities.length < 3) throw new Error('The published demo needs a target question and three existing activities.');
  const studentContext = Object.fromEntries(Object.entries(learning.student_context || {})
    .filter(([key]) => !/name|email|phone|birth|address|student_id/i.test(key)));
  const tables: Record<string, Row[]> = {
    chat_threads: [], chat_messages: [], experience_cards: [], student_plans: [],
    reading_progress: [], knowledge_bite_progress: [], knowledge_bite_revisions: [],
  };

  const themes = [
    ['내 역할부터 짧게', '이 질문에서 제 역할을 먼저 말하려면 어떤 부분을 확인할까요?', '팀이 한 일과 내가 한 일을 나누어 보고 싶어요.', '제가 한 행동을 한 문장으로 적고 원문과 대조해 볼게요.'],
    ['비교 조건 확인', '과정을 설명할 때 비교 조건을 어떻게 구분할까요?', '조건을 확인하지 않고 결과만 말하지 않으려면요?', '같은 조건과 달랐던 조건을 먼저 적어 둘게요.'],
    ['결과와 한계 구분', '결과를 설명할 때 과장하지 않으려면 무엇을 확인할까요?', '기록에 없는 수치는 어떻게 말하는 게 좋을까요?', '확인한 결과와 추가 확인이 필요한 부분을 나누겠습니다.'],
    ['경험과 전공 연결', '경험을 지원 학과 관심으로 연결할 때 시작점을 알려 주세요.', '활동 경험만으로 전공 지식을 안다고 말해도 될까요?', '경험에서 생긴 질문과 앞으로 배울 내용을 구분해 볼게요.'],
    ['협업에서 한 행동', '협업 경험에서 제 행동을 분명하게 설명하고 싶어요.', '팀의 성과와 제 기여를 구분하는 확인 질문이 있을까요?', '제가 직접 한 일에만 밑줄을 긋고 다시 정리하겠습니다.'],
    ['답변 순서 점검', '이 질문에 답할 때 순서를 어떻게 잡으면 좋을까요?', '설명이 길어질 때 무엇부터 남겨야 할까요?', '질문에 답하는 첫 문장과 근거 문장 하나를 준비할게요.'],
    ['자료를 덮기 전 점검', '다시 답하기 전에 어떤 부분만 확인하면 좋을까요?', '도움을 읽은 답변과 새로 떠올린 답변은 구분하고 싶어요.', '이번 대화는 자료 확인으로 남기고 새 연습에서 다시 답하겠습니다.'],
    ['다음 질문 미리 읽기', '아직 답하지 않은 질문의 요구를 먼저 이해하고 싶어요.', '지금은 답을 작성하지 않고 연결된 자료만 살펴볼게요.', '나중에 실제 연습을 시작할 때 제 말로 답변을 남기겠습니다.'],
  ] as const;
  const offsets = [-9, -8, -7, -6, -4, -3, -1, 0];
  themes.forEach((theme, index) => {
    // Looking at a question in chat never creates a quiz/interview answer or mastery event.
    const question = questions[index === themes.length - 1 ? questions.length - 1 : index % questions.length];
    const linkedActivities = activities.filter(activity => identifiers(question.activity_ids).includes(activity.id));
    const sourceIds = new Set([...identifiers(question.source_ref_ids), ...linkedActivities.flatMap(activity => identifiers(activity.source_ref_ids))]);
    const sources = sourceRefs.filter(source => sourceIds.has(source.id));
    const threadId = id(`extras:chat:${index}`);
    const day = dayAt(endDate, offsets[index]);
    const activity = linkedActivities[0];
    const context = {
      ...marker, sourceKind: 'personal', packageId, contentVersion: String(contentVersion),
      targetId: target.id, target: copy(target), activityId: activity?.id || null,
      questionId: question.id, briefingId: null, briefing: null,
      activities: copy(linkedActivities), questions: [copy(question)], sources: copy(sources),
      answerScripts: copy(list(learning.answer_scripts).filter(script => script.question_id === question.id)),
      studentContext: copy(studentContext), demoProvenance: 'authored_synthetic_conversation',
    };
    const cards = [
      ...linkedActivities.map(item => ({ id: item.id, type: 'activity', title: item.title, href: `/materials/activities/${encodeURIComponent(item.id)}` })),
      { id: question.id, type: 'question', title: question.prompt, href: `/materials/questions/${encodeURIComponent(question.id)}` },
      ...sources.map(source => ({ id: source.id, type: 'source', title: source.title || source.area || '원문 근거', href: '/materials/guidebook', quote: words(source.quote) })),
    ];
    const quotation = words(sources.find(source => words(source.quote))?.quote);
    const grounded = quotation ? `연결된 예시 원문에는 다음 문장이 있어요.\n\n> ${quotation.replace(/\n/g, '\n> ')}\n\n` : '';
    const criteria = identifiers(question.answer_elements).slice(0, 3);
    const firstReply = `10일 사용 예시용 대화입니다. 실제 학생의 상담이나 유료 AI 실행 기록이 아닙니다.\n\n「${question.prompt}」에서 묻는 범위를 먼저 확인해요. ${grounded}${criteria.length ? `검수된 확인 요소는 ${criteria.join(' · ')}예요. ` : ''}아래 근거를 읽고, 직접 한 행동과 아직 확인하지 못한 내용을 구분해 보세요.`;
    const secondReply = index === 2
      ? '예시 피드백: 원문에 없는 횟수나 효과 수치는 추가하지 않아요. 확인한 사실을 먼저 말하고, 측정하거나 확인하지 못한 범위를 따로 설명해 보세요.'
      : index === 3
        ? '예시 피드백: 활동에서 생긴 관심과 대학에서 새로 배우려는 내용을 나누면 좋아요. 현재 기록만으로 전공 지식이나 공식 학교 평가 결과를 단정하지 않습니다.'
        : index === 6
          ? '예시 피드백: 이 대화에서 읽은 도움과 이후의 새 연습은 다른 기록이에요. 실제 연습에서 도움을 열었는지 함께 남기고, 시간이 지난 뒤 같은 질문의 답변을 비교해 보세요.'
          : `예시 피드백: ${activity ? `「${activity.title}」의 원문과 ` : ''}질문의 표현을 대조해 보세요. 첫 문장은 질문에 직접 답하고, 다음 문장에는 기록에서 확인한 근거를 하나 붙여 보세요. 없는 경험이나 결과는 만들지 않아요.`;
    const finalReply = index === 7
      ? '좋아요. 이 예시 대화는 질문과 자료를 살펴본 기록이며, 답변 제출이나 연습 완료로 집계하지 않아요. 실제 연습은 별도 화면에서 시작할 수 있어요.'
      : '좋아요. 이 대화는 확인을 돕는 예시입니다. 문장 길이를 늘리기보다 실제 행동과 근거가 맞는지 확인하고, 새 답변은 연습 화면에서 따로 남겨 주세요.';
    const messages = [theme[1], firstReply, theme[2], secondReply, theme[3], finalReply];
    tables.chat_threads.push({ id: threadId, student_id: studentId, target_id: target.id, content_version: contentVersion,
      title: `[예시] ${theme[0]}`, context, created_at: koreaTime(day, 18), updated_at: koreaTime(day, 18, 10),
      archived_at: null, deleted_at: null, request_id: `demo:${scenario}:chat:${index}` });
    messages.forEach((content, messageIndex) => {
      const assistant = messageIndex % 2 === 1;
      tables.chat_messages.push({ id: id(`extras:chat:${index}:message:${messageIndex}`), thread_id: threadId, student_id: studentId,
        role: assistant ? 'assistant' : 'user', content, status: 'completed',
        request_id: `demo:${scenario}:${index}:${Math.floor(messageIndex / 2)}`,
        data: { ...marker, demoProvenance: 'authored_synthetic_conversation', ...(assistant ? { sources: copy(cards), model: 'synthetic-demo', promptVersion: 'authored-demo-v1' } : {}) },
        created_at: koreaTime(day, 18, messageIndex * 2) });
    });
  });

  activities.slice(0, 3).forEach((activity, index) => {
    const data = {
      title: label(`[예시] ${activity.title}`, 120), category: index === 1 ? '협업' : '탐구',
      situation: `[합성 경험 예시] ${words(activity.activity_summary) || words(activity.motivation) || `「${activity.title}」의 자료를 확인하는 상황입니다.`}`,
      action: words(activity.role) || words(activity.process) || '예시 원문에서 확인할 문장을 골라 직접 한 행동을 구분했습니다.',
      result: [words(activity.result), words(activity.lessons)].filter(Boolean).join('\n') || '예시 자료에 없는 성과는 추가하지 않았습니다.',
      confirmed: true, pinned: true,
      sourceNote: '[예시] 발행된 합성 활동을 재구성한 카드입니다. 실제 학생 경험을 인증한 기록이 아닙니다.',
    };
    experienceSchema.parse(data);
    const day = dayAt(endDate, -8 + index * 3);
    tables.experience_cards.push({ id: id(`extras:experience:${index}`), student_id: studentId, revision: 1,
      data: { ...data, ...marker, sourceActivityId: activity.id, sourceRefIds: identifiers(activity.source_ref_ids), sourceContentVersion: contentVersion },
      created_at: koreaTime(day, 17), updated_at: koreaTime(day, 17, 10) });
  });

  const planKinds = ['reading', 'quiz', 'interview', 'study'] as const;
  const planLabels = ['원문 확인', '핵심어 퀴즈', '다시 말하기', '답변 정리'];
  // Match the journey's actual practice pools. Keep valid existing links and
  // all pending plans; a completed plan cannot claim an untouched question.
  const untouchedId = questions.at(-1)!.id;
  const answerPool = eligibleQuizItems(learning as any, 'answer').filter(item => item.kind !== 'choice' && item.question_id !== untouchedId).slice(0, 4);
  const choicePool = eligibleQuizItems(learning as any, 'choice').filter(item => item.question_id !== untouchedId && item.linked_question_id !== untouchedId).slice(0, 2);
  const practicedIds = new Set([...answerPool, ...choicePool].map(item => item.question_id));
  const completedQuestions = questions.filter(question => practicedIds.has(question.id));
  const interviewIds = new Set(answerPool.map(item => item.question_id));
  const interviewQuestions = completedQuestions.filter(question => interviewIds.has(question.id) && !identifiers(question.question_types).includes('concept'));
  if (!completedQuestions.length || !interviewQuestions.length) throw new Error('Completed example plans need the journey’s practiced quiz and interview questions.');
  for (let index = 0; index < 20; index++) {
    const kind = planKinds[index % planKinds.length];
    const offset = index < 16 ? -9 + Math.floor(index / 2) : index < 18 ? 0 : 1;
    const day = dayAt(endDate, offset), completed = index < 16;
    const candidate = questions[index % questions.length];
    const pool = kind === 'interview' ? interviewQuestions : completedQuestions;
    const question = completed && !pool.some(item => item.id === candidate.id) ? pool[Math.floor(index / 4) % pool.length] : candidate;
    const activity = activities.find(item => identifiers(question.activity_ids).includes(item.id));
    const useActivity = kind === 'reading' && Boolean(activity);
    const planTarget = {
      ...marker, kind: useActivity ? 'activity' as const : 'question' as const,
      id: useActivity ? activity!.id : question.id,
      title: useActivity ? activity!.title : question.prompt,
      targetId: target.id, sourceType: 'personal' as const, sourceVersion: contentVersion, contentVersion,
      targetSnapshot: copy(target), ...(useActivity ? { activityIds: [activity!.id] } : { questionSnapshot: copy(question), activityIds: identifiers(question.activity_ids) }),
      demoCompletion: completed ? 'manual_example' : 'not_completed',
    };
    if (!planTargetHref(planTarget, kind)) throw new Error('The example plan must have a valid application destination.');
    tables.student_plans.push({ id: id(`extras:plan:${index}`), student_id: studentId,
      title: label(`[예시] ${planLabels[index % planLabels.length]} · ${useActivity ? activity!.title : question.prompt}`, 160),
      planned_date: day, kind, completed, revision: 1, target: planTarget,
      created_at: koreaTime(index < 16 ? day : endDate, 8), updated_at: koreaTime(index < 16 ? day : endDate, completed ? 20 : 8) });
  }

  // Use the actual publication TOC; fixture prefixes and chapter layouts may change.
  // This table has no JSON metadata column; its demo provenance is recorded in the returned summary.
  for (const kind of ['guidebook', 'handbook'] as const) {
    const document = input.documents?.find(item => item.kind === kind);
    const sections = list(document?.data?.sections);
    const preferred = list(sections[kind === 'guidebook' ? 2 : 1]?.children)[0];
    const section = preferred || sections.flatMap(item => list(item.children).length ? list(item.children) : [item])[0];
    if (!words(section?.id)) throw new Error(`The actual ${kind} document sections are required for reading progress.`);
    tables.reading_progress.push({ student_id: studentId, document_kind: kind, section_id: section.id,
      updated_at: koreaTime(dayAt(endDate, -1), 19, kind === 'guidebook' ? 0 : 20) });
  }

  const matchedVideos = matchKnowledgeVideos(learning, knowledgeTarget(target)).filter(item => item.kind !== 'reading').slice(0, 3);
  matchedVideos.forEach((video, index) => {
    const day = dayAt(endDate, -7 + index * 2), timestamp = koreaTime(day, 19), progressId = id(`extras:knowledge:${video.id}`);
    const reflection = `[예시 메모] 「${video.label}」를 연결 자료로 저장했습니다. 외부 영상의 실제 시청·학습 완료를 기록한 것은 아니며, 다음 연습 전에 원문과 비교할 질문을 적어 두는 예시입니다.`;
    const snapshot = {
      ...marker, title: video.title, label: video.label, topic: video.topic, focus: video.focus, stretch: video.stretch,
      activities: copy(video.activities), contexts: copy(video.contexts || []), contentVersion,
      verifiedAt: video.verifiedAt, targetId: target.id, targetSnapshot: copy(video.targetSnapshot),
      item: { ...copy(video), progress: null, relatedQuestions: [] },
      learning: { ...marker, targetId: target.id, targetSnapshot: copy(video.targetSnapshot), contentVersion, selfCheck: 'not_yet', assisted: false },
      lastAction: 'reflection', demoProvenance: 'saved_reference_example', externalViewingVerified: false,
    };
    tables.knowledge_bite_progress.push({ id: progressId, student_id: studentId, video_id: video.id,
      saved: true, completed_at: null, reflection, revision: 1, snapshot, created_at: timestamp, updated_at: timestamp });
    tables.knowledge_bite_revisions.push({ id: id(`extras:knowledge:${video.id}:revision:1`), progress_id: progressId,
      student_id: studentId, video_id: video.id, saved: true, completed_at: null, reflection, revision: 1,
      metadata: copy(snapshot), created_at: timestamp });
  });

  return { tables, summary: {
    ...marker, startDate: dayAt(endDate, -9), endDate, tomorrow: dayAt(endDate, 1),
    counts: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])),
    plans: { completedExamples: 16, todayPending: 2, tomorrowPending: 2 },
    knowledge: { savedExamples: matchedVideos.length, completed: 0, ids: matchedVideos.map(video => video.id) },
    readingProgress: tables.reading_progress.map(row => ({ documentKind: row.document_kind, sectionId: row.section_id, ...marker })),
    paidAiCalls: 0, generatedAnswerAttempts: 0, actualExternalViewsClaimed: 0,
  } };
}
