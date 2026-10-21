type SummaryPlan={kind?:unknown;minutes?:unknown;target?:{minutes?:unknown;automaticPractice?:{minutes?:unknown;hybrid?:{kind?:unknown}}}};
export type TrainingPlanSummary={kind:string;label:string;count:number;minutes:number|null};

const categories=[['diagnostic','첫 진단'],['recall','누적 복습'],['quiz','퀴즈'],['assignment','받은 과제'],['focus','집중 보완'],['mixed','연결 면접'],['review','정리'],['study','공부'],['interview','모의면접'],['reading','읽기·영상'],['other','개인 학습']] as const;
const labels=new Map<string,string>(categories);
function knownMinutes(value:unknown):number|null{
  if(value===null||value===undefined||value==='')return null;
  const number=typeof value==='number'||typeof value==='string'?Number(value):NaN;
  return Number.isFinite(number)&&number>=0?number:null;
}

/** A weekly outline contains learning categories and time, never a repeated question or rest task. */
export function summarizeTrainingPlans(plans:readonly SummaryPlan[]):TrainingPlanSummary[]{
  const groups=new Map<string,TrainingPlanSummary>();
  for(const plan of plans){
    const automatic=plan.target?.automaticPractice;
    const original=String(automatic?.hybrid?.kind||plan.kind||'other');
    if(original==='break')continue;
    const kind=labels.has(original)?original:'other';
    const minutes=knownMinutes(automatic?.minutes??plan.minutes??plan.target?.minutes);
    const previous=groups.get(kind);
    if(previous){previous.count++;previous.minutes=previous.minutes===null||minutes===null?null:previous.minutes+minutes;}
    else groups.set(kind,{kind,label:labels.get(kind)!,count:1,minutes});
  }
  return categories.flatMap(([kind])=>{const group=groups.get(kind);return group?[group]:[];});
}
