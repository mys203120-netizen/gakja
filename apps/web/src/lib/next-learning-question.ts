import { growthContextResolver, type GrowthVersion } from './learning-growth';

type LearningEvent = { kind:string; created_at:string|Date; data:Record<string,any>; [key:string]:any };
const timestamp=(event:LearningEvent)=>new Date(event.created_at).getTime();
const questionId=(event:LearningEvent)=>typeof event.data?.questionId==='string'&&event.data.questionId.trim()?event.data.questionId:'';
const savedText=(value:unknown)=>typeof value==='string'?Boolean(value.trim()):Array.isArray(value)?value.length>0:false;
const revision=(value:unknown)=>{
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))return undefined;
  const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:undefined;
};
const practiceContext=(event:LearningEvent):GrowthVersion=>{
  const value=event.data||{},target=value.targetSnapshot||value.target_snapshot||{};
  return {id:String(event.id||''),question_id:questionId(event),script:'',created_at:String(event.created_at),
    target_id:value.targetId||value.target_id||undefined,
    target_snapshot:{...target,department:target.department||target.major,admission_year:target.admission_year||target.year,admission_type:target.admission_type||target.track,interview_stage:target.interview_stage||target.stage},
    content_version:revision(value.contentVersion??value.content_version),common_revision:revision(value.commonRevision??value.common_revision),
    source_type:value.sourceType||value.source_type||((value.sourceKind||value.source_kind)==='common'?'common':undefined)};
};

/** Application is a completed step, not proof of mastery. Exact source IDs and original timestamps decide the next step. */
export function nextUnappliedQuestion(events:LearningEvent[]):LearningEvent|null {
  // Share the report's source/school identity rules. An unrelated personal publication cannot
  // clear an old recall, while common practice is tied to its own reviewed school revision.
  // Unknown stages may join one unambiguous saved stage; they never bridge distinct stages.
  const contexts=new Map(events.map(event=>[event,practiceContext(event)]));
  const resolveContext=growthContextResolver([...contexts.values()]);
  const practiceKey=(event:LearningEvent)=>JSON.stringify([questionId(event),resolveContext(contexts.get(event)!)]);
  const appliedAt=new Map<string,number>();
  for(const event of events){
    const id=questionId(event),at=timestamp(event);
    if(event.kind!=='interview_answer'||!id||!Number.isFinite(at)||event.data.invalidated===true||!savedText(event.data.answer||event.data.response))continue;
    const key=practiceKey(event);appliedAt.set(key,Math.max(appliedAt.get(key)??-Infinity,at));
  }
  const candidates=events.filter(event=>{
    const id=questionId(event),at=timestamp(event),value=event.data;
    if(!['quiz_response','assignment_submission'].includes(event.kind)||!id||!Number.isFinite(at))return false;
    const attempted=savedText(value.response)||savedText(value.answer)||Boolean(value.audioId)||Boolean(value.selectedOptionId)||typeof value.outcome==='boolean'||value.timedOut===true||value.cannotRecall===true;
    return attempted&&(appliedAt.get(practiceKey(event))??-Infinity)<=at;
  });
  return candidates.sort((a,b)=>timestamp(b)-timestamp(a)||String(b.id||'').localeCompare(String(a.id||'')))[0]||null;
}
