import {koreaToday} from './planner-model';

type AgendaPlan={completed?:boolean;performedAt?:string|null;overdue?:boolean};
type AgendaTask={state?:string;due_at?:string|null};
/** Keep the summary and its rows on the same date and completion rules. */
export function dashboardAgenda<P extends AgendaPlan,T extends AgendaTask>(plans:P[],tasks:T[],today:string){
  const current=plans.filter(plan=>!plan.overdue),overdue=plans.filter(plan=>plan.overdue&&!plan.completed&&!plan.performedAt);
  const currentTasks:T[]=[],pastTasks:T[]=[],upcomingTasks:T[]=[],reviewTasks:T[]=[];
  for(const task of tasks){
    if(['reviewed','completed','cancelled'].includes(task.state||''))continue;
    if(task.state==='submitted'){reviewTasks.push(task);continue;}
    const due=task.due_at?new Date(task.due_at):null;
    const day=due&&Number.isFinite(due.getTime())?koreaToday(due):null;
    if(day&&day<today)pastTasks.push(task);
    else if(day&&day>today)upcomingTasks.push(task);
    else currentTasks.push(task);
  }
  const byDeadline=(a:T,b:T)=>String(a.due_at||'9999').localeCompare(String(b.due_at||'9999'));
  currentTasks.sort(byDeadline);pastTasks.sort(byDeadline);upcomingTasks.sort(byDeadline);
  return {current,overdue,currentTasks,pastTasks,upcomingTasks,reviewTasks,remainingPlans:current.filter(plan=>!plan.completed&&!plan.performedAt).length};
}
