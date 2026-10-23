import {createHash} from 'node:crypto';
import {z} from 'zod';

export const EXAMPLE_ANSWER_VERSION='confirmed-evidence-answer-v1';
export type ExampleFact={id:string;kind:'record'|'utterance';text:string;sourceId:string;label:string;page?:number};
export type ExampleBasis={version:string;hash:string;question:string;facts:ExampleFact[];blocked:boolean;reason:string|null};
export type CompletedExample={id:string;version:number;schemaVersion:string;reportId:string;turnId:string;question:string;answer:string;sentences:{text:string;factId:string;factIds?:string[]}[];citations:ExampleFact[];basisHash:string;confirmedAt:string;createdAt:string;requestId:string;method:'confirmed_extracts'|'grounded_rewrite';model?:string;note:string};
export const exampleRequestSchema=z.object({reportId:z.string().uuid(),turnId:z.string().uuid(),basisHash:z.string().regex(/^[a-f0-9]{64}$/),factIds:z.array(z.string().min(1).max(120)).min(2).max(10),confirmed:z.literal(true),requestId:z.string().uuid()}).strict();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordType=(type:unknown)=>['student_document','student_record','school_record','student_record_excerpt','activity_record'].includes(String(type));
function sentences(text:string,max=12){return [...new Intl.Segmenter('ko',{granularity:'sentence'}).segment(text)].map(item=>item.segment.trim()).filter(item=>item.length>=5&&item.length<=800).slice(0,max);}
function factId(kind:string,source:string,text:string){return kind+'-'+hash([source,text]).slice(0,24);}

/** Only the report's frozen utterance and its linked original record can become a basis. */
export function exampleAnswerBasis({section,turn,context,confirmations=[]}:{section:Record<string,any>;turn:Record<string,any>;context:Record<string,any>;confirmations?:Record<string,any>[]}):ExampleBasis {
 const root=String(turn.rootQuestionId||section.questionId||'');
 const question=(context.questions||[]).find((item:Record<string,any>)=>item.id===root||item.id===section.questionId);
 const activityIds=new Set<string>(question?.activity_ids||[]),sourceIds=new Set<string>([...(question?.source_ref_ids||[]),...(turn.sourceIds||[])]);
 for(const activity of context.activities||[])if(activityIds.has(activity.id))for(const id of activity.source_ref_ids||[])sourceIds.add(id);
 const relatedIds=new Set([...activityIds,...sourceIds,root,section.questionId,question?.id].filter(Boolean));
 const conflicting=confirmations.filter(item=>relatedIds.has(item.entity_id)).some(item=>['different','unknown','cannot_confirm'].includes(item.state)||item.state!=='confirmed'&&(item.data?.is_correction===true||['student_says_different','needs_confirmation','cannot_confirm'].includes(item.confirmation_status||item.data?.confirmation_status||'')));
 const raw=typeof section.evaluationEvidence?.answer==='string'?section.evaluationEvidence.answer:String(section.answer||'');
 const facts:ExampleFact[]=sentences(raw).map(text=>({id:factId('utterance',section.turnId,text),kind:'utterance',text,sourceId:section.turnId,label:'이 면접의 원답변'}));
 for(const source of context.sources||[]){
  if(!sourceIds.has(source.id)||!recordType(source.type)||typeof source.quote!=='string')continue;
  const transcribed=source.quote_basis==='student_reviewed_transcription'||source.verification_status==='student_reviewed_transcription';
  const label=transcribed?`학생이 확인한 인식문 ${source.text_revision||source.revision||1}차${source.page?` · ${source.page}쪽`:''}`:source.page?`생기부 ${source.page}쪽`:'연결된 생기부 원문';
  for(const text of sentences(source.quote,5))facts.push({id:factId('record',source.id,text),kind:'record',text,sourceId:source.id,label,...(Number.isInteger(source.page)?{page:source.page}:{})});
 }
 const unique=[...new Map(facts.map(fact=>[fact.id,fact])).values()].slice(0,32);
 const blocked=conflicting||!unique.some(f=>f.kind==='record')||!unique.some(f=>f.kind==='utterance');
 const reason=conflicting?'연결된 활동에 확인이 필요한 내용이 있어요. 사실 확인을 마친 뒤 예시를 만들어 주세요.':!unique.some(f=>f.kind==='record')?'이 질문에는 연결된 생기부 원문이 없어요. 원문 근거를 확인한 질문에서 만들 수 있어요.':!unique.some(f=>f.kind==='utterance')?'예시로 연결할 원답변이 부족해요. 먼저 이 질문에 답변을 남겨 주세요.':null;
 const basis={version:EXAMPLE_ANSWER_VERSION,question:String(section.question||''),facts:unique,blocked,reason};
 return {...basis,hash:hash({basis,answer:section.answer||'',raw,sourceVersion:context.contentVersion,packageId:context.packageId,reportId:section.reportId||null})};
}

/** Builds a finished paragraph, never new experience claims. The selected order is explicit. */
export function completeEvidenceAnswer(basis:ExampleBasis,input:z.infer<typeof exampleRequestSchema>,metadata:{id:string;version:number;at:string}):CompletedExample {
 if(basis.blocked)throw new Error('EXAMPLE_BASIS_BLOCKED');
 if(input.basisHash!==basis.hash)throw new Error('EXAMPLE_BASIS_CHANGED');
 if(new Set(input.factIds).size!==input.factIds.length)throw new Error('EXAMPLE_FACT_DUPLICATE');
 const chosen=input.factIds.map(id=>basis.facts.find(fact=>fact.id===id));
 if(chosen.some(fact=>!fact))throw new Error('EXAMPLE_FACT_UNKNOWN');
 const citations=chosen as ExampleFact[],spoken=citations.filter(fact=>fact.kind==='utterance');
 if(!citations.some(fact=>fact.kind==='record')||!spoken.length)throw new Error('EXAMPLE_FACTS_REQUIRED');
 // Fillers and hesitations remain in the original. An example can omit a leading filler only.
 const body=spoken.map(fact=>({factId:fact.id,text:fact.text.replace(/^(?:(?:음|어|그)[,，]\s*)+/u,'').trim()})).filter(value=>value.text.length>=5);
 if(body.map(item=>item.text).join(' ').length<40)throw new Error('EXAMPLE_ANSWER_EMPTY');
 return {id:metadata.id,version:metadata.version,schemaVersion:EXAMPLE_ANSWER_VERSION,reportId:input.reportId,turnId:input.turnId,question:basis.question,answer:body.map(item=>item.text).join(' '),sentences:body,citations,basisHash:basis.hash,confirmedAt:metadata.at,createdAt:metadata.at,requestId:input.requestId,method:'confirmed_extracts',note:'직접 확인한 원문과 원발화 문장으로 연결한 완성 예시예요. 원답변·원전사·평가는 그대로 보존하며, 확인하지 않은 역할이나 성과를 추가하지 않아요.'};
}
