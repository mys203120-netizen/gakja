import {availabilityMinutesForDate,normalizeTrainingAvailability} from './training-availability';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {koreaToday,validPlanDay} from './planner-model';

type Value=Record<string,any>;
const count=(value:unknown)=>Number.isFinite(Number(value))?Math.max(0,Number(value)||0):0;
const time=(value:unknown)=>value&&Number.isFinite(new Date(String(value)).getTime())?new Date(String(value)).toISOString():null;

/** Read-only operational observations. Never return raw preferences, answer bodies or an ability score. */
export function adminTrainingSummary(input:{studentId:string;activeVersion?:number|null;targets:Value[];preferences?:Value;plans?:Value[];sessions?:Value[];today?:string}){
  const today=input.today||koreaToday(),preferences=input.preferences||{};
  const targets=input.targets.filter(target=>target.student_id===input.studentId&&!target.archived_at);
  const availability=normalizeTrainingAvailability(preferences.trainingAvailability,today);
  const sessions=(input.sessions||[]).filter(session=>session.student_id===input.studentId&&['active','completed'].includes(session.state)
    &&recordMatchesCurrentTarget({targetId:session.target_id,targetSnapshot:session.target_snapshot},targets)
    &&(session.source_kind==='common'||!input.activeVersion||Number(session.content_version)===Number(input.activeVersion)));
  const byTarget=targets.map(target=>{
    const diagnostic=preferences.trainingDiagnostics?.[target.id];
    const matches=diagnostic&&recordMatchesCurrentTarget({targetId:target.id,targetSnapshot:diagnostic.targetSnapshot},[target])
      &&(diagnostic.sourceType==='common'||!input.activeVersion||Number(diagnostic.sourceVersion)===Number(input.activeVersion));
    const session=matches?sessions.find(session=>session.id===diagnostic.sessionId&&session.target_id===target.id&&session.purpose==='diagnostic'):null;
    const diagnosticState=session?.state==='completed'&&count(session.answers)>0?'completed':session?.state==='active'?'in_progress':'not_started';
    const personal=target.schedule?.personal_date||target.schedule?.personal_at?.slice(0,10);
    const period=target.schedule?.period_start;
    return {targetId:target.id,university:String(target.university||''),department:String(target.department||target.major||''),
      diagnosticState,reviewRequests:matches?new Set(Array.isArray(diagnostic.needsReviewQuestionIds)?diagnostic.needsReviewQuestionIds:[]).size:0,
      date:validPlanDay(personal)?personal:validPlanDay(period)?period:null,dateKind:validPlanDay(personal)?'personal':validPlanDay(period)?'public_period':null,
      calendarStatus:String(target.admission_calendar_registration?.status||'unverified')};
  });
  const completedPlans=new Set(sessions.filter(session=>session.state==='completed'&&count(session.answers)>0).map(session=>session.training_plan_id).filter(Boolean));
  const plans=(input.plans||[]).filter(plan=>plan.student_id===input.studentId&&plan.date===today&&plan.target?.automaticPractice?.status!=='superseded'&&plan.target?.automaticPractice?.hybrid?.kind!=='break'
    &&(!plan.target?.targetId||recordMatchesCurrentTarget(plan.target,targets))
    &&(!plan.target?.automaticPractice?.hybrid||!plan.target?.targetId||plan.target?.sourceType==='common'||!input.activeVersion||Number(plan.target?.sourceVersion)===Number(input.activeVersion)));
  const completed=(plan:Value)=>plan.target?.automaticPractice?.hybrid&&!['review','break'].includes(plan.target.automaticPractice.hybrid.kind)?completedPlans.has(plan.id):Boolean(plan.completed);
  const minutes=(plan:Value)=>count(plan.target?.automaticPractice?.minutes||plan.target?.minutes||10);
  const lastPracticedAt=sessions.map(session=>time(session.last_answer_at)).filter(Boolean).sort().at(-1)||null;
  const diagnosis={total:targets.length,completed:byTarget.filter(target=>target.diagnosticState==='completed').length,inProgress:byTarget.filter(target=>target.diagnosticState==='in_progress').length};
  return {today,schoolCount:targets.length,availability:{configured:Boolean(availability),todayMinutes:availabilityMinutesForDate(availability,today),
      weekdayMinutes:availability?.weekdayMinutes??null,
      weekendMinutes:availability?.weekendMinutes??null,
      savedAt:availability?.savedAt||null},diagnosis,
    training:{planned:plans.length,completed:plans.filter(completed).length,inProgress:plans.filter(plan=>!completed(plan)&&Boolean(plan.target?.automaticPractice?.startedAt||plan.target?.automaticPractice?.hybrid?.startedAt)).length,
      plannedMinutes:plans.reduce((sum,plan)=>sum+minutes(plan),0),completedMinutes:plans.filter(completed).reduce((sum,plan)=>sum+minutes(plan),0),lastPracticedAt,
      textAnswers:sessions.reduce((sum,session)=>sum+count(session.text_answers),0),audioAnswers:sessions.reduce((sum,session)=>sum+count(session.audio_answers),0)},
    targets:byTarget,nextStep:!targets.length?'학교 등록':!availability?'학습 시간 설정':diagnosis.completed<targets.length?'첫 진단':plans.length?'오늘 훈련':'다음 접속 시 계획 조정'};
}
