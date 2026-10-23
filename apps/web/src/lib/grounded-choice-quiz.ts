import type {LearningData,MemoryItem} from '@gakja/content-contracts';

const approved=new Set(['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student']);
const normalized=(value:string)=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
function hash(value:string){let result=2166136261;for(const letter of value){result^=letter.charCodeAt(0);result=Math.imul(result,16777619);}return (result>>>0).toString(36);}
export function studentReviewedTranscription(source:unknown){const value=source as Record<string,unknown>|null;return Boolean(value?.type==='student_document'&&value.verification_status==='student_reviewed_transcription'&&value.quote_basis==='student_reviewed_transcription'&&value.student_reviewed===true&&Number.isInteger(value.text_revision)&&Number(value.text_revision)>0&&['local_ocr','mixed_ocr','pdf_text'].includes(String(value.extraction_method)));}
const groundedSource=(source:LearningData['source_refs'][number])=>source.type==='student_document'&&(source.verification_status==='extracted_from_record'||studentReviewedTranscription(source));
const safeTranscription=(source:LearningData['source_refs'][number])=>!(source.verification_status==='student_reviewed_transcription'||(source as unknown as Record<string,unknown>).quote_basis==='student_reviewed_transcription')||studentReviewedTranscription(source);

/** An exact, uniquely attributed record excerpt has one verifiable activity title.
 * Distractors are real other activities, never invented statements about the student.
 * Ambiguous excerpts, duplicate titles and insufficient source material yield no item. */
export function groundedChoiceItems(learning:LearningData):MemoryItem[]{
 const extracted=(activity:LearningData['activities'][number])=>(activity as unknown as Record<string,unknown>).source_type==='student_document_analysis'&&activity.fact_confirmation==='needs_confirmation'&&activity.source_ref_ids?.some(id=>learning.source_refs.some(source=>source.id===id&&groundedSource(source)&&source.quote));
 // This validates the document-to-activity link only. It never confirms the
 // student's role or changes the activity's separate fact confirmation state.
 const activities=(learning.activities||[]).filter(activity=>(approved.has(activity.fact_confirmation)||extracted(activity))&&activity.source_ref_ids?.length&&normalized(activity.title));
 const titles=activities.map(activity=>normalized(activity.title));
 const unique=activities.filter(activity=>titles.filter(title=>title===normalized(activity.title)).length===1);
 if(unique.length<4)return [];
 return unique.flatMap(activity=>{
  const question=(learning.questions||[]).find(question=>(approved.has(question.verification_status)||extracted(activity)&&question.verification_status==='ai_generated_grounded')&&question.activity_ids?.includes(activity.id));
  if(!question)return [];
  const source=(learning.source_refs||[]).find(source=>activity.source_ref_ids.includes(source.id)&&(source.quote?.trim().length||0)>=18&&safeTranscription(source)&&(!extracted(activity)||groundedSource(source)));
  if(!source?.quote)return [];
  const excerpt=source.quote.trim().slice(0,110).trim();
  const quote=normalized(excerpt);
  const matches=activities.filter(candidate=>candidate.source_ref_ids.some(id=>{
   const candidateSource=learning.source_refs.find(item=>item.id===id);return candidateSource?.quote&&normalized(candidateSource.quote).includes(quote);
  }));
  if(matches.length!==1||matches[0].id!==activity.id)return [];
  const distractors=unique.filter(candidate=>candidate.id!==activity.id).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,3);
  const ordered=[activity,...distractors].sort((a,b)=>hash(source.id+a.id).localeCompare(hash(source.id+b.id)));
  const transcription=studentReviewedTranscription(source),id='record_choice_'+hash(JSON.stringify([activity.id,source.id,quote,ordered.map(item=>item.title),...(transcription?[source.verification_status,(source as unknown as Record<string,unknown>).text_revision]:[])]));
  return [{id,kind:'choice',question_id:question.id,answer_script_id:null,activity_ids:[activity.id],prompt:`다음 ${transcription?'학생이 확인한 인식문':'학생부 기록'}이 연결된 활동은?\n“${excerpt}”${source.quote.trim().length>excerpt.length?' (일부 발췌)':''}`,
   options:ordered.map((item,index)=>({id:String(index+1),text:item.title})),correct_option_id:String(ordered.findIndex(item=>item.id===activity.id)+1),
   memory_keywords:[activity.title],default_time_limit_seconds:10,evaluation_method:'reviewed_correct_answer',category:'factual',
   source_ref_ids:[source.id],verification_status:transcription?'student_reviewed_transcription':'confirmed_from_record',back:`${transcription?'학생이 확인한 인식문':'이 원문'}은 「${activity.title}」의 기록에 연결되어 있어요.${transcription?' 인식문과 활동 제목의 연결을 확인하는 문제예요.':''}`} as MemoryItem];
 });
}
