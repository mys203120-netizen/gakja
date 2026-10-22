import {z} from 'zod';

const id=z.string().trim().min(1).max(160);
export const writingContextSchema=z.object({threadId:z.string().uuid().optional(),targetId:id.nullish(),questionId:id.nullish(),activityId:id.nullish(),briefingId:z.string().uuid().nullish(),sourceType:z.enum(['personal','common']).optional(),sourceVersion:z.number().int().positive().max(100000).optional(),quizSessionId:z.string().uuid().optional(),quizItemIndex:z.number().int().min(0).max(10000).optional(),interviewSessionId:z.string().uuid().optional(),interviewTurnId:z.string().uuid().optional()}).strict();
export const thoughtWritingSchema=z.object({kind:z.enum(['experience','chat']),scopeId:z.string().min(1).max(1000),field:z.enum(['situation','action','result']).optional(),source:z.string().trim().min(1).max(6000),original:z.string().max(6000).default(''),history:z.array(z.object({question:z.string().trim().min(1).max(500),answer:z.string().trim().min(1).max(2000)}).strict()).max(6).default([]),context:writingContextSchema.default({}),requestId:z.string().uuid()}).strict().superRefine((input,ctx)=>{
 if(input.kind==='experience'&&(!input.field||input.source.length>2000||!z.string().uuid().safeParse(input.scopeId).success))ctx.addIssue({code:'custom',message:'경험의 작성 영역과 길이를 확인해 주세요.'});
 if(input.kind==='chat'&&input.field)ctx.addIssue({code:'custom',message:'대화의 작성 영역을 확인해 주세요.'});
 if(Boolean(input.context.quizSessionId)!==Boolean(input.context.quizItemIndex!==undefined)||Boolean(input.context.interviewSessionId)!==Boolean(input.context.interviewTurnId)||input.context.quizSessionId&&input.context.interviewSessionId)ctx.addIssue({code:'custom',message:'도움을 받을 현재 질문을 확인해 주세요.'});
 if(input.kind==='experience'&&Object.keys(input.context).some(key=>!['targetId'].includes(key)))ctx.addIssue({code:'custom',message:'경험 작성에서 다시 정리해 주세요.'});
});
export type ThoughtWritingInput=z.infer<typeof thoughtWritingSchema>;
export type WritingProposal={draft:string;followup_question:string|null;support_quotes:string[];model?:string;promptVersion?:string};
export type WritingContext=z.infer<typeof writingContextSchema>;
export type WritingReceipt={requestId:string;digest:string;attempt:string;status:'pending'|'completed'|'failed';startedAt:string;kind:ThoughtWritingInput['kind'];scopeId:string;field?:ThoughtWritingInput['field'];context:WritingContext;proposal?:WritingProposal};
export const writingFieldQuestions={situation:'어떤 상황이었고 무엇이 어려웠나요?',action:'그때 학생이 직접 한 행동은 무엇인가요?',result:'그 뒤 달라진 점이나 배운 점이 있나요?'};
