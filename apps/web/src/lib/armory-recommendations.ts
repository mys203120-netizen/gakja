import type {ExperienceCard,Experience} from './armory-model';
const signals:Record<Experience['category'],RegExp>={협업:/협업|협력|팀|갈등|의견|함께|소통|역할|조별/,실패:/실패|어려움|어려웠|한계|극복|다시|바꾸|도전/,강점:/강점|장점|기여|역할|잘하|도움/,탐구:/탐구|연구|실험|검증|확인|궁금|분석|조사/};
function relevance(experience:Experience,prompt:string){
 const words=[...new Set((prompt.match(/[가-힣A-Za-z0-9]{2,}/g)||[]).filter(word=>!['자신의','경험을','말해보세요','말해주세요','설명해','주세요','어떤','있나요','대해','통해'].includes(word)).map(word=>word.replace(/(에서|으로|에게|처럼|까지|부터|하고|하는|한|할|을|를|은|는|이|가|의|에|와|과)$/,'')))].filter(word=>word.length>=2);
 const source=[experience.title,experience.situation,experience.action,experience.result].join(' '),matched=words.filter(word=>source.includes(word));
 const category=signals[experience.category].test(prompt);
 return {score:(category?4:0)+matched.length,reason:category?`질문의 ${experience.category} 주제와 내가 정리한 경험 유형이 연결돼요.`:matched.length?`질문과 경험에 ‘${matched.slice(0,2).join('’, ‘')}’ 단서가 함께 있어요.`:''};
}
/** Transparent keyword suggestions, never a judgment of interview suitability. */
export function experienceQuestionSuggestions<T extends {id:string;prompt:string}>(experience:Experience,questions:T[]){return questions.map(question=>({question,...relevance(experience,question.prompt)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,3);}
export function questionExperienceSuggestions(prompt:string,cards:ExperienceCard[]){return cards.filter(card=>card.data.confirmed).map(card=>({card,...relevance(card.data,prompt)})).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||b.card.updated_at.localeCompare(a.card.updated_at)).slice(0,3);}
/** Move source sentences between sections without rewriting or creating facts. */
export function classifyExperienceText(original:string){
 const sections={situation:[] as string[],action:[] as string[],result:[] as string[]};
 for(const sentence of original.split(/\n+|(?<=[.!?。])\s+/).map(text=>text.trim()).filter(Boolean)){
  const key=/^(결과|배운 점|느낀 점)|그 결과|덕분에|배웠|깨달|알게 되었/.test(sentence)?'result':/^(내 행동|행동|내 역할)|저는|나는|제가|내가|제안했|정리했|확인했|실행했|맡았/.test(sentence)?'action':'situation';
  sections[key].push(sentence);
 }
 return Object.fromEntries(Object.entries(sections).map(([key,lines])=>[key,lines.join('\n').slice(0,2000)])) as Pick<Experience,'situation'|'action'|'result'>;
}
