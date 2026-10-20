import {checkOrigin,requireUser} from '@/lib/auth';
import {featureError,requireStudent} from '@/lib/ai';
import {closeInterviewRealtime,heartbeatInterviewRealtime,readRealtimeInterviewBody,realtimeInterviewCloseInput,realtimeInterviewEnabled,realtimeInterviewInput,REALTIME_INTERVIEW_MODEL,startInterviewRealtime} from '@/lib/realtime-interview';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=30;
const headers={'Cache-Control':'private, no-store'};
export async function GET(){try{const user=await requireUser();requireStudent(user);return Response.json({enabled:realtimeInterviewEnabled(),model:REALTIME_INTERVIEW_MODEL},{headers});}catch(error){const result=featureError(error);return Response.json({error:result.error,code:result.code},{status:result.status,headers});}}
async function handle(request:Request,operation:'start'|'close'|'heartbeat'){
  try{checkOrigin(request);const user=await requireUser();requireStudent(user);const body=await readRealtimeInterviewBody(request);
    if(operation==='start')return Response.json(await startInterviewRealtime(user.id,realtimeInterviewInput.parse(body),request.signal),{headers});
    const input=realtimeInterviewCloseInput.parse(body);if(operation==='heartbeat')return Response.json(await heartbeatInterviewRealtime(user.id,input),{headers});
    await closeInterviewRealtime(user.id,input);return Response.json({closed:true},{headers});
  }catch(error){const result=featureError(error);return Response.json({error:result.error,code:result.code},{status:result.status,headers});}
}
export const POST=(request:Request)=>handle(request,'start');export const DELETE=(request:Request)=>handle(request,'close');export const PATCH=(request:Request)=>handle(request,'heartbeat');
