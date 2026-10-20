export type TrainingFlowTask={id:string;kind:string;title:string;minutes:number;status?:string;completed?:boolean;performedAt?:string|null;manual?:boolean;href?:string|null};

export const trainingTaskDone=(task:TrainingFlowTask)=>task.status==='completed'||Boolean(task.completed||task.performedAt);

/** Rest is not a lesson. Daily reflection follows the remaining learning tasks. */
export function trainingSequence<T extends TrainingFlowTask>(tasks:readonly T[]):T[]{
 return tasks.filter(task=>task.kind!=='break').sort((a,b)=>Number(a.kind==='review')-Number(b.kind==='review'));
}

/** Only a confirmed completed lesson may be skipped before fresh planning catches up. */
export function nextTrainingStep<T extends TrainingFlowTask>(tasks:readonly T[],completedPlanId?:string|null):T|null{
 return trainingSequence(tasks).find(task=>task.id!==completedPlanId&&!trainingTaskDone(task)&&(!task.manual||task.href))||null;
}

export function trainingStepHref(task:TrainingFlowTask){
 return task.manual?task.href||'/my':'/my/train?planId='+encodeURIComponent(task.id);
}
