/** Writing scaffolds ask for the student's facts; they never invent a finished answer. */
export const ANSWER_DIRECTIONS = [
  {id:'role',label:'내 역할',prompt:'여럿이 한 일 중 내가 직접 맡은 행동은 무엇이었나요?'},
  {id:'reason',label:'행동 이유',prompt:'그 행동을 선택한 이유나 어려움을 어떻게 풀었나요?'},
  {id:'learning',label:'배운 점',prompt:'그 경험에서 배운 점과 다음에 바꿔 볼 행동은 무엇인가요?'},
] as const;
export function appendStudentSentence(original:string,sentence:string){return [original.trimEnd(),sentence.trim()].filter(Boolean).join('\n\n');}
export function sameTranscriptWords(original:string,proposed:string){return original.replace(/\s/gu,'')===proposed.replace(/\s/gu,'');}
export function speakingLayouts(original:string){
  const text=original.trim();
  return [
    {id:'sentences',label:'한 문장씩',text:text.replace(/([.!?。！？])\s+/gu,'$1\n\n')},
    {id:'breaths',label:'쉼표에서 호흡 나누기',text:text.replace(/([,，;；.!?。！？])\s+/gu,'$1\n')},
    {id:'short',label:'짧게 끊어 읽기',text:text.split(/\s+/u).reduce<string[]>((lines,word)=>{const last=lines.length-1;if(last<0||lines[last].length+word.length>38)lines.push(word);else lines[last]+=' '+word;return lines;},[]).join('\n')},
  ].filter(option=>sameTranscriptWords(original,option.text));
}
// Only sentence-ending register changes are allowed. Facts, uncertainty and negation stay in place.
const politeEndings:Record<string,string>={'아니에요':'아닙니다','아니야':'아닙니다','몰라요':'모릅니다','모르겠어요':'모르겠습니다','못했어요':'못했습니다','않았어요':'않았습니다','않아요':'않습니다','같아요':'같습니다','했어요':'했습니다','했어':'했습니다','했다':'했습니다','였어요':'였습니다','이었어요':'이었습니다','있어요':'있습니다','없어요':'없습니다','좋아요':'좋습니다','생각해요':'생각합니다','해요':'합니다','이에요':'입니다','예요':'입니다'};
const endingPattern=new RegExp('('+Object.keys(politeEndings).sort((a,b)=>b.length-a.length).join('|')+')(?=[.!?。！？](?:\\s|$)|$)','gu');
export function speakingToneChanges(original:string){const changes:Array<{before:string;after:string}>=[];original.replace(endingPattern,before=>{changes.push({before,after:politeEndings[before]});return before;});return changes;}
export function speakingSuggestions(original:string){
  const formal=original.replace(endingPattern,before=>politeEndings[before]);
  return [
    {id:'sentences',label:'내 표현 유지 · 한 문장씩',text:speakingLayouts(original)[0].text},
    {id:'polite',label:'면접 존댓말로',text:speakingLayouts(formal)[0].text},
    {id:'polite-short',label:'존댓말로 짧게 끊어 읽기',text:speakingLayouts(formal)[2].text},
  ];
}
export function isSafeSpeakingSuggestion(original:string,proposed:string){return speakingSuggestions(original).some(option=>option.text===proposed);}
