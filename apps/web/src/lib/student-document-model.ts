import {createHash} from 'node:crypto';
import {z} from 'zod';
import {generatedInterviewQuestion} from './interview-policy';

export const DOCUMENT_CONSENT_VERSION='student-record-2026-10-23';
export const DOCUMENT_MAX_BYTES=10*1024*1024;
export const GUIDELINE_KINDS=['analysis','questions','evaluation','feedback','curriculum'] as const;
export type GuidelineKind=typeof GUIDELINE_KINDS[number];
export type DocumentPage={page:number;text:string;extractedText?:string;ocrText?:string;extractionMethod?:'pdf_text'|'local_ocr'|'mixed_ocr';confidence?:number|null;ocrStatus?:'pending'|'completed'|'failed';issue?:string;studentReviewed?:boolean;corrected?:boolean;blank?:boolean};
export function reviewedDocumentPages(raw:DocumentPage[],value:unknown):DocumentPage[]{
  const rows=z.array(z.object({page:z.number().int(),text:z.string().max(30000),reviewed:z.literal(true),blank:z.boolean().optional()}).strict()).max(60).parse(value);
  if(rows.length!==raw.length||rows.some((p,i)=>p.page!==raw[i].page))throw new DocumentValidationError('모든 페이지를 순서대로 확인해 주세요.');
  if(rows.reduce((sum,p)=>sum+p.text.length,0)>120000)throw new DocumentValidationError('확인한 텍스트는 전체 12만 자까지 저장할 수 있어요.');
  return rows.map((p,i)=>{const text=p.text.replace(/\u0000/g,'').trim();if(!p.blank&&text.replace(/\s/g,'').length<15)throw new DocumentValidationError(`${p.page}쪽의 인식문을 정정하거나 내용 없는 페이지인지 확인해 주세요.`);if(p.blank&&text)throw new DocumentValidationError(`${p.page}쪽에 내용이 있어요. 빈 페이지 표시를 해제해 주세요.`);return {...raw[i],text,studentReviewed:true,corrected:text!==raw[i].text,blank:p.blank===true};});
}
export type GuidelineSnapshot={kind:GuidelineKind;version:number;body:string;id:string|null;rules?:Record<string,unknown>|null};
export const DEFAULT_GUIDELINES:Record<GuidelineKind,string>={
  analysis:'학생부 전체 페이지를 읽고 활동의 영역·학년·근거 위치를 분리한다. 학생 개인의 행동·역할·성과는 원문에 명시된 경우만 다룬다. 지원 학과별 S/A/B/C/F는 면접 준비 우선도이며 능력·합격률 점수가 아니다. 관련성의 이유와 원문 인용을 함께 제시하고 불명확한 것은 확인 필요로 남긴다.',
  questions:'원문 활동의 실제 역할·과정·배운 점 중 하나를 구체적으로 묻는 120자 이내 한 문장 질문을 만든다. 학교 인재상 명칭을 직접 언급하거나 연결하라고 요구하지 않는다. 원문에 없는 행동이나 실험을 이미 했다고 전제하지 않는다. 학교의 공식 평가 기준이나 기출을 추측하지 않는다. 질문마다 활동과 원문 근거를 연결한다.',
  evaluation:'학생이 실제 말한 내용과 원문을 구분한다. 질문에 대한 대응·근거·자기 표현을 살피며 근거 없는 능력 점수나 합격 가능성을 생성하지 않는다. 운영자가 정량 기준을 게시하기 전에는 임의 점수를 만들지 않는다.',
  feedback:'강점과 보완점은 학생 답변의 실제 문장에 근거한다. 억지 장점을 채우지 않는다. 학생이 하지 않은 행동·성과를 답변 예시에 추가하지 않는다. 다음 연습에서 확인할 행동 하나를 제안한다.',
  curriculum:'하루 한 학생부 영역 안에서 복습·정답형 퀴즈·선택 답변 연습·화상 면접을 연결한다. 지원처·면접일·가용시간·활동 중요도를 고려하되 미수행을 완료로 만들지 않는다. 완료 기록은 보존한다.',
};
export class DocumentValidationError extends Error {}
const normalized=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim();

