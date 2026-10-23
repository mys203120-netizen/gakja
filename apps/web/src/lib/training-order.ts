type Task={id:string;kind:string;startedAt?:unknown;completed?:boolean};
/** Compare against the displayed order, rather than possibly sparse stored sequences. */
export function trainingOrderError(tasks:Task[],ids:string[]):string|null{
 if(new Set(ids).size!==ids.length||tasks.length!==ids.length||tasks.some(task=>!ids.includes(task.id)))return '오늘 계획이 바뀌었어요. 새 계획에서 순서를 바꿔 주세요.';
 const ordered=ids.map(id=>tasks.find(task=>task.id===id)!);
 if(ordered.some((task,index)=>task.kind==='review'&&index!==ordered.length-1))return '오늘 정리는 마지막에 두어 주세요.';
 if(tasks.some((task,index)=>(task.completed||task.startedAt)&&ids.indexOf(task.id)!==index))return '이미 시작하거나 마친 훈련의 순서는 유지해 주세요.';
 return null;
}
