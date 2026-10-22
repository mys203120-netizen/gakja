import { z } from 'zod';
const experienceFields = z.object({
 title:z.string().trim().max(120), category:z.enum(['협업','실패','강점','탐구']),
 situation:z.string().trim().max(2000), action:z.string().trim().max(2000), result:z.string().trim().max(2000),
 confirmed:z.boolean(), pinned:z.boolean().default(false),
 sourceNote:z.string().trim().max(400).default('학생이 직접 작성한 경험'),
 originalText:z.string().max(6000).optional(),
 writingOriginals:z.object({situation:z.string().max(2000).optional(),action:z.string().max(2000).optional(),result:z.string().max(2000).optional()}).strict().optional(),
 writingAssistance:z.array(z.object({requestId:z.string().uuid(),field:z.enum(['situation','action','result']),at:z.string().datetime()})).max(30).optional(),
});
/** A draft can be incomplete, including its optional title and confirmation fields. */
export const experienceDraftSchema = experienceFields.extend({title:z.string().trim().max(120).default('')}).transform(value=>({...value,confirmed:false}));
export const experienceSchema = experienceFields.extend({title:z.string().trim().min(1).max(120)}).refine(v=>!v.confirmed || Boolean(v.situation && v.action),{message:'상황과 직접 한 행동을 작성해 주세요.'});
/** A card receives its display title only at the explicit save boundary. */
export const experienceSaveSchema = experienceFields.transform(value=>({...value,title:value.title||`${value.category} 경험`})).refine(v=>!v.confirmed||Boolean(v.situation&&v.action),{message:'상황과 직접 한 행동을 작성해 주세요.'});
export type Experience = z.infer<typeof experienceSchema>;
export type ExperienceCard = {id:string;data:Experience;revision:number;updated_at:string};
export const experienceSteps = [
 {key:'situation',label:'상황',question:'어떤 일이 있었고, 무엇이 어려웠어?',hint:'언제, 누구와, 어떤 일을 했는지 떠올려봐.'},
 {key:'action',label:'내 행동',question:'그때 네가 직접 한 일은 뭐였어?',hint:'팀 전체가 한 일과 내가 한 일을 구분해 적어봐.'},
 {key:'result',label:'결과·배운 점',question:'그 뒤 달라진 점이나 배운 점이 있어?',hint:'기억나지 않으면 비워둬도 괜찮아. 성과를 만들 필요는 없어.'},
] as const;
export function experienceOutline(category:string,prompt=''){
 if(/지원|진로|전공/.test(prompt))return '관심을 갖게 된 이유 → 연결되는 경험 → 더 배우고 싶은 점';
 if(/가치|정직|판단/.test(prompt))return '나의 판단 기준 → 그 기준을 지킨 행동 → 배운 점';
 if(/다시 시도|한계|실패/.test(prompt))return '어려웠던 상황 → 바꾸려 한 행동 → 배운 점';
 if(/의견|협력|대화/.test(prompt))return '의견이 달랐던 상황 → 상대를 이해한 방법 → 함께 정한 방향';
 return category==='실패'?'어려웠던 상황 → 내가 시도한 일 → 배운 점':category==='강점'?'내 강점 → 그 강점이 드러난 행동 → 결과':category==='탐구'?'탐구를 시작한 이유 → 직접 확인한 과정 → 발견과 한계':'함께 해결할 문제 → 내가 맡은 역할과 행동 → 팀에 준 도움';}
