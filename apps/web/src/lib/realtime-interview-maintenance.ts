import 'server-only';
import {query} from './db';
import {expireInterviewRealtimeCalls} from './realtime-interview';

type Maintenance={timer:ReturnType<typeof setInterval>;running:boolean};
const shared=globalThis as unknown as {gakjaInterviewRealtimeMaintenance?:Maintenance};
/** Persistent Node servers sweep orphaned calls even when the student never reconnects. */
export function startInterviewRealtimeMaintenance(){
  if(shared.gakjaInterviewRealtimeMaintenance||!process.env.OPENAI_API_KEY?.trim())return;
  const state={running:false,timer:undefined as unknown as ReturnType<typeof setInterval>};
  const sweep=async()=>{
    if(state.running)return;state.running=true;
    try{
      const students=await query("select distinct student_id from ai_usage_logs where feature='interview_realtime' and status='connected' and created_at<now()-interval '4 minutes' limit 100");
      for(const student of students)try{await expireInterviewRealtimeCalls(student.student_id);}catch{/* Retry this owned call on the next sweep. */}
    }catch{console.warn('Realtime interview maintenance will retry on the next sweep.');}
    finally{state.running=false;}
  };
  state.timer=setInterval(()=>{void sweep();},60_000);state.timer.unref?.();shared.gakjaInterviewRealtimeMaintenance=state;void sweep();
}
export function stopInterviewRealtimeMaintenance(){const state=shared.gakjaInterviewRealtimeMaintenance;if(!state)return;clearInterval(state.timer);delete shared.gakjaInterviewRealtimeMaintenance;}
