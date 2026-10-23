import {requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query,transaction} from '@/lib/db';
import {normaliseSourceFacts,studySummary} from '@/lib/study-sessions';
import {renderReportExport} from '@/lib/report-export';
import {exampleAnswerBasis} from '@/lib/example-answer-model';

export const dynamic='force-dynamic';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request:Request) {
  try {
    const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
    const params=new URL(request.url).searchParams,reportId=params.get('reportId'),studyId=params.get('studyId'),date=params.get('date');
    if([reportId,studyId,date].filter(Boolean).length!==1)throw new ApiError(400,'다운로드할 날짜 또는 훈련을 선택해 주세요.');
    if(reportId&&!uuid.test(reportId)||studyId&&!uuid.test(studyId))throw new ApiError(400,'훈련 기록을 확인해 주세요.');
    if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new ApiError(400,'날짜를 확인해 주세요.');
    const [interviews,studies]=await Promise.all([
      studyId?Promise.resolve([]):query(`select r.*,s.data as session_data from interview_reports r join interview_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=$1 and s.state='completed' and ${reportId?'r.id=$2':"(r.created_at at time zone 'Asia/Seoul')::date=$2::date"} order by r.created_at,r.id`,[user.id,reportId||date]),
      reportId?Promise.resolve([]):query(`select s.*,coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'source_id',e.source_id,'kind',e.kind,'data',e.data,'created_at',e.created_at) order by e.created_at,e.id) from study_session_events e where e.session_id=s.id and e.student_id=$1),'[]'::jsonb) as events from study_sessions s where s.student_id=$1 and ${studyId?'s.id=$2':"(s.started_at at time zone 'Asia/Seoul')::date=$2::date"} order by s.started_at,s.id`,[user.id,studyId||date]),
    ]);
    if(!interviews.length&&!studies.length)throw new ApiError(404,'다운로드할 학습 기록이 없어요.');
    const turnIds=[...new Set(interviews.flatMap(row=>(row.data.sections||[]).map((section:Record<string,any>)=>section.turnId).filter((id:unknown)=>typeof id==='string'&&uuid.test(id))))];
    const [turns,confirmations]=turnIds.length?await Promise.all([query('select id,data from interview_turns where student_id=$1 and id=any($2::uuid[])',[user.id,turnIds]),query('select entity_id,state,data,confirmation_status from student_confirmations where student_id=$1',[user.id])]):[[],[]];
    const currentInterviews=interviews.map(row=>({...row,data:{...row.data,sections:(row.data.sections||[]).map((section:Record<string,any>)=>{const turn=turns.find(item=>item.id===section.turnId);if(!turn||turn.data.invalidated===true)return section;const example=(turn.data.exampleAnswers||[]).filter((item:Record<string,any>)=>item.reportId===row.id&&item.turnId===turn.id).at(-1);if(!example)return section;const basis=exampleAnswerBasis({section:{...section,reportId:row.id},turn:turn.data,context:row.session_data?.context||{},confirmations});return {...section,exampleAnswer:{...example,stale:example.basisHash!==basis.hash}};})}}));
    const currentStudies=studies.length?await transaction(async db=>{const result=[];for(const row of studies){const events=(await normaliseSourceFacts(db,user.id,row.events||[])).filter(event=>event.data?.invalidated!==true);result.push({...row,events,report:{...studySummary(events),events}});}return result;}):[];
    const title=date?`${date} 학습 리포트`:'훈련 리포트';
    return new Response(renderReportExport({title,interviews:currentInterviews,studies:currentStudies}),{headers:{'Content-Type':'text/html; charset=utf-8','Content-Disposition':`attachment; filename="gakjaon-report${date?'-'+date:''}.html"`,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"}});
  }catch(error){return errorResponse(error);}
}
