import {koreaToday,shiftPlanDay,validPlanDay} from './planner-model';
import {DEFAULT_CURRICULUM_POLICY,curriculumPolicySchema,type CurriculumPolicy} from './curriculum-policy';
import {personalDate} from './schedule';
import {availabilityMinutesForDate,normalizeTrainingAvailability} from './training-availability';
import type {ReviewAttempt,ReviewQuestionStatus} from './training-review';

type Value=Record<string,any>;
export type HybridTaskKind='reading'|'diagnostic'|'recall'|'quiz'|'assignment'|'focus'|'mixed'|'review'|'break';
export type TrainingPractice={kind:'quiz';mode:'choice'|'answer';itemIds:string[]}|{kind:'assignment';assignmentId:string};
export type HybridAssignment={id:string;title:string;targetId:string;sourceType:'personal'|'common';sourceVersion:number;questionId:string;minutes:number;dueDate:string|null};
export type HybridDeadline={targetId:string;university:string;department:string;date:string|null;source:'personal'|'public_day'|'public_period'|'goal'|null;label:string;periodStart:string|null;periodEnd:string|null;status:'ready'|'passed'|'today'|'needs_review'|'no_interview'|'unmatched'|'unsupported';reason:string;daysLeft:number|null;availableMinutes:number};
export type HybridAttempt=Partial<ReviewAttempt>&{at:string};
export type TrainingStage='practice'|'real'|'report'|'final_review';
export type HybridQuestion={id:string;title:string;targetId:string;targetKey?:string;sourceType:'personal'|'common';sourceVersion:number;activityIds:string[];category:'personal'|'major'|'talent';attempts:HybridAttempt[];review?:ReviewQuestionStatus;href?:string;quiz?:Extract<TrainingPractice,{kind:'quiz'}>;area?:string;priority?:number;volume?:number;activityTitles?:string[];rehearsal?:{sessionId:string;reportId:string|null;completedAt:string};repetition?:{enabled:boolean;intervalDays:number}};
export type HybridTask={id:string;title:string;kind:HybridTaskKind;minutes:number;reason:string;targetId:string|null;questionId?:string;sourceType?:'personal'|'common';sourceVersion?:number;activityIds:string[];href?:string|null;performedAt?:string|null;completed?:boolean;startedAt?:string|null;status:'pending'|'in_progress'|'completed';manual?:boolean;date?:string;sequence?:number;practice?:TrainingPractice;pressure?:boolean;stage?:TrainingStage;area?:string;activityTitles?:string[]};
export type HybridAllocation={stage:TrainingStage;reportId?:string;mode:'foundation'|'repair'|'rehearsal'|'connection';daysLeft:number|null;observedQuestions:number;totalQuestions:number;focusShare:number;mixedShare:number;reason:string};
export type HybridDay={date:string;capacityMinutes:number;plannedMinutes:number;remainingMinutes:number;unallocatedMinutes:number;tasks:HybridTask[];focus:string;reason:string;allocation:HybridAllocation;area?:string;activityTitles?:string[];warnings?:string[]};
export const daysBetween=(from:string,to:string)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);

