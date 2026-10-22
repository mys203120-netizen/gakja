const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export const readableReportLabels:Record<string,string>={experience_cards:'내 경험',experience_card_drafts:'경험 초안',user_answers:'내 답변',answer_revisions:'답변 수정 이력',answer_comments:'답변에 남긴 의견',chat_threads:'AI 대화',chat_messages:'대화 내용',interview_sessions:'면접',interview_turns:'면접 답변',interview_reports:'면접 리포트',study_sessions:'학습 리포트',quiz_sessions:'연습',quiz_responses:'연습 답변',memory_attempts:'복습',student_confirmations:'사실 확인',student_plans:'계획',briefing_thoughts:'시사 생각 기록',briefing_thought_revisions:'시사 생각 수정 이력',department_news_thoughts:'뉴스 생각 기록',department_news_thought_revisions:'뉴스 생각 수정 이력',knowledge_bite_progress:'지식한입 기록',knowledge_bite_revisions:'지식한입 수정 이력',quiz_assignments:'과제',quiz_submissions:'과제 답변',support_targets:'지원 학교',media_assets:'녹음 전사',quiz_recordings:'연습 녹음 전사'};
const fieldLabels:Record<string,string>={title:'제목',name:'이름',university:'학교',department:'학과',major:'학과',admission:'전형',admission_type:'전형',interview_date:'면접일',category:'유형',situation:'상황',action:'내 행동',result:'결과·배운 점',originalText:'처음 작성한 글',sourceNote:'출처 메모',prompt:'질문',question:'질문',answer:'답변',script:'답변',structure:'답변 구성',content:'내용',response:'내 답변',reflection:'메모',explanation:'내 설명',text:'내용',summary:'요약',feedback:'피드백',strengths:'잘한 점',improvements:'보완할 점',nextSteps:'다음에 할 일',next_steps:'다음에 할 일',recommendation:'추천',recommendations:'추천',evidence:'근거',reason:'이유',role:'말한 사람',state:'상태',status:'상태',mode:'연습 방식',rating:'스스로 평가',recallStatus:'기억 상태',raw_transcript:'원전사',display_transcript:'정리한 전사',transcript:'전사',items:'학습 내용',responses:'내 답변',report:'학습 결과',draft:'초안',drafts:'작성 중인 답변',goals:'목표',target:'지원 정보',activities:'활동',questions:'질문',notes:'메모',selfCheck:'스스로 확인',learning:'내 설명',score:'점수',comment:'의견',review_note:'검토 의견',description:'설명',checked:'확인한 내용',labels:'기록 구분',due_at:'다음 복습',completed_at:'완료일',started_at:'시작일',finished_at:'마친 날'};
const enumLabels:Record<string,string>={user:'나',assistant:'AI 비서',completed:'완료',active:'진행 중',ready:'준비',paused:'일시 정지',ended:'여기까지 저장',finalized:'완료',confirmed_by_student:'내가 확인함',confirmed_from_record:'학생부에서 확인',needs_confirmation:'확인 필요',cannot_confirm:'확인할 수 없음',student_says_different:'기록과 다름',again:'다시 준비',hard:'어려웠어요',good:'설명할 수 있어요',easy:'도움 없이 가능해요',choice:'선택형 퀴즈',oral:'답변 녹음',answer:'Q&A',explained:'내 말로 설명함',needs_review:'추가 확인 필요',not_yet:'아직 설명 전'};
const enumFields=new Set(['role','state','status','mode','rating','recallStatus','selfCheck']);
const hidden=/(?:^id$|_id$|Ids$|Id$|hash|token|storage|telemetry|^html$|^mime$|^files$|^metadata$|^context$|^revision$|^content_version$|^updated_at$|^created_at$|^deleted_at$|^pinned$|^confirmed$|^request|^url$)/i;
function readable(value:unknown,key='',depth=0):string{
  if(value===null||value===undefined)return '';
  if(depth>8)return '더 자세한 내용은 전체 JSON 백업에서 확인해 주세요.';
  if(typeof value==='string'){
    const text=enumFields.has(key)?enumLabels[value]||value:value;
    return text.length>200000?text.slice(0,200000)+'\n[긴 글의 나머지는 전체 JSON 백업에 포함돼요.]':text;
  }
  if(typeof value==='number')return String(value);
  if(typeof value==='boolean')return fieldLabels[key]?(value?'예':'아니요'):'';
  if(Array.isArray(value))return value.map(item=>readable(item,key,depth+1)).filter(Boolean).join('\n\n');
  if(typeof value==='object')return Object.entries(value).filter(([name])=>!hidden.test(name)).map(([name,item])=>{const content=readable(item,name,depth+1);return content?(fieldLabels[name]?fieldLabels[name]+': ':'')+content:'';}).filter(Boolean).join('\n\n');
  return '';
}
function koreanDate(value:unknown){const date=new Date(String(value||''));return Number.isFinite(date.valueOf())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'long',timeStyle:'short'}).format(date):'';}
export function readableReportHeader(user:{name:string;email:string},exportedAt:string){
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>내 학습 기록</title><style>body{font:15px/1.7 system-ui,sans-serif;color:#22272b;background:#fff;max-width:900px;margin:auto;padding:32px 24px}h1{font-size:24px;line-height:1.35;margin:12px 0}h2{font-size:18px;margin:0;padding-bottom:12px;border-bottom:2px solid #008747}h3{font-size:15px;margin:0 0 6px}small,.meta,.note{font-size:13px;color:#687078}header{padding-bottom:28px;border-bottom:1px solid #e5e8eb}section{margin-top:36px}article{padding:20px 0;border-bottom:1px solid #e5e8eb}pre{font:inherit;margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.note{background:#f1f8f4;padding:16px;border-radius:12px}@media print{body{padding:0}h2{break-after:avoid}article{break-inside:avoid}}@media(max-width:500px){body{padding:24px 16px}}</style></head><body><header><small>각자ON · 내 기록</small><h1>'+escape(user.name)+'님의 학습 기록</h1><p class="meta">'+escape(koreanDate(exportedAt))+' · '+escape(user.email)+'</p></header><p class="note">현재 보관 중인 경험·답변·학습 내용을 읽기 쉽게 정리했어요. 휴지통과 미디어 원본을 포함한 전체 자료는 JSON 백업에서 확인할 수 있어요.</p>';
}
export function readableReportSection(table:string){return '<section><h2>'+escape(readableReportLabels[table]||'학습 기록')+'</h2>';}
export function readableReportArticle(table:string,row:Record<string,any>){
  if(!readableReportLabels[table])return '';
  const payload=table==='media_assets'?{text:row.text}:table==='quiz_recordings'?{transcript:row.metadata?.displayTranscript||row.metadata?.transcript}:row;
  const content=readable(payload);if(!content.trim())return '';
  const title=row.title||row.data?.title||row.question||row.prompt||(table==='chat_messages'?(enumLabels[row.role]||'대화'):readableReportLabels[table]);
  const date=koreanDate(row.created_at||row.started_at||row.updated_at);
  return '<article><h3>'+escape(title)+'</h3>'+(date?'<small>'+escape(date)+'</small>':'')+'<pre>'+escape(content)+'</pre></article>';
}
