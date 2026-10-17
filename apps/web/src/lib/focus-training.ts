import {recordMatchesCurrentTarget} from './learning-target-scope';
type Value=Record<string,any>;
/** Training priorities use observed attempts, never literal keyword absence as a diagnosis. */
export function focusTraining<T extends {id:string;sourceType?:string;sourceVersion?:number}>(events:Value[],target:Value,questions:T[]){
  return questions.map(question=>{
    const history=events.filter(event=>{
      const data=event.data||{};
      if(!['quiz_response','memory_review','interview_answer'].includes(event.kind)||data.questionId!==question.id||!recordMatchesCurrentTarget(data,[target]))return false;
      const sourceType=data.sourceType||data.source_type||data.source_kind;
      const common=sourceType==='common'||['general_practice','book_reference','verified_past'].includes(sourceType)||data.commonRevision||data.common_revision;
      return question.sourceType==='common'?Boolean(common)&&Number(data.commonRevision||data.common_revision)===question.sourceVersion:!common&&Number(data.contentVersion||data.content_version)===question.sourceVersion;
    }).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).slice(0,5);
    const latest=history[0]?.data;
    if(!latest||latest.outcome===true&&!latest.timedOut&&!latest.assisted&&!latest.hintUsed)return null;
    const wrong=history.filter(event=>event.data.outcome===false).length;
    const timeout=history.filter(event=>event.data.timedOut===true).length;
    const helped=history.filter(event=>event.data.assisted===true||event.data.hintUsed===true).length;
    const score=wrong*3+timeout*2+helped;
    if(!score)return null;
    return {...question,score,reason:[wrong?`오답 ${wrong}회`:null,timeout?`시간 초과 ${timeout}회`:null,helped?`도움 사용 ${helped}회`:null].filter(Boolean).join(' · '),evidence:history.map(event=>({id:event.id||event.source_id,at:event.created_at})),lastPracticedAt:history[0].created_at};
  }).filter((item):item is NonNullable<typeof item>=>!!item).sort((a,b)=>b.score-a.score||String(a.id).localeCompare(String(b.id))).slice(0,3);
}