/** A public period supplies a preparation goal; it never becomes an applicant appointment. */
export function hybridDeadlines(input:{today:string;targets:Value[];schedules:Value[];coverage:Value[];settings?:Value;availability?:unknown}):HybridDeadline[]{
  const availability=normalizeTrainingAvailability(input.availability,input.today);
  return input.targets.map<HybridDeadline>(target=>{
    const targetId=String(target.id),coverage=input.coverage.find(row=>row.targetId===targetId),all=input.schedules.filter(row=>row.targetId===targetId);
    const year=Number(target.admission_year||target.admissionYear||target.year),calendarYear=year?String(year-1):null;
    const matched=all.filter(row=>row.applicability==='track_match'&&validPlanDay(row.startDate)&&validPlanDay(row.endDate)&&row.startDate<=row.endDate&&(!calendarYear||row.startDate.startsWith(calendarYear+'-')&&row.endDate.startsWith(calendarYear+'-')));
    const base:HybridDeadline={targetId,university:String(target.university||''),department:String(target.department||target.major||''),date:null,source:null,label:'면접 일정 확인 필요',periodStart:null,periodEnd:null,status:'unmatched',reason:coverage?.note||'선택한 전형·학과의 면접 일정을 확인해 주세요.',daysLeft:null,availableMinutes:0};
    const unavailable=coverage?.status==='no_interview'||target.interviewSupported===false;
    if(unavailable)return {...base,status:coverage?.status==='no_interview'?'no_interview':'unsupported',label:coverage?.status==='no_interview'?'면접 미실시':'학생부형 준비 범위 확인',reason:target.interviewSupportReason||coverage?.note||base.reason};
    const person=personalDate(target),personal=person?(person.includes('T')?koreaToday(new Date(person)):person):null;
    const targetSettings=input.settings?.[targetId],goal=String(targetSettings?.interviewDate||'');
    let date:string|null=null,source:HybridDeadline['source']=null,label=base.label,reason=base.reason;
    if(personal&&validPlanDay(personal)&&!['needs_review','changed'].includes(String(target.schedule?.status||''))){date=personal;source='personal';label='내 개별 면접일';reason='등록한 개인 면접일을 기준으로 준비해요.';}
    else if(coverage?.status==='available'&&matched.length){
      const starts=matched.map(row=>row.startDate).sort(),ends=matched.map(row=>row.endDate).sort();
      base.periodStart=starts[0];base.periodEnd=ends.at(-1)!;
      date=starts[0];source=base.periodStart===base.periodEnd?'public_day':'public_period';
      label=source==='public_day'?'학교 공개 면접일 · 개인 배정 확인 필요':'공개 기간 시작 전 준비 목표 · 개인 배정 대기';
      reason=source==='public_day'?'선택한 전형·학과와 연결된 공개 일정이에요. 개인 응시일은 별도로 확인해 주세요.':`공개 면접 기간 ${base.periodStart}~${base.periodEnd}에 맞춘 임시 준비 목표예요. 개인 응시일 확정 후 다시 조정해요.`;
    }else if(validPlanDay(goal)&&targetSettings?.dateSource==='goal'){
      date=goal;source='goal';label='내가 직접 정한 준비 목표일';reason='실제 면접일이 아닌 직접 선택한 준비 목표를 사용해요. 학교 일정 확인 후 수정해 주세요.';
    }
    if(!date)return {...base,status:coverage?.status==='needs_review'?'needs_review':'unmatched'};
    let availableMinutes=0;
    // The rolling view is short; the capacity forecast still spans the actual remaining period.
    for(let day=input.today;day<date;day=shiftPlanDay(day,1))availableMinutes+=availabilityMinutesForDate(availability,day);
    const daysLeft=daysBetween(input.today,date);
    return {...base,date,source,label,reason,daysLeft,availableMinutes,status:daysLeft<0?'passed':daysLeft===0?'today':'ready'};
  }).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||a.targetId.localeCompare(b.targetId));
}

/** These are observations and student-marked review requests, never inferred ability scores. */
export function hybridQuestionObservation(question:HybridQuestion,diagnostics:Value,today:string){
  const latest=question.attempts.filter(attempt=>attempt.valid!==false).sort((a,b)=>b.at.localeCompare(a.at)||String(b.id||'').localeCompare(String(a.id||'')))[0];
  // Legacy diagnostic arrays are migration input only. They must never add a second, permanent weight.
  const marked=Boolean(question.review?.needsReview&&question.review.requestIds.length),categoryMarked=false;
  const helped=Boolean(latest?.assisted),timedOut=Boolean(latest?.timedOut),incorrect=latest?.outcome===false,judged=latest?.needsReview===true;
  const lastDay=latest?.at?(latest.at.includes('T')?koreaToday(new Date(latest.at)):latest.at):null;
  const repeatAllowed=question.repetition?.enabled!==false;
  const due=Boolean(repeatAllowed&&lastDay&&daysBetween(lastDay,today)>=(question.repetition?.intervalDays||1));
  return {unseen:!latest,due,marked,categoryMarked,helped,timedOut,incorrect,needsReview:repeatAllowed&&(question.review?.needsReview??(helped||timedOut||incorrect||judged))&&(!question.repetition||due),
    reason:question.review?.needsReview?question.review.reason:judged?`AI 피드백의 보완점을 다시 확인해요. ${latest?.evaluationReason||''}`:helped?'최근 답변에서 도움을 사용해, 도움 없이 다시 답할 시간을 배치했어요.':timedOut?'최근 답변에서 시간이 초과되어 답변을 다시 정리해요.':incorrect?'최근 개념 확인에서 틀린 항목을 다시 확인해요.':!latest?'아직 답변하지 않은 영역을 확인해요.':due?'이전에 답한 내용을 자료 없이 다시 떠올려요.':'활동의 근거와 설명을 더 구체적으로 확인해요.'};
}

