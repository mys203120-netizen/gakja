/** Pure synthetic demo rows. This module does not connect to a database or call an AI provider. */
import { createHash } from 'node:crypto';
import { eligibleQuizItems, quizOutcome, quizPracticeIdentity } from '../../apps/web/src/lib/quiz-rules.ts';
import { questionPracticeState } from '../../apps/web/src/lib/learning-flow-view.ts';
import { todayLearningStage } from '../../apps/web/src/lib/today-learning-stage.ts';

type Row = Record<string, any>;
export type HarinPracticeExample = {
  questionId:string; activityIds?:string[]; earlyAnswer:string; assistedAnswer:string;
  delayedAnswer:string; reviewFocus:string|string[]; synthetic?:boolean;
};
export type HarinTenDayJourneyInput = {
  studentId:string; target:Row; learning:Row; contentVersion:number; packageId?:string;
  endDate?:string; dayStart?:string; id?:(label:string)=>string;
  practiceExamples?:HarinPracticeExample[]|Record<string,HarinPracticeExample>;
  summarizeStudy?:(events:Row[])=>Row;
  studySummary?:(events:Row[])=>Row;
};

const scenario='harin-ten-days';
const notice='합성 예시 학습 기록입니다. 실제 학생의 수행·AI 평가·음성 측정 결과가 아닙니다.';
const marked=(value:Row):Row=>({...structuredClone(value),synthetic:true,demoScenario:scenario});
const dateOnly=(value:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Error('Use a valid YYYY-MM-DD demo date.');
  return value;
};
const shiftDay=(day:string,offset:number)=>new Date(Date.parse(day+'T00:00:00Z')+offset*86_400_000).toISOString().slice(0,10);
const instant=(day:string,hour:number,minute=0,second=0)=>new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}+09:00`).toISOString();
const later=(at:string,minutes:number)=>new Date(Date.parse(at)+minutes*60_000).toISOString();
const stableUuid=(key:string)=>{
  const hex=createHash('sha256').update(key).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);
  const value=hex.join('');return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
};

export function createHarinTenDayJourney(input:HarinTenDayJourneyInput) {
  const {studentId,learning,contentVersion}=input;
  const summarize=input.summarizeStudy||input.studySummary;
  if(!summarize)throw new Error('Inject the application studySummary function as summarizeStudy.');
  if(!studentId||!input.target?.id||!Number.isInteger(contentVersion)||contentVersion<1)throw new Error('A student, owned target snapshot and published content version are required.');
  const endDate=dateOnly(input.endDate||'2026-10-18'),dayStart=dateOnly(input.dayStart||shiftDay(endDate,-9));
  if(shiftDay(dayStart,9)!==endDate)throw new Error('The demo spans exactly ten KST calendar days.');
  const id=(label:string)=>input.id?.(`${scenario}:${label}`)||stableUuid(`${studentId}:${endDate}:${scenario}:${label}`);
  const target=marked(input.target);
  const questions:Row[]=(learning.questions||[]).filter((question:Row)=>!question.support_target_ids?.length||question.support_target_ids.includes(target.id));
  if(questions.length<4)throw new Error('At least four reviewed questions are required, including one unattempted question.');
  const untouched=questions.at(-1)!,representative=questions[0];
  const answerPool=eligibleQuizItems(learning as any,'answer').filter(item=>item.kind!=='choice'&&item.question_id!==untouched.id).slice(0,4);
  const choicePool=eligibleQuizItems(learning as any,'choice').filter(item=>item.question_id!==untouched.id&&item.linked_question_id!==untouched.id).slice(0,2);
  if(!answerPool.some(item=>item.question_id===representative.id))throw new Error('The representative question requires an approved written practice item.');
  if(answerPool.length<3||!choicePool.length)throw new Error('The ten-day fixture requires at least three written items and one reviewed concept choice.');
  const examples=Array.isArray(input.practiceExamples)?input.practiceExamples:Object.values(input.practiceExamples||{});
  const byQuestion=new Map(examples.map(example=>[example.questionId,example]));
  const modelFor=(question:Row)=>String((learning.answer_scripts||[]).find((script:Row)=>script.question_id===question.id)?.text||'');
  const exampleFor=(question:Row):HarinPracticeExample=>{
    const authored=byQuestion.get(question.id);if(authored)return authored;
    const model=modelFor(question);if(!model.trim())throw new Error(`Missing an authored demo answer for ${question.id}.`);
    return {questionId:question.id,earlyAnswer:model.split(/(?<=[.!?。])\s+/)[0],assistedAnswer:model,delayedAnswer:model,reviewFocus:'내 역할과 기록에서 확인할 수 있는 근거를 구분해 말했는지 확인해 보세요.'};
  };
  const tables:Record<string,Row[]>={quiz_sessions:[],quiz_responses:[],memory_attempts:[],interview_sessions:[],interview_turns:[],interview_reports:[],study_sessions:[],study_session_events:[]};
  const attempts:Row[]=[];
  const snapshotItem=(item:Row)=>marked({...item,target_id:target.id,target_snapshot:target,source_kind:'personal',source_type:'personal',common_revision:null,
    ...(item.question_snapshot?{question_snapshot:marked(item.question_snapshot)}:{})});
  const scope={target_id:target.id,target_snapshot:target,source_kind:'personal',source_type:'personal',common_revision:null};
  const phase=(day:number)=>day===0?'early':day<4?'assisted':'delayed';
  const answerFor=(question:Row,day:number)=>{
    const example=exampleFor(question);return phase(day)==='early'?example.earlyAnswer:phase(day)==='assisted'?example.assistedAnswer:example.delayedAnswer;
  };
  const event=(studyId:string,kind:string,sourceId:string,at:string,data:Row)=>{
    const row={id:id(`event:${kind}:${sourceId}`),student_id:studentId,session_id:studyId,kind,source_id:sourceId,created_at:at,data:marked(data)};
    tables.study_session_events.push(row);return row;
  };
  const quiz=(day:number,date:string,mode:'choice'|'answer',studyId:string)=>{
    const sessionId=id(`quiz:${day}:${mode}`),started=instant(date,mode==='choice'?8:17,mode==='choice'?10:0);
    const selected=mode==='choice'?choicePool:[...answerPool.filter(item=>day!==9||item.question_id!==representative.id),...(day===9?answerPool.filter(item=>item.question_id===representative.id):[])];
    const items=selected.map(snapshotItem),helpEvents:Row[]=[],assistedIndices:number[]=[],hintIndices:number[]=[];
    items.forEach((item,index)=>{
      const at=later(started,(index+1)*(mode==='choice'?2:5)),responseId=id(`response:${day}:${mode}:${index}`);
      const identity=quizPracticeIdentity(item as any),question=questions.find(question=>question.id===identity.questionId)||questions.find(question=>question.id===item.linked_question_id);
      if(!question)throw new Error(`Missing the source question for ${item.id}.`);
      const assisted=phase(day)==='assisted',hint=assisted&&day===2,helpKind=hint?'hint':'evidence';
      const receipts=assisted?[marked({kind:helpKind,itemIndex:index,at:later(at,-1),receiptId:id(`help:${day}:${mode}:${index}`),phase:'before_answer',status:'completed'})]:[];
      if(assisted){assistedIndices.push(index);helpEvents.push(...receipts);if(hint)hintIndices.push(index);}
      const help=marked({assistance_recorded:true,assisted,hint_used:hint,ai_assisted:false,helpKinds:assisted?[helpKind]:[],helpEvents:receipts});
      const wrongOption=item.options?.find((option:Row)=>option.id!==item.correct_option_id)?.id;
      const selectedOption=mode==='choice'?(day===0?wrongOption:item.correct_option_id):null;
      const response=mode==='choice'?'':item.kind==='short_answer'&&item.evaluation_method==='reviewed_correct_answer'&&day>0
        ?String(item.accepted_answers?.[0]||(item.numeric_answer?`${item.numeric_answer.value}${item.numeric_answer.unit||''}`:answerFor(question,day))):answerFor(question,day);
      const outcome=quizOutcome(item as any,mode,response,selectedOption,false);
      const recallState=outcome===null?(day===0?'uncertain':'remembered'):null;
      const rating=outcome===false||recallState==='uncertain'?'again':'good';
      const correctAnswer=mode==='choice'?item.options.find((option:Row)=>option.id===item.correct_option_id)?.text:null;
      const data=marked({question_id:identity.questionId,practice_question_id:identity.questionId,practice_kind:identity.practiceKind,practice_prompt:identity.practicePrompt,linked_question_id:identity.linkedQuestionId,
        prompt:item.prompt,activity_ids:item.activity_ids,content_version:contentVersion,recording_id:null,correct_answer:correctAnswer,...help,recall_state:recallState,
        requestId:id(`request:${day}:${mode}:${index}`),model_answer:mode==='choice'?null:item.modelAnswer,source_quotes:item.sourceQuotes||[],keywords:item.memory_keywords||[],...scope,demoNotice:notice});
      tables.quiz_responses.push({id:responseId,student_id:studentId,session_id:sessionId,item_index:index,memory_item_id:item.id,response,selected_option_id:selectedOption,outcome,timed_out:false,elapsed_ms:mode==='choice'?8_000:150_000,hint_used:hint,rating,data,created_at:at});
      // Match /api/quiz's saved rating intervals. The last recall's unapplied study event drives today's CTA.
      const due=later(at,rating==='again'?10:3*24*60);
      tables.memory_attempts.push({id:id(`memory:${day}:${mode}:${index}`),student_id:studentId,memory_item_id:item.id,rating,due_at:due,created_at:at,
        data:marked({answer:response||selectedOption,question_id:identity.questionId,practice_question_id:identity.questionId,correct:outcome,...help,recall_state:recallState,elapsed_seconds:mode==='choice'?8:150,content_version:contentVersion,
          evaluation_method:outcome===null?'self_check':'reviewed_correct_answer',quiz_session_id:sessionId,quiz_response_id:responseId,timed_out:false,recording_id:null,...scope})});
      event(studyId,'quiz_response',responseId,at,{quizSessionId:sessionId,memoryItemId:item.id,questionId:identity.questionId,practiceKind:identity.practiceKind,practicePrompt:identity.practicePrompt,linkedQuestionId:identity.linkedQuestionId,
        activityIds:item.activity_ids,prompt:item.prompt,contentVersion,mode,outcome,verified:outcome!==null,evaluationMethod:outcome===null?'self_check':'reviewed_correct_answer',rating,hintUsed:hint,...help,recall_state:recallState,correctAnswer,timedOut:false,elapsedMs:mode==='choice'?8_000:150_000,
        response:mode==='choice'?item.options.find((option:Row)=>option.id===selectedOption)?.text||'':response,audioId:null,audioUrl:null,...scope});
      if(mode==='answer')attempts.push({id:`quiz:${responseId}`,question_id:identity.questionId,revision_kind:'quiz_answer',script:response,created_at:at,content_version:contentVersion,...scope,...help});
    });
    const finished=later(started,items.length*(mode==='choice'?2:5)+1);
    tables.quiz_sessions.push({id:sessionId,student_id:studentId,mode,content_version:contentVersion,state:'completed',items,current_index:items.length,revision:items.length*2+1,
      deadline_at:null,remaining_ms:null,item_started_at:null,item_elapsed_ms:0,created_at:started,updated_at:finished,finished_at:finished,
      metadata:marked({timed:false,focus:'today',selectionKey:`${scenario}:${day}:${mode}`,reason:'합성 예시 · 같은 질문의 회상 연습',hintIndices,assistedIndices,helpEvents,assistance_recorded:true,targetId:target.id,targetSnapshot:target,targetSnapshotStale:false,activityId:null,demoNotice:notice})});
    return finished;
  };
  const interviewDays=new Set([0,1,2,3,4,5,7,8]);
  const interviewQuestions=answerPool.map(item=>questions.find(question=>question.id===item.question_id)!).filter(question=>!question.question_types?.includes('concept'));
  if(interviewQuestions.length<2)throw new Error('At least two personal experience questions are needed for the interview examples.');
  const interview=(day:number,date:string,studyId:string)=>{
    const sessionId=id(`interview:${day}`),started=instant(date,17,30),count=day%2?3:2;
    const queue=Array.from({length:Math.min(count,interviewQuestions.length)},(_,index)=>interviewQuestions[(day+index)%interviewQuestions.length]);
    // The representative question has several saved interview comparisons, including before the final independent recall.
    if(day===8&&!queue.some(question=>question.id===representative.id))queue[queue.length-1]=representative;
    const assisted=phase(day)==='assisted',context=marked({ownerStudentId:studentId,packageId:input.packageId||learning.package_id||learning.packageId||'',contentVersion:String(contentVersion),sourceKind:'personal',targetId:target.id,target,activityId:null,questionId:null,
      studentContext:learning.student_context||{},activities:(learning.activities||[]).map(marked),questions:queue.map(marked),answerScripts:(learning.answer_scripts||[]).filter((script:Row)=>queue.some(question=>question.id===script.question_id)).map(marked),sources:(learning.source_refs||[]).map(marked),studentConfirmations:[]});
    const turns=queue.map((question,index)=>{
      const turnId=id(`turn:${day}:${index}`),created=later(started,index*4),at=later(started,(index+1)*4),answer=answerFor(question,day);
      const receipt=assisted?marked({kind:'evidence',receiptId:id(`interview-help:${day}:${index}`),at:later(at,-1),status:'completed'}):null;
      const data=marked({question:question.prompt,rootQuestionId:question.id,questionKind:'published',answer,originalAnswer:answer,feedback:null,answerFinalized:true,answeredAt:at,
        answerRevisions:[marked({revision:1,text:answer,kind:'submitted_answer',at})],contentVersion:String(contentVersion),sourceType:'personal',sourceSnapshot:null,commonRevision:null,practiceLabel:null,
        answerElements:question.answer_elements||[],sourceIds:question.source_ref_ids||[],rootIndex:index,followupDepth:0,speakerId:'A',assisted,assistance_recorded:true,hint_used:false,helpKinds:assisted?['evidence']:[],helpEvents:receipt?[receipt]:[],draft:'',requestId:id(`interview-request:${day}:${index}`),demoNotice:notice});
      const turn={id:turnId,student_id:studentId,session_id:sessionId,question_id:question.id,data,created_at:created};tables.interview_turns.push(turn);
      event(studyId,'interview_answer',turnId,at,{sessionId,kind:'chat',questionId:question.id,question:question.prompt,answer,assistance_recorded:true,assisted,hintUsed:false,hint_used:false,helpKinds:assisted?['evidence']:[],contentVersion,targetId:target.id,targetSnapshot:target,sourceKind:'personal',sourceType:'personal',commonRevision:null});
      attempts.push({id:`${turnId}:revision:1`,question_id:question.id,revision_kind:'interview_answer',script:answer,created_at:at,content_version:contentVersion,...scope,assisted,assistance_recorded:true,hint_used:false,ai_assisted:false});
      return turn;
    });
    const finished=later(started,turns.length*4+1);
    tables.interview_sessions.push({id:sessionId,student_id:studentId,kind:'chat',mode:'basic',target_id:target.id,content_version:contentVersion,state:'completed',created_at:started,updated_at:finished,completed_at:finished,
      data:marked({context,questionQueue:queue.map(marked),index:turns.length,questionCount:turns.length,followups:false,pressure:false,feedbackTiming:'end',interviewerReactions:false,panelists:[marked({id:'A',name:'예시 면접관',role:'질문 확인'})],elapsedMs:turns.length*4*60_000,activeSince:null,timerLeaseUntil:null,paused:true,processing:false,assisted,demoNotice:notice})});
    tables.interview_reports.push({id:id(`interview-report:${day}`),student_id:studentId,session_id:sessionId,created_at:finished,data:marked({feedbackKind:'self_check',kind:'chat',mode:'basic',contentVersion:String(contentVersion),targetId:target.id,
      aiStatus:'not_requested',summary:`[합성 예시] ${turns.length}개 질문에 답변을 남기고, 역할과 근거가 드러나는 문장을 직접 점검했어요.`,metrics:marked({answeredQuestions:turns.length,recordedCharacters:turns.reduce((sum,turn)=>sum+turn.data.answer.length,0),speechMeasurement:'not_measured'}),
      sections:turns.map(turn=>{const question=questions.find(question=>question.id===turn.question_id)!;return marked({turnId:turn.id,questionId:question.id,question:question.prompt,answer:turn.data.answer,sourceType:'personal',commonRevision:null,sourceSnapshot:null,
        answerElements:question.answer_elements||[],activityIds:question.activity_ids||[],assisted,questionKind:'published',speakerId:'A',interviewerReaction:null,reactionRevisions:[],selfCheck:['질문에 직접 답했나요?','내가 실제로 한 행동이 드러나나요?','주장에 연결되는 근거를 말했나요?',`[예시 점검] ${[exampleFor(question).reviewFocus].flat().join(' · ')}`]});}),
      nextQuestions:queue.map(question=>question.id),durationSeconds:turns.length*240,assistance_recorded:true,assisted,helpKinds:assisted?['evidence']:[],actualRootQuestions:turns.length,actualFollowups:0,transcriptRevision:0,reportRevision:1,revisions:[],demoNotice:notice})});
    return finished;
  };
  for(let day=0;day<10;day++){
    const date=shiftDay(dayStart,day);
    for(const mode of ['choice','answer'] as const){
      const studyId=id(`study:${day}:${mode}`),started=instant(date,mode==='choice'?8:17,mode==='choice'?10:0);
      let ended=quiz(day,date,mode,studyId);
      if(mode==='answer'&&interviewDays.has(day))ended=interview(day,date,studyId);
      const events=tables.study_session_events.filter(row=>row.session_id===studyId);
      const report=marked({...summarize(events),events,demoNotice:notice});
      tables.study_sessions.push({id:studyId,student_id:studentId,state:'finalized',started_at:started,last_seen_at:ended,last_activity_at:events.at(-1)!.created_at,closing_at:null,ended_at:ended,finish_reason:'manual',report});
    }
  }
  const representativeState=questionPracticeState(attempts,representative,target,contentVersion);
  const currentStage=todayLearningStage({checkingRecord:false,recallAvailable:true,interviewAvailable:true,attempts:representativeState.attempts});
  if(currentStage!=='interview'||representativeState.latest?.revision_kind!=='quiz_answer'||representativeState.latest?.assisted)throw new Error('The final representative answer must be an independent recall opening a fresh interview.');
  if(attempts.some(attempt=>attempt.question_id===untouched.id))throw new Error('The reserved question must remain unattempted.');
  for(const rows of Object.values(tables))for(const row of rows)if(row.student_id!==studentId)throw new Error('Every generated row must belong to the selected student.');
  return {tables,summary:marked({studentId,targetId:target.id,contentVersion,dayStart,endDate,days:10,counts:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length])),representativeQuestionId:representative.id,unattemptedQuestionId:untouched.id,
    currentStage,latestIndependentRecallAt:representativeState.latest.created_at,assistedResponses:tables.quiz_responses.filter(row=>row.data.assisted).length,independentResponses:tables.quiz_responses.filter(row=>!row.data.assisted&&row.data.assistance_recorded).length,
    aiRequests:0,audioRecordings:0,paidUsageRecords:0,demoNotice:notice})};
}
