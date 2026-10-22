type Observation={label:string;change:string;beforeEvidence:string[];afterEvidence:string[]};
/** An observable text difference, never a judgement of improvement or factual accuracy. */
export function answerChangeSnapshot(elements:Observation[]){
  const usable=elements.filter(item=>item.afterEvidence?.some(text=>text.trim()));
  const selected=usable.find(item=>['added','changed'].includes(item.change))||usable.find(item=>item.beforeEvidence?.length);
  if(!selected)return null;
  return {label:selected.label,before:selected.beforeEvidence.filter(Boolean).join(' '),after:selected.afterEvidence.filter(Boolean).join(' '),changed:['added','changed'].includes(selected.change)};
}
