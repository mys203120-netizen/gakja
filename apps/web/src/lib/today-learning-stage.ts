type PracticeAttempt = Record<string, any>;
export type TodayLearningStage = 'record'|'recall'|'interview'|'review';

const answerKinds = new Set(['quiz_answer','quiz_oral','assignment_answer','interview_answer']);
const recordedAnswer = (attempt:PracticeAttempt) => answerKinds.has(attempt.revision_kind)
  && attempt.answer_attempt_kind !== 'content_edit'
  && !attempt.context_unverified
  && Boolean(attempt.script?.trim())
  && Number.isFinite(Date.parse(attempt.created_at));
const newest = (attempts:PracticeAttempt[]) => [...attempts].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];

/** A completed stage suggests the next action; it never certifies answer quality or mastery. */
export function todayLearningStage(input:{
  checkingRecord:boolean;
  recallAvailable:boolean;
  interviewAvailable:boolean;
  attempts:PracticeAttempt[];
  applicationAttempts?:PracticeAttempt[];
}):TodayLearningStage {
  // The caller scopes both collections to the saved school and reviewed source first.
  // Edits, corrections and answers with unknown school context cannot advance a stage.
  const attempts=input.attempts.filter(recordedAnswer);
  const recall=newest(attempts.filter(attempt=>attempt.revision_kind!=='interview_answer'));
  const interview=newest([...attempts,...(input.applicationAttempts||[]).filter(recordedAnswer)]
    .filter(attempt=>attempt.revision_kind==='interview_answer'));
  if(interview&&(!recall||Date.parse(interview.created_at)>=Date.parse(recall.created_at)))return 'review';
  const independentRecall=recall?.assistance_recorded===true
    && recall.assisted!==true&&recall.hint_used!==true&&recall.ai_assisted!==true;
  if(independentRecall)return input.interviewAvailable?'interview':'review';
  if(input.checkingRecord)return 'record';
  if(input.recallAvailable)return 'recall';
  return input.interviewAvailable?'interview':'review';
}
