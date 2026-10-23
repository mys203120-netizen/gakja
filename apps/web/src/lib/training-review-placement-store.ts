import 'server-only';
import {ApiError,transaction} from './db';
import {buildPlanContext} from './planner-context';
import {studentModelRevision} from './student-read-model';
import {studentAdmissionCalendar} from './admission-calendar-store';
import {interviewSupportForTarget} from './school-interview-scope';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {koreaToday} from './planner-model';
import {normalizeTrainingAvailability} from './training-availability';
import {loadReviewQuestionFacts} from './training-review-evidence-store';
import {reconcileTrainingReviews,reviewQuestionKey} from './training-review';
import {reviewDiagnostics} from './training-review-store';
import {trainingQuizQuestions} from './training-practice-store';
import {hybridDeadlines,hybridTrainingDays} from './hybrid-training';
import {curriculumPolicySnapshot} from './curriculum-policy';
import {lockedCalendarPlans,applyCalendarReplacement} from './calendar-edit-store';
import {reviewPlacementSuggestions,type ReviewPlacementPreview} from './training-review-placement';

/** A preview deliberately bypasses read-through caches and review-state synchronization. */
export async function trainingReviewPlacement(studentId:string,selection?:{questionKey:string;date:string},expectedFingerprint?:string){
 const today=koreaToday(),revision=await transaction(db=>studentModelRevision(db,studentId));
 const [context,calendar]=await Promise.all([buildPlanContext(studentId,[],{readOnly:true}),studentAdmissionCalendar(studentId)]);
 return transaction(async db=>{
  await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
  // Match the planner's target-before-preferences lock order.
  const registered=(await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id for share",[studentId])).rows;
  if(registered.length!==context.schoolTargets.length||registered.some(row=>!context.schoolTargets.some(saved=>saved.id===row.id&&knowledgeTargetKey(saved.data)===knowledgeTargetKey(row.data))))throw new ApiError(409,'지원 학교 정보가 바뀌었어요. 다시 확인해 주세요.');
  const state=await lockedCalendarPlans(db,studentId),preferences=state.preferences;
  const source=await loadReviewQuestionFacts(studentId,context,db);
  const reviewed=reconcileTrainingReviews({state:preferences.trainingReview,questions:source.questions,diagnostics:reviewDiagnostics(preferences.trainingDiagnostics),now:new Date().toISOString()});
  const questions=trainingQuizQuestions(source.questions,context).map(question=>({...question,review:reviewed.questions.find(item=>item.questionKey===reviewQuestionKey({...question,targetKey:question.targetKey||''})),repetition:preferences.trainingRepetition?.[reviewQuestionKey({...question,targetKey:question.targetKey||''})]}));
  const availability=normalizeTrainingAvailability(preferences.trainingAvailability,today);
  const targets=context.schoolTargets.map(row=>({...row.data,id:row.id,interviewSupported:interviewSupportForTarget(row.data).supported}));
  const settings=Object.fromEntries(targets.flatMap(target=>{const saved=preferences.automaticPractice?.[target.id];return saved?.targetSnapshot&&recordMatchesCurrentTarget({targetId:target.id,targetSnapshot:saved.targetSnapshot},[target])?[[target.id,saved]]:[];}));
  const deadlines=hybridDeadlines({today,targets,schedules:calendar.interviewSchedules,coverage:calendar.interviewScheduleCoverage.targets,availability,settings});
  const guideline=(await db.query("select id,version,rules from student_document_guidelines where kind='curriculum' and status='published' order by version desc limit 1")).rows[0],policy=curriculumPolicySnapshot(guideline);
  // Source writes advance these epochs. Hold them through confirmation so a
  // newly submitted answer/catalog change cannot race the final evidence check.
  await db.query('select revision from student_learning_revisions where student_id=$1 for update',[studentId]);
  await db.query('select revision from learning_catalog_revision where singleton=true for share');
  if(await studentModelRevision(db,studentId)!==revision)throw new ApiError(409,'학습 기록이나 자료가 바뀌었어요. 보완 일정을 다시 확인해 주세요.');
  const suggestions=reviewPlacementSuggestions({today,availability,policy:policy.rules,questions,deadlines,plans:state.plans,disabledTargets:Object.keys(settings).filter(id=>settings[id].enabled===false)});
  if(!selection)return {suggestions:suggestions.filter(item=>item.status!=='covered'),coveredCount:suggestions.filter(item=>item.status==='covered').length};
  const suggestion=suggestions.find(item=>item.questionKey===selection.questionKey),candidate=suggestion?.candidates.find(item=>item.date===selection.date);
  if(!suggestion)throw new ApiError(404,'현재 학교·자료의 보완 질문을 다시 선택해 주세요.');
  if(!candidate||suggestion.status!=='ready')throw new ApiError(409,suggestion.message||'일정이 바뀌었어요. 보완 날짜를 다시 선택해 주세요.');
  const question=questions.find(item=>reviewQuestionKey({...item,targetKey:item.targetKey||''})===selection.questionKey)!;
  const owned=source.targets.get(`${question.targetId}:${question.sourceType}:${question.sourceVersion}:${question.id}`),deadline=deadlines.find(item=>item.targetId===question.targetId)!;
  if(!owned)throw new ApiError(404,'현재 자료의 질문을 찾을 수 없어요.');
  const day=hybridTrainingDays({today:selection.date,availability,questions:[question],deadlines:[deadline],windowDays:1,policy:policy.rules})[0];
  const tasks=day.tasks;
  if(!tasks.length||tasks.some(task=>task.area!==suggestion.area)||!tasks.some(task=>['focus','mixed','diagnostic','recall'].includes(task.kind))||day.plannedMinutes>candidate.minutes||new Set(tasks.map(task=>task.kind)).size!==tasks.length)throw new ApiError(409,'하루 한 영역과 화상 연습 순서를 유지할 수 없어요. 학습 시간을 확인해 주세요.');
  const preview:ReviewPlacementPreview={label:'보완 영역 편성',questionKey:suggestion.questionKey,title:suggestion.title,reason:suggestion.reason,school:suggestion.school,area:suggestion.area,sourceType:suggestion.sourceType,sourceVersion:suggestion.sourceVersion,deadline:suggestion.deadline!,deadlineLabel:suggestion.deadlineLabel,date:selection.date,minutes:day.plannedMinutes,before:candidate.before,after:tasks.map(task=>({title:task.title,kind:task.kind,minutes:task.minutes,sequence:task.sequence!,area:task.area!})),conflicts:suggestion.conflicts};
  const plans=tasks.map(task=>({title:task.title,kind:['focus','mixed','diagnostic','recall'].includes(task.kind)?'interview':task.kind==='quiz'?'quiz':'study',target:{...owned,automaticPractice:{version:3,status:'active',interviewDate:deadline.date,dateSource:deadline.source,dailyMinutes:candidate.minutes,minutes:task.minutes,reason:task.reason,hybrid:{version:3,curriculumPolicy:policy,key:task.id,kind:task.kind,stage:task.stage,sequence:task.sequence,pressure:task.pressure===true,area:task.area,activityTitles:task.activityTitles,availabilityRevision:availability!.revision,...(task.practice?{practice:task.practice}:{}),reviewPlacement:{questionKey:suggestion.questionKey,reason:suggestion.reason,deadline:deadline.date}}}}}));
  // Include current ownership/source/evidence and every changed revision, not client-supplied snapshots.
  return applyCalendarReplacement(db,studentId,state,{preview,date:selection.date,removeIds:candidate.before.map(plan=>plan.id),plans,contextFingerprint:knowledgeTargetKey({revision,availability,policy,question,registered})},expectedFingerprint);
 });
}
