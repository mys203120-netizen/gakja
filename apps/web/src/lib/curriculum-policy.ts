import {z} from 'zod';

/** Operational numbers are explicit inputs. Natural-language guidance is never executed. */
export const curriculumPolicySchema=z.object({
 version:z.literal(1),practiceQuestionMode:z.enum(['normal','pressure']).default('normal'),readingShare:z.number().min(.05).max(.35),quizShare:z.number().min(.05).max(.35),
 reflectionMinutes:z.number().int().min(0).max(15),videoMinimumMinutes:z.number().int().min(5).max(30),
 rehearsalDays:z.number().int().min(1).max(21),
}).strict().refine(value=>value.readingShare+value.quizShare<=.6,{message:'복습과 퀴즈 비중의 합은 60% 이하여야 해요.'});
export type CurriculumPolicy=z.infer<typeof curriculumPolicySchema>;
export const DEFAULT_CURRICULUM_POLICY:CurriculumPolicy={version:1,practiceQuestionMode:'normal',readingShare:.2,quizShare:.15,reflectionMinutes:5,videoMinimumMinutes:5,rehearsalDays:7};
export function curriculumPolicySnapshot(guideline?:{id?:unknown;version?:unknown;rules?:unknown}|null){
 const parsed=curriculumPolicySchema.safeParse(guideline?.rules);
 return {rules:parsed.success?parsed.data:{...DEFAULT_CURRICULUM_POLICY},basis:parsed.success?'published_rules' as const:'default_policy' as const,guidelineId:typeof guideline?.id==='string'?guideline.id:null,guidelineVersion:typeof guideline?.version==='number'?guideline.version:0};
}
