import {z} from 'zod';
import type {Experience} from './armory-model';
export const armorySuggestionSchema=z.object({
  sections:z.object({situation:z.array(z.string().min(1).max(2000)).max(8),action:z.array(z.string().min(1).max(2000)).max(8),result:z.array(z.string().min(1).max(2000)).max(8)}).strict(),
  checks:z.array(z.string().min(1).max(400)).max(4),
  questions:z.array(z.object({id:z.string(),reason:z.string().min(1).max(300)}).strict()).max(3),
}).strict();
/** AI may organize existing phrases; new facts can only be supplied by the student. */
export function validateArmorySuggestion(value:unknown,experience:Experience,allowedIds:Set<string>){
  const suggestion=armorySuggestionSchema.parse(value),source=[experience.situation,experience.action,experience.result];
  for(const key of ['situation','action','result'] as const){
    if(suggestion.sections[key].some(quote=>!source.some(text=>text.includes(quote))))throw new Error('AI가 원문에 없는 내용을 제안했어요. 다시 시도해 주세요.');
    if(suggestion.sections[key].join('\n').length>2000)throw new Error('정리한 경험이 너무 길어요.');
  }
  if(suggestion.questions.some(question=>!allowedIds.has(question.id)))throw new Error('현재 지원처의 질문 연결을 확인하지 못했어요.');
  return suggestion;
}