/** Conservative document-kind recognition, never an authenticity/identity claim. */
export function recognizeStudentDocument(pages:DocumentPage[]){
  if(!pages.length||pages.length>60)throw new DocumentValidationError('생기부 PDF는 1~60쪽으로 등록해 주세요.');
  if(pages.some((p,i)=>p.page!==i+1||(!p.blank&&p.text.replace(/\s/g,'').length<15)))throw new DocumentValidationError('읽을 수 없는 페이지가 있어요. 페이지별 인식문을 확인·정정해 주세요. 아직 원본을 고정하지 않았어요.');
  const text=normalized(pages.map(p=>p.text).join('\n'));
  if(text.length>120_000)throw new DocumentValidationError('분석할 수 있는 글자 수를 넘었어요. 원본을 고정하지 않았어요.');
  const compact=text.replace(/\s/g,'');
  const heading=/학교생활(?:세부사항)?기록부/.test(compact);
  const sections=['인적·학적사항','인적사항','학적사항','출결상황','수상경력','창의적체험활동','교과학습발달상황','세부능력및특기사항','행동특성및종합의견'].filter(s=>compact.includes(s));
  if(!heading||sections.length<2||text.length<300)throw new DocumentValidationError('학교생활기록부인지 확인하기 어려워요. 제목과 활동 내용이 포함된 전체 PDF를 선택해 주세요. 아직 원본을 고정하지 않았어요.');
  return {kind:'school_record',method:'text-structure-v1',sections,pageCount:pages.length,identityVerified:false};
}

