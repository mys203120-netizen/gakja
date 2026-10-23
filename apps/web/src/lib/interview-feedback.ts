import {z} from 'zod';
export const INTERVIEW_RUBRIC_VERSION='interview-content-v1';
export const INTERVIEW_RUBRIC=[{id:'question_response',label:'질문 핵심',description:'질문의 요구에 직접 답했는가'},{id:'record_grounding',label:'생기부 근거',description:'답변의 사실이 연결된 원문에서 확인되는가'},{id:'personal_action',label:'본인 행동',description:'학생 자신이 한 구체적인 행동을 설명했는가'},{id:'structure',label:'답변 구성',description:'핵심과 경험·배운 점이 알아들을 수 있는 순서로 연결되는가'}] as const;
const criterionSchema=z.object({id:z.enum(['question_response','record_grounding','personal_action','structure']),score:z.union([z.literal(0),z.literal(1),z.literal(2)]).nullable(),reason:z.string().max(400),evidence:z.array(z.string().min(1).max(400)).max(4),sourceEvidence:z.array(z.object({sourceId:z.string().max(200),quote:z.string().min(1).max(600)})).max(4).default([])});
const schema=z.object({summary:z.string().min(1).max(2000),needsReview:z.boolean().nullable(),reason:z.string().max(400),evidence:z.array(z.string().min(1).max(400)).max(4),criteria:z.array(criterionSchema).max(4).optional()});
export const INTERVIEW_RUBRIC_PROMPT=`학습용 답변 요소 충족도를 평가한다. 합격 가능성·인격·능력 점수가 아니다. 버전 ${INTERVIEW_RUBRIC_VERSION}. 척도는 0=해당 요소를 충족하지 않음, 1=일부 충족하나 빠진 핵심 있음, 2=답변에서 명확히 충족함, null=확인할 근거 부족. criteria에는 ${INTERVIEW_RUBRIC.map(value=>`${value.id}(${value.label}):${value.description}`).join('; ')} 네 항목을 정확히 한 번씩 담는다. 각 항목은 {id,score,reason,evidence:[학생 원발화 정확한 인용],sourceEvidence:[{sourceId,quote:승인 원문 정확한 인용}]} 형식이다. 근거를 찾을 수 없으면 score=null. 특히 record_grounding은 학생 인용과 승인 원문 인용을 함께 확인해야 한다. 질문이 구조 평가에 충분하지 않으면 structure도 null로 둔다.`;
/** Published operator guidance is frozen with the session's learning context. */
export function interviewGuidelineInstruction(guidelines:unknown,kinds:string[]){return Array.isArray(guidelines)?guidelines.filter(value=>value&&kinds.includes(value.kind)&&typeof value.body==='string').map(value=>`적용 운영지침 ${value.kind} v${value.version}: ${value.body.slice(0,12000)}`).join('\n'):'';}
/** A review recommendation must point to the student's actual words. No invented score. */
export function parseInterviewFeedback(content:string,answer:string,sources:Record<string,any>[]=[],guidelines:unknown=[]){
 const guidelineVersions=Array.isArray(guidelines)?guidelines.filter(value=>value&&['evaluation','feedback'].includes(value.kind)).map(value=>({kind:value.kind,version:value.version,id:value.id||null})):[];
 try{
  const value=schema.parse(JSON.parse(content));
  const evidence=value.evidence.filter(quote=>answer.includes(quote));
  const criteria=INTERVIEW_RUBRIC.map(rule=>{
   const matches=(value.criteria||[]).filter(item=>item.id===rule.id),item=matches.length===1?matches[0]:null;
   const quotes=item?.evidence.filter(quote=>answer.includes(quote))||[];
   const sourceEvidence=item?.sourceEvidence.filter(citation=>sources.some(source=>source.id===citation.sourceId&&typeof source.quote==='string'&&source.quote.includes(citation.quote)&&(rule.id!=='record_grounding'||!['school_reference','school_talent','department_learning'].includes(source.type))))||[];
   const confirmed=quotes.length>0&&(rule.id!=='record_grounding'||sourceEvidence.length>0);
   return {id:rule.id,label:rule.label,score:confirmed?item?.score??null:null,reason:confirmed?item!.reason:'확인할 근거가 부족해요.',evidence:quotes,sourceEvidence};
  });
  const assessedCount=criteria.filter(item=>item.score!==null).length;
  const rubric={version:INTERVIEW_RUBRIC_VERSION,scale:'0 충족하지 않음 / 1 부분 충족 / 2 명확히 충족',criteria,total:assessedCount===4?criteria.reduce((sum,item)=>sum+(item.score||0),0):null,max:8,assessedCount};
  const source=criteria.find(item=>item.id==='record_grounding')?.sourceEvidence[0];
  const compositionExample=source?{title:'근거로 답변 구성하기',parts:[
    {kind:'record',label:'생기부에 남은 사실',text:source.quote,sourceId:source.sourceId},
    ...(evidence.length?[{kind:'student',label:'내가 실제 말한 내용',text:evidence[0]}]:[]),
    {kind:'check',label:'개인 역할 확인 필요',text:'위 활동에서 내가 직접 한 행동을 확인하고, 그 행동의 이유와 배운 점을 내 말로 연결해 보세요.'},
  ],note:'원문과 원발화의 인용을 배치한 구성 예시예요. 학생 개인의 역할·성과가 확인됐다는 뜻은 아니며 완성 답변으로 대신 제출하지 않아요.'}:null;
  return {summary:value.summary,evaluation:{needsReview:evidence.length?value.needsReview:null,reason:evidence.length?value.reason:'원답변에서 평가 근거를 확인하지 못했어요.',evidence,rubric,guidelineVersions,compositionExample}};
 }catch{return {summary:content,evaluation:{needsReview:null,reason:'구조화 평가를 확인하지 못했어요.',evidence:[] as string[],rubric:null,guidelineVersions,compositionExample:null}};}
}
