import {getLearningHistoryPage} from '@/lib/learning-workflows';
import {requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query} from '@/lib/db';

export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(){
 try{
  const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정으로 이용해 주세요.');
  // Explicit export reads every owned page. Normal list bounds must never silently
  // truncate an export. The stream holds at most one 250-row database page.
  const sources=[
   ['answers','answer_revisions r join user_answers a on a.id=r.answer_id','r.*,a.question_id','a.student_id'],
   ['studyHistory','study_session_events r','r.*','r.student_id'],
   ['importedStudyHistory','study_imported_events r','r.*','r.student_id','occurred_at'],
   ['studyReports','study_sessions r','r.*','r.student_id','started_at'],
   ['interviewReports','interview_reports r','r.*','r.student_id'],
   ['interviews','interview_sessions r',"r.id,r.kind,r.mode,r.target_id,r.content_version,r.state,r.created_at,r.completed_at,jsonb_build_object('target',r.data->'context'->'target','trainingPurpose',r.data->'trainingPurpose') as context",'r.student_id'],
   ['memoryHistory','memory_attempts r','r.*','r.student_id'],
  ];
  const anchor=new Date().toISOString(),encoder=new TextEncoder();let sourceIndex=0,cursor:{at:string;id:string}|null=null,firstSource=true,firstRow=true,started=false,answerCursor:string|undefined;
  const stream=new ReadableStream<Uint8Array>({async pull(controller){try{
   if(!started){started=true;controller.enqueue(encoder.encode('{"exportedAt":'+JSON.stringify(anchor)));return;}
   if(sourceIndex>=sources.length){controller.enqueue(encoder.encode('}'));controller.close();return;}
   const [name,from,columns,owner,timestamp='created_at']=sources[sourceIndex];
   if(firstSource){firstSource=false;controller.enqueue(encoder.encode(','+JSON.stringify(name)+':['));return;}
   if(name==='answers'){
    const result=await getLearningHistoryPage(user,undefined,{cursor:answerCursor,limit:250});
    if(result.versions.length){controller.enqueue(encoder.encode((firstRow?'':',')+result.versions.map(row=>JSON.stringify(row)).join(',')));firstRow=false;}
    answerCursor=result.versionsPage.nextCursor||undefined;
    if(!answerCursor){controller.enqueue(encoder.encode(']'));sourceIndex++;cursor=null;firstSource=true;firstRow=true;}
    return;
   }
   const values:unknown[]=[user.id,anchor],after=cursor?` and (r.${timestamp},r.id)<($3::timestamptz,$4::uuid)`:'';if(cursor)values.push(cursor.at,cursor.id);
   const rows=await query(`select ${columns},to_char(r.${timestamp} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as __cursor_at from ${from} where ${owner}=$1 and r.${timestamp}<=$2::timestamptz${after} order by r.${timestamp} desc,r.id desc limit 250`,values);
   if(rows.length){const last=rows.at(-1)!;cursor={at:last.__cursor_at,id:last.id};controller.enqueue(encoder.encode((firstRow?'':',')+rows.map(({__cursor_at:_,...row})=>JSON.stringify(row)).join(',')));firstRow=false;}
   if(rows.length<250){controller.enqueue(encoder.encode(']'));sourceIndex++;cursor=null;firstSource=true;firstRow=true;}
  }catch(error){controller.error(error);}}});
  return new Response(stream,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="gakjaon-learning-records.json"','Cache-Control':'private, no-store'}});
 }catch(error){return errorResponse(error);}
}