const evidence=z.object({page:z.number().int().min(1).max(60),quote:z.string().trim().min(12).max(3000)}).strict();
const priority=z.object({targetId:z.string().min(1),priority:z.enum(['S','A','B','C','F']),reason:z.string().trim().min(5).max(800)}).strict();
export const documentAnalysisSchema=z.object({
  reviewedPages:z.array(z.number().int().min(1).max(60)).min(1).max(60),
  activities:z.array(z.object({title:z.string().trim().min(1).max(160),area:z.string().trim().min(1).max(100),grade:z.number().int().min(1).max(3),summary:z.string().trim().min(1).max(1800),evidence:z.array(evidence).min(1).max(8),priorities:z.array(priority).min(1).max(20),questions:z.array(z.object({prompt:z.string().trim().min(5).max(120),intent:z.string().trim().min(3).max(500)}).strict()).min(1).max(5),confirmations:z.array(z.string().trim().min(1).max(400)).max(8)}).strict()).min(1).max(80),
  limitations:z.array(z.string().trim().min(1).max(500)).max(20),
}).strict();
export type DocumentAnalysis=z.infer<typeof documentAnalysisSchema>;
export function validateDocumentAnalysis(value:unknown,pages:DocumentPage[],targets:{id:string}[],excludedTalentLabels:string[]=[]):DocumentAnalysis{
  const result=documentAnalysisSchema.parse(value);
  if(new Set(result.reviewedPages).size!==pages.length||pages.some(p=>!result.reviewedPages.includes(p.page)))throw new DocumentValidationError('전체 페이지의 분석을 확인하지 못했어요. 같은 원본으로 다시 분석해 주세요.');
  const targetIds=new Set(targets.map(t=>t.id));
  for(const activity of result.activities){
    if(new Set(activity.priorities.map(p=>p.targetId)).size!==targetIds.size||activity.priorities.length!==targetIds.size||activity.priorities.some(p=>!targetIds.has(p.targetId)))throw new DocumentValidationError('지원처별 분석 연결을 확인하지 못했어요. 다시 분석해 주세요.');
    for(const ref of activity.evidence){const page=pages.find(p=>p.page===ref.page);if(!page||!normalized(page.text).includes(normalized(ref.quote)))throw new DocumentValidationError('분석에 원문과 일치하지 않는 인용이 있어요. 결과를 훈련에 반영하지 않았어요.');}
    for(const question of activity.questions){if(!generatedInterviewQuestion(question.prompt,excludedTalentLabels))throw new DocumentValidationError('질문의 길이·한 문장 구성·인재상 명칭 제외 규칙을 확인하지 못했어요. 같은 원본으로 다시 분석해 주세요.');}
  }
  return result;
}
const md=(value:unknown)=>String(value??'').replace(/[\\`*_{}\[\]<>#|]/g,'\\$&');

/** No invented answer scripts or automatically "reviewed" quiz answers. */
export function documentLearning(input:{documentId:string;revision:number;studentId:string;analysis:DocumentAnalysis;targets:Record<string,any>[];guidelines:GuidelineSnapshot[];pages?:DocumentPage[];textRevision?:number}){
  const {documentId,revision,studentId,analysis,targets,guidelines}=input;
  const criteria=guidelines.map(g=>g.kind+':'+g.version).join('|');
  const sources=new Map<string,Record<string,any>>(),questions:Record<string,any>[]=[];
  const activities=analysis.activities.map((activity,index)=>{
    const id=`record_${documentId}_r${revision}_a${index+1}`;
    const refs=activity.evidence.map(ref=>{const page=input.pages?.find(p=>p.page===ref.page),transcribed=page?.corrected||page?.extractionMethod==='local_ocr'||page?.extractionMethod==='mixed_ocr';const sid=`record_${documentId}_t${input.textRevision||1}_p${ref.page}_${createHash('sha256').update(normalized(ref.quote)).digest('hex').slice(0,12)}`;sources.set(sid,{id:sid,type:'student_document',revision:input.textRevision||1,text_revision:input.textRevision||1,document_id:documentId,page:ref.page,area:activity.area,quote:ref.quote,location:`${transcribed?'확인한 인식문':'원본 추출문'} ${ref.page}쪽`,verification_status:transcribed?'student_reviewed_transcription':'extracted_from_record',quote_basis:transcribed?'student_reviewed_transcription':'pdf_text',extraction_method:page?.extractionMethod||'pdf_text',ocr_confidence:page?.confidence??null,student_reviewed:page?.studentReviewed===true});return sid;});
    activity.questions.forEach((q,qi)=>questions.push({id:id+'_q'+(qi+1),prompt:q.prompt,question_intent:q.intent,grounding_types:['document_based'],question_types:['activity'],activity_ids:[id],support_target_ids:targets.map(t=>t.id),source_ref_ids:refs,evaluation_links:[],answer_elements:[],answer_structure:[],followup_question_ids:[],verification_status:'ai_generated_grounded',source_type:'student_document_analysis',interview_priority:activity.priorities[0].priority}));
    return {id,title:activity.title,grade:activity.grade,area:activity.area,activity_summary:activity.evidence.map(e=>e.quote).join('\n'),analysis_summary:activity.summary,interview_priority:activity.priorities[0].priority,priority_reason:activity.priorities[0].reason,priority_assignments:activity.priorities.map(p=>({support_target_id:p.targetId,priority:p.priority,reason:p.reason,source_ref_ids:refs,criteria_version:criteria})),talent_tags:[],major_relevance:null,source_ref_ids:refs,fact_confirmation:'needs_confirmation',confirmations:activity.confirmations,source_type:'student_document_analysis'};
  });
  const learning={criteria_version:criteria,knowledge_release_refs:[],student_context:{student_id:studentId,name:'',core_keywords:[],career_academic_flow:[],representative_activity_ids:[],confirmed_goals:[],confirmed_plans:[],source_ref_ids:[...sources.keys()],record_basis:'학생이 등록한 원문 인용과 AI 분석 제안. 인용 일치만 확인했으며 개인 역할·진위·운영자 검수를 의미하지 않음.'},support_targets:targets,source_refs:[...sources.values()],activities,questions,answer_designs:[],answer_scripts:[],memory_keywords:[],memory_items:[],student_document:{id:documentId,analysis_revision:revision,text_revision:input.textRevision||1,guidelines,limitations:analysis.limitations}};
  const markdown=['# 각자의 답 · 생기부 분석',`원본: ${documentId} · 분석 ${revision}차 · 인식문 ${input.textRevision||1}차`,`지침: ${criteria}`,'AI의 준비 우선도 제안입니다. 원문 인용 일치 확인은 문서 진위·개인 역할 확인이 아닙니다. OCR·학생 정정문은 원 PDF와 별도로 보존되는 인식문이며 독립적으로 검증된 사실이 아닙니다.',...activities.flatMap((a,i)=>[`## ${i+1}. ${md(a.title)}`,`${md(a.area)} · ${a.grade}학년`,`### 분석 제안`,md(a.analysis_summary),...a.priority_assignments.map(p=>`- ${md(targets.find(t=>t.id===p.support_target_id)?.department||p.support_target_id)}: ${p.priority} — ${md(p.reason)}`),'### 원문 근거',...analysis.activities[i].evidence.map(e=>`> ${e.page}쪽: ${md(e.quote)}`),'### 확인할 질문',...questions.filter(q=>q.activity_ids.includes(a.id)).map(q=>`- ${md(q.prompt)}`),...a.confirmations.map(c=>`- 확인 필요: ${md(c)}`)]),'## 한계',...analysis.limitations.map(x=>`- ${md(x)}`)].join('\n\n');
  return {learning,markdown};
}
