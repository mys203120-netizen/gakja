import type {HybridQuestion} from './hybrid-training';
type Entity=Record<string,any>;
export function recordArea(value:unknown){
 const area=typeof value==='string'?value.trim():'';
 if(/세부능력|세특|교과/.test(area))return '세특';
 if(/자율/.test(area))return '자율활동';
 if(/동아리/.test(area))return '동아리활동';
 if(/진로/.test(area))return '진로활동';
 if(/봉사/.test(area))return '봉사활동';
 if(/독서/.test(area))return '독서활동';
 return area||null;
}
const priority:Record<string,number>={S:5,A:4,B:3,C:2,F:1};
/** Missing domains remain explicitly unclassified; an interest label is not a record domain. */
export function questionDomain(question:HybridQuestion,learning:Entity){
 const activities:Entity[]=(learning.activities||[]).filter((activity:Entity)=>question.activityIds.includes(activity.id));
 const ranked=activities.map(activity=>{
  const assignment=activity.priority_assignments?.find((item:Entity)=>item.support_target_id===question.targetId);
  const source=(learning.source_refs||[]).find((source:Entity)=>activity.source_ref_ids?.includes(source.id)&&source.area);
  return {activity,area:recordArea(activity.area)||recordArea(source?.area),priority:priority[assignment?.priority||activity.interview_priority]||0};
 }).sort((a,b)=>b.priority-a.priority||String(a.activity.id).localeCompare(String(b.activity.id)));
 const primary=ranked.find(item=>item.area);
 return {area:primary?.area||(activities.length?'영역 확인 필요':'공통 질문'),priority:ranked[0]?.priority||0,
  activityTitles:activities.map(activity=>String(activity.title)),volume:activities.reduce((sum,activity)=>sum+String(activity.activity_summary||'').length,0)};
}