/** Only untouched automatic tasks can be replaced. Past records and started work remain intact. */
export function preserveHybridPlan(plan:Value,today:string){
  const auto=plan.target?.automaticPractice;
  if(!auto)return true;
  if(plan.completed||plan.performedAt||plan.date<today||plan.target?.calendarPlacement?.operationId||auto.hybrid?.studentOrderedAt)return true;
  const started=auto.startedAt||auto.hybrid?.startedAt;
  return Boolean(started&&plan.date===today);
}

/** The deadline changes proportions only after actual coverage/diagnosis permits it. */
export function hybridAllocation(date:string,questions:HybridQuestion[],deadlines:HybridDeadline[],diagnostics:Value={},policy:CurriculumPolicy=DEFAULT_CURRICULUM_POLICY):HybridAllocation{
  const observations=questions.map(question=>hybridQuestionObservation(question,diagnostics,date));
  const observedQuestions=observations.filter(observation=>!observation.unseen).length,totalQuestions=questions.length;
  const days=deadlines.filter(item=>item.date&&item.date>date).map(item=>daysBetween(date,item.date!));
  const daysLeft=days.length?Math.min(...days):null;
  const reports=questions.filter(question=>question.rehearsal?.reportId).sort((a,b)=>b.rehearsal!.completedAt.localeCompare(a.rehearsal!.completedAt));
  const reportId=reports[0]?.rehearsal?.reportId||undefined,finalReview=reports.some(question=>hybridQuestionObservation(question,diagnostics,date).needsReview);
  const base={daysLeft,observedQuestions,totalQuestions,stage:'practice' as TrainingStage,...(reportId?{reportId}:{})};
  if(finalReview)return {...base,stage:'final_review',mode:'repair',focusShare:1,mixedShare:0,reason:'완료한 실전 리포트에 연결된 보완 질문을 먼저 연습해요. 마감이 가까워도 새 실전보다 남은 보완을 우선해요.'};
  if(questions.some(question=>question.rehearsal&&!question.rehearsal.reportId))return {...base,stage:'report',mode:'connection',focusShare:.7,mixedShare:0,reason:'실전 답변을 마쳤어요. 종합 리포트가 준비되는 동안 근거를 확인하고 답변 연습을 이어가요.'};
  const diagnosed=questions.length>0&&questions.every(question=>diagnostics[question.targetId]?.state==='completed'||question.attempts.some(attempt=>attempt.valid!==false));
  if(!diagnosed||observedQuestions<Math.ceil(totalQuestions/2))return {...base,mode:'foundation',focusShare:0.6,mixedShare:0.2,reason:'미확인 기록과 질문이 남아 내용 확인 시간을 먼저 확보했어요. 면접이 가까워도 연결 면접만 늘리지 않아요.'};
  const reviewShare=totalQuestions?observations.filter(observation=>observation.needsReview).length/totalQuestions:0;
  if(reviewShare)return {...base,mode:'repair',focusShare:0.5+0.1*reviewShare,mixedShare:0.3-0.1*reviewShare,reason:'현재 남은 보완 질문의 비중에 맞춰 우선순위를 조정하고 연결 면접 시간을 함께 확보했어요.'};
  if(reports.length===questions.length&&reports.length)return {...base,stage:'final_review',mode:'repair',focusShare:1,mixedShare:0,reason:'실전과 종합 리포트를 완료했고 현재 남은 보완 요청은 없어요. 확인한 답변을 마지막으로 점검해요.'};
  if(daysLeft!==null&&daysLeft<=policy.rehearsalDays)return {...base,stage:'real',mode:'rehearsal',focusShare:0.4,mixedShare:0.4,reason:`가장 가까운 준비 마감이 ${daysLeft}일 남았고 실제 답변이 있어 실전 면접을 준비해요.`};
  if(daysLeft!==null&&daysLeft>21)return {...base,mode:'connection',focusShare:0.55,mixedShare:0.25,reason:`가장 가까운 준비 마감이 ${daysLeft}일 남아 기록·개념 확인과 간격을 둔 답변 연습을 함께 쌓아요.`};
  return {...base,mode:'connection',focusShare:0.5,mixedShare:0.3,reason:'확인한 활동과 개념을 보완하면서 학교·다른 주제에 연결하는 답변을 늘려요.'};
}

