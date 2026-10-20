import {pathToFileURL} from 'node:url';
import {loadProjectEnv} from './load-env.mjs';

/** Run once per minute in the deployment's task runner; no browser-supplied call IDs. */
export async function cleanupInterviewRealtime({query,apiKey,request=fetch}){
  if(!apiKey?.trim())throw new Error('Realtime cleanup requires the server API credential.');
  const result=await query("select id,student_id,context_id from ai_usage_logs where feature='interview_realtime' and (status='cleanup_pending' or (status in ('connected','issued','failed') and created_at<now()-interval '4 minutes')) order by created_at limit 100");
  const rows=Array.isArray(result)?result:result.rows;let completed=0,failed=0,invalid=0;
  for(const row of rows){
    const id=/^interview-rt:[0-9a-f-]+:[0-9a-f-]+:\d+:[0-9a-f-]+:(rtc_[a-zA-Z0-9_-]{1,150})$/.exec(row.context_id)?.[1];
    if(!id){invalid++;continue;}
    try{
      await query("update ai_usage_logs set status='cleanup_pending' where id=$1 and student_id=$2 and feature='interview_realtime' and status!='completed'",[row.id,row.student_id]);
      const response=await request(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(id)}/hangup`,{method:'POST',headers:{Authorization:`Bearer ${apiKey.trim()}`},signal:AbortSignal.timeout(8000)});
      if(!response.ok&&![404,409].includes(response.status)){failed++;continue;}
      await query("update ai_usage_logs set status='completed',realtime_closed_at=coalesce(realtime_closed_at,now()),realtime_usage=realtime_usage||jsonb_build_object('observed_call_ms',greatest(0,extract(epoch from (now()-coalesce(realtime_issued_at,created_at)))*1000)::bigint) where id=$1 and student_id=$2 and feature='interview_realtime' and status in ('connected','issued','cleanup_pending','failed')",[row.id,row.student_id]);completed++;
    }catch{failed++;}
  }
  return {scanned:rows.length,completed,failed,invalid};
}

async function main(){
  loadProjectEnv();const {Pool}=await import('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
  try{const result=await cleanupInterviewRealtime({query:(sql,params)=>pool.query(sql,params),apiKey:process.env.OPENAI_API_KEY});console.log(JSON.stringify(result));if(result.failed||result.invalid)process.exitCode=1;}
  finally{await pool.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main().catch(()=>{console.error('Realtime cleanup could not finish. Check server task configuration.');process.exitCode=1;});
