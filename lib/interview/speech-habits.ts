export interface HabitOccurrence {
  id: string;
  answerId: string;
  start: number;
  end: number;
  surface: string;
  classification: 'filler' | 'context_candidate';
  observedInTranscript: true;
  evidence: string;
  timestampMs: null;
  confidence: null;
}

/** Offsets are UTF-16 offsets in the untouched STT transcript. Recompute to replace revisions. */
export function observeSpeechHabits(answerId: string, rawTranscript: string, durationMs: number) {
  const occurrences: HabitOccurrence[] = [];
  const words = /(?<![\p{L}\p{N}])(어+|음+|그|저|저기|약간|이제)(?![\p{L}\p{N}])/gu;
  for(const match of rawTranscript.matchAll(words)) {
    const start = match.index, surface = match[0];
    const certain = surface === '어' || surface === '음';
    occurrences.push({id:`${answerId}:${start}:${start+surface.length}`,answerId,start,end:start+surface.length,surface,
      classification:certain?'filler':'context_candidate',observedInTranscript:true,
      evidence:certain?'독립된 추임새 토큰':'의미 있는 용법·반복 발화 가능성: 문맥 확인 전 횟수 확정 안 함',timestampMs:null,confidence:null});
  }
  const confirmedCount = occurrences.filter(o=>o.classification==='filler').length;
  const eojeols = rawTranscript.trim() ? rawTranscript.trim().split(/\s+/u).length : 0;
  return {occurrences,confirmedCount,candidateCount:occurrences.length-confirmedCount,
    confirmedPerMinute:Number.isFinite(durationMs)&&durationMs>0?confirmedCount*60000/durationMs:null,
    confirmedPer100Eojeol:eojeols>0?confirmedCount*100/eojeols:null,
    scope:'STT 전사에 관찰된 항목만 집계; 원음 전체의 정확한 추임새 횟수를 의미하지 않음'};
}