const taskKey=(date:string,kind:HybridTaskKind,index:number,question:HybridQuestion)=>`hybrid:${date}:${kind}:${index}:${question.targetId}:${question.sourceType}:${question.sourceVersion}:${question.id}`;
const minutes=(value:unknown)=>Number.isFinite(Number(value))?Math.max(0,Math.round(Number(value))):0;
const questionScopeKey=(question:{targetId?:string|null;sourceType?:string;sourceVersion?:number;id:string})=>JSON.stringify([question.targetId,question.sourceType,question.sourceVersion,question.id]);

/** One student's daily capacity is shared by every school. Seven days is a detail window, not a course length. */
export function hybridTrainingDays(input:{today:string;availability:unknown;deadlines:HybridDeadline[];questions:HybridQuestion[];assignments?:HybridAssignment[];diagnostics?:Value;fixedTasks?:HybridTask[];deferredTaskKeys?:string[];windowDays?:number;policy?:CurriculumPolicy}):HybridDay[]{
  const policy=curriculumPolicySchema.parse(input.policy||DEFAULT_CURRICULUM_POLICY);
  const availability=normalizeTrainingAvailability(input.availability,input.today),diagnostics=input.diagnostics||{},fixedTasks=(input.fixedTasks||[]).filter(task=>task.manual||task.kind!=='break');
  const counts=new Map<string,number>(),questionDates=new Map<string,string>();
  const assigned=new Set(fixedTasks.flatMap(task=>task.practice?.kind==='assignment'?[task.practice.assignmentId]:[]));
  const deferredKeys=new Set(input.deferredTaskKeys||[]);
  const deferredSlots=new Set((input.deferredTaskKeys||[]).map(key=>key.split(':').slice(0,4).join(':')));
  const days:HybridDay[]=[];
  for(let offset=0;offset<(input.windowDays??7);offset++){
    const date=shiftPlanDay(input.today,offset),capacityMinutes=availabilityMinutesForDate(availability,date);
    const fixed=fixedTasks.filter(task=>task.date===date),fixedMinutes=fixed.reduce((sum,task)=>sum+minutes(task.minutes),0);
    const active=input.deadlines.filter(deadline=>deadline.status==='ready'&&deadline.date!>date);
    const allAvailable=input.questions.filter(question=>active.some(deadline=>deadline.targetId===question.targetId));
    const available=allAvailable.filter(question=>{
      if(!question.repetition)return true;
      const observation=hybridQuestionObservation(question,diagnostics,date);
      if(!observation.unseen&&!observation.due)return false;
      const lastPlanned=questionDates.get(questionScopeKey(question));
      return !lastPlanned||question.repetition.enabled&&daysBetween(lastPlanned,date)>=question.repetition.intervalDays;
    });
    const areas=[...new Set(available.map(question=>question.area).filter((area):area is string=>Boolean(area)))].sort();
    const fixedAreas=[...new Set(fixed.filter(task=>!task.manual).map(task=>task.area||allAvailable.find(question=>question.id===task.questionId&&question.targetId===task.targetId)?.area).filter((area):area is string=>Boolean(area)))];
    const repairAreas=[...new Set(available.filter(question=>question.rehearsal?.reportId&&hybridQuestionObservation(question,diagnostics,date).needsReview).map(question=>question.area).filter((area):area is string=>Boolean(area)))].sort();
    const area=fixedAreas[0]||repairAreas[offset%Math.max(1,repairAreas.length)]||areas[Math.abs(daysBetween(availability?.startDate||input.today,date))%Math.max(1,areas.length)];
    const eligible=area?available.filter(question=>question.area===area):available;
    const tasks=[...fixed];let budget=Math.max(0,capacityMinutes-fixedMinutes),sequence=fixed.length?Math.max(...fixed.map(task=>task.sequence??0))+1:0;
    const observations=eligible.map(question=>hybridQuestionObservation(question,diagnostics,date));
    const allocation=hybridAllocation(date,eligible,active,diagnostics,policy);
    const evidence=observations.filter(observation=>observation.needsReview).length,unseen=observations.filter(observation=>observation.unseen).length;
    const first=eligible.some(question=>diagnostics[question.targetId]?.state!=='completed');
    const initial=budget;
    const slots:Array<{kind:HybridTaskKind;minutes:number;assignment?:HybridAssignment}>=[];
    if(eligible.length&&budget&&area){
      // Reading and choice practice lead into a required video answer. Keep space
      // for that answer even on a short day; never substitute chat for it.
      const done=(kinds:HybridTaskKind[])=>fixed.some(task=>!task.manual&&kinds.includes(task.kind));
      const reserve=done(['focus','mixed','diagnostic','recall'])?0:Math.min(policy.videoMinimumMinutes,budget);
      let left=budget-reserve;
      const allocate=(kind:HybridTaskKind,wanted:number)=>{const amount=Math.min(left,wanted);if(amount>0){slots.push({kind,minutes:amount});left-=amount;}};
      if(!done(['reading']))allocate('reading',Math.max(2,Math.round(budget*policy.readingShare)));
      if(!done(['quiz'])&&eligible.some(question=>question.quiz))allocate('quiz',Math.max(2,Math.round(budget*policy.quizShare)));
      const assignment=(input.assignments||[]).find(item=>!assigned.has(item.id)&&item.minutes<=Math.max(0,left-5)&&eligible.some(question=>question.targetId===item.targetId&&question.id===item.questionId&&question.sourceType===item.sourceType&&question.sourceVersion===item.sourceVersion));
      if(assignment){slots.push({kind:'assignment',minutes:assignment.minutes,assignment});assigned.add(assignment.id);left-=assignment.minutes;}
      const review=!done(['review'])&&left>=policy.reflectionMinutes?Math.min(policy.reflectionMinutes,left):0;left-=review;
      const videoKind=allocation.mode==='rehearsal'?'mixed':'focus';
      if(reserve+left>0)slots.push({kind:videoKind,minutes:reserve+left});
      if(review)slots.push({kind:'review',minutes:review});
    }else if(eligible.length&&budget){
      const routineCapacity=Math.max(0,capacityMinutes-fixed.filter(task=>task.manual).reduce((sum,task)=>sum+task.minutes,0));
      const reviewMinutes=routineCapacity>=50?10:routineCapacity>=20?5:0;
      const learning=routineCapacity-reviewMinutes;
      const startMinutes=learning>=30?Math.round(learning*.2):Math.min(5,learning);
      const mixedMinutes=learning>=30?Math.round(learning*allocation.mixedShare):0;
      const focusMinutes=learning-startMinutes-mixedMinutes;
      const done=(kinds:HybridTaskKind[])=>fixed.filter(task=>!task.manual&&kinds.includes(task.kind)).reduce((sum,task)=>sum+task.minutes,0);
      let remainingAllocation=budget;
      const allocate=(kind:HybridTaskKind,desired:number)=>{const amount=Math.min(remainingAllocation,Math.max(0,desired));if(amount)slots.push({kind,minutes:amount});remainingAllocation-=amount;};
      // A completed diagnosis already fills today's opening block; replanning cannot insert another one.
      allocate(first?'diagnostic':'recall',startMinutes-done(['diagnostic','recall']));
      let focusLeft=Math.min(remainingAllocation,Math.max(0,focusMinutes-done(['focus','quiz','assignment'])));
      const assignment=(input.assignments||[]).find(assignment=>!assigned.has(assignment.id)&&assignment.minutes<=focusLeft&&eligible.some(question=>question.targetId===assignment.targetId&&question.id===assignment.questionId&&question.sourceType===assignment.sourceType&&question.sourceVersion===assignment.sourceVersion));
      if(assignment){slots.push({kind:'assignment',minutes:assignment.minutes,assignment});assigned.add(assignment.id);focusLeft-=assignment.minutes;remainingAllocation-=assignment.minutes;}
      if(!done(['quiz'])&&eligible.some(question=>question.quiz)&&focusLeft>=5){const amount=Math.min(10,focusLeft);slots.push({kind:'quiz',minutes:amount});focusLeft-=amount;remainingAllocation-=amount;}
      const ordinaryFocus=focusLeft;
      while(focusLeft>0){const size=Math.min(25,focusLeft);slots.push({kind:'focus',minutes:size});focusLeft-=size;}
      remainingAllocation-=ordinaryFocus;
      allocate('mixed',mixedMinutes-done(['mixed']));
      allocate('review',reviewMinutes-done(['review']));
    }
    const todayUsed=new Map<string,number>(),fixedFocusKeys=new Set<string>();let previous:HybridQuestion|undefined;
    for(const task of fixed){
      if(['break','review'].includes(task.kind)||!task.targetId)continue;
      counts.set(task.targetId,(counts.get(task.targetId)||0)+minutes(task.minutes)/10);
      if(!task.questionId)continue;
      const key=questionScopeKey({...task,id:task.questionId});
      todayUsed.set(key,(todayUsed.get(key)||0)+1);questionDates.set(key,date);
      if(task.kind==='focus')fixedFocusKeys.add(key);
    }
    for(const slot of slots){
      const rank=(question:HybridQuestion)=>{
        const observation=hybridQuestionObservation(question,diagnostics,date),deadline=active.find(item=>item.targetId===question.targetId)!;
        const schoolLoad=counts.get(question.targetId)||0,questionLoad=todayUsed.get(questionScopeKey(question))||0;
        const urgency=16/Math.sqrt(Math.max(1,daysBetween(date,deadline.date!)));
        let score=urgency-schoolLoad*2-questionLoad*12+(question.priority||0)*2+Math.min(5,(question.volume||0)/250);
        if(slot.kind==='diagnostic')score+=Number(observation.unseen)*18+Number(diagnostics[question.targetId]?.state!=='completed')*8;
        if(slot.kind==='recall')score+=Number(observation.due)*12+Number(observation.needsReview)*6-Number(observation.unseen)*8;
        if(slot.kind==='focus')score+=Number(observation.needsReview)*18+Number(observation.unseen)*7+Number(Boolean(question.rehearsal?.reportId)&&observation.needsReview)*30;
        if(slot.kind==='mixed')score+=Number(!observation.unseen)*9+Number(question.category!=='personal')*2;
        const last=questionDates.get(questionScopeKey(question));
        if(last===date)score-=10;
        return score;
      };
      const pool=eligible.filter(question=>slot.kind!=='quiz'||question.quiz),otherFocus=slot.kind==='focus'?pool.filter(question=>!fixedFocusKeys.has(questionScopeKey(question))):[];
      const question=slot.assignment?eligible.find(question=>question.id===slot.assignment!.questionId&&question.targetId===slot.assignment!.targetId&&question.sourceType===slot.assignment!.sourceType&&question.sourceVersion===slot.assignment!.sourceVersion):slot.kind==='break'||slot.kind==='review'?previous||eligible[0]:[...(otherFocus.length?otherFocus:pool)].sort((a,b)=>rank(b)-rank(a)||a.id.localeCompare(b.id))[0];
      if(!question)continue;
      const observation=hybridQuestionObservation(question,diagnostics,date),diagnosed=diagnostics[question.targetId]?.state==='completed';
      const titles:Record<HybridTaskKind,string>={reading:`${area||'학생부'} 기록 복습`,diagnostic:'답변 연습 · 활동·개념·지원 동기 확인',recall:'이전 답변 자료 없이 다시 꺼내기',quiz:'10초 퀴즈',assignment:slot.assignment?.title||'받은 과제',focus:allocation.stage==='final_review'?'최종 보완':'화상 답변 연습',mixed:'실전 화상 면접',review:'오늘 정리',break:'잠시 쉬기'};
      const reasons:Record<HybridTaskKind,string>={reading:'오늘 질문에 연결된 활동과 학생부 원문을 확인해요.',diagnostic:'아직 확인하지 않은 영역을 짧게 답해요. 미응시를 약점으로 판단하지 않아요.',recall:observation.reason,quiz:'정답과 원문 근거가 확인된 4지선다 문항을 풀어요.',assignment:'받은 과제를 오늘 학습 시간 안에서 진행해요. 제출한 답변으로 수행을 확인해요.',focus:`${observation.reason} ${allocation.reason}`,mixed:`오늘 영역의 활동을 학교 질문에 연결해 답해요. ${allocation.reason}`,review:'오늘 남긴 답변과 보완한 한 가지를 확인하고, 내일 다시 답할 질문을 골라요.',break:'오늘 설정한 총 시간 안에서 휴식을 함께 배치했어요.'};
      const task:HybridTask={id:taskKey(date,slot.kind,sequence,question),title:(slot.kind==='focus'?`${titles.focus} · ${question.title}`:titles[slot.kind]).slice(0,160),kind:slot.kind,stage:allocation.stage,minutes:slot.minutes,reason:reasons[slot.kind],targetId:question.targetId,questionId:question.id,sourceType:question.sourceType,sourceVersion:question.sourceVersion,activityIds:question.activityIds,href:question.href||null,status:'pending',date,sequence:sequence++,pressure:['focus','recall','diagnostic'].includes(slot.kind)&&policy.practiceQuestionMode==='pressure',area:question.area,activityTitles:question.activityTitles};
      if(slot.kind==='quiz')task.practice=question.quiz;
      if(slot.assignment){task.id+=':'+slot.assignment.id;task.practice={kind:'assignment',assignmentId:slot.assignment.id};}
      // A task explicitly moved in the calendar cannot count as practice or workload on its old day.
      if(deferredKeys.has(task.id)||deferredSlots.has(task.id.split(':').slice(0,4).join(':')))continue;
      tasks.push(task);budget-=task.minutes;
      if(!['break','review'].includes(slot.kind)){const key=questionScopeKey(question);counts.set(question.targetId,(counts.get(question.targetId)||0)+slot.minutes/10);todayUsed.set(key,(todayUsed.get(key)||0)+1);questionDates.set(key,date);previous=question;}
    }
    const warnings=[...(allAvailable.length&&!available.length?['설정한 반복 간격에 맞춰 다음 훈련을 기다리고 있어요. 필요하면 질문의 반복 설정을 바꿀 수 있어요.']:[]),...(fixedAreas.length>1?['옮긴 훈련에 여러 영역이 포함돼 있어요. 날짜를 나누면 한 영역에 집중할 수 있어요.']:[]),...(capacityMinutes&&tasks.length&&!tasks.some(task=>!task.manual&&['focus','mixed','diagnostic','recall'].includes(task.kind))?['필수 화상을 배치할 시간이 부족해요. 기존 일정이나 학습 시간을 조정해 주세요.']:[]),...(area&&eligible.length&&!eligible.some(question=>question.quiz)?['이 영역의 객관식 문항은 근거 확인 후 준비돼요. 답변형 퀴즈로 대체하지 않아요.']:[])];
    const focus=area?`오늘은 ${area}`:evidence?'도움·시간·직접 선택한 보완점 다시 확인':unseen?'아직 확인하지 않은 활동과 개념 살피기':'이전 답변 회상과 여러 주제 연결';
    tasks.sort((a,b)=>(a.sequence??0)-(b.sequence??0));
    days.push({date,capacityMinutes,plannedMinutes:tasks.reduce((sum,task)=>sum+task.minutes,0),remainingMinutes:tasks.filter(task=>task.status!=='completed'&&!task.completed&&!task.performedAt).reduce((sum,task)=>sum+task.minutes,0),unallocatedMinutes:Math.max(0,budget),tasks,focus,allocation,area,activityTitles:[...new Set(eligible.flatMap(question=>question.activityTitles||[]))],warnings,reason:!availability?'학습 가능한 시간을 먼저 설정해 주세요.':!capacityMinutes?'학습하지 않는 날로 설정했어요.':!eligible.length?(allAvailable.length?'반복 설정에 따라 다음 학습 날짜를 기다리고 있어요.':'정확한 일정과 연습할 질문을 확인하면 계획을 만들 수 있어요.'):fixedMinutes>=capacityMinutes?'수동·진행·완료 계획을 보존해 추가 일정을 배치하지 않았어요.':`${allocation.reason} ${initial}분 안에서 기록 복습과 화상 면접을 함께 배치했어요.`});
  }
  return days;
}
