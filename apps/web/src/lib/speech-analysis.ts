import { z } from 'zod';
import type { SpeechInterval, SpeechTelemetry } from './speech-telemetry';

export const SPEECH_ANALYSIS_VERSION = '2026-10-15.1';
const interval = z.object({ startMs: z.number().finite().nonnegative(), endMs: z.number().finite().positive() });
const telemetrySchema = z.object({
  version: z.literal(1), method: z.literal('rms-vad'), sampleIntervalMs: z.number().int().min(20).max(500),
  durationMs: z.number().finite().positive().max(1_200_000),
  speechSegments: z.array(interval).max(12_000), observedSegments: z.array(interval).max(12_000),
  analysis: z.object({ noiseFloorRms: z.number().finite().min(0).max(1), speechThresholdRms: z.number().finite().positive().max(1), peakRms: z.number().finite().min(0).max(1).optional() }),
  coverage: z.object({ observedMs: z.number().finite().nonnegative(), maxGapMs: z.number().finite().nonnegative(), truncated: z.boolean() }),
  limitations: z.array(z.enum(['background-noise-sensitive','high-background-level','capture-gaps'])).max(3),
});
const length = (segments: SpeechInterval[]) => segments.reduce((sum, item) => sum + item.endMs - item.startMs, 0);
function validIntervals(segments: SpeechInterval[], duration: number) {
  return segments.every((item, index) => item.endMs > item.startMs && item.endMs <= duration + 1 && (!index || item.startMs >= segments[index - 1].endMs));
}
/** Client timing is bounded evidence, never accepted as an unverified duration or score. */
export function validateSpeechTelemetry(value: unknown): SpeechTelemetry | null {
  const parsed = telemetrySchema.safeParse(value);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (!validIntervals(t.speechSegments,t.durationMs) || !validIntervals(t.observedSegments,t.durationMs)) return null;
  if (Math.abs(length(t.observedSegments) - t.coverage.observedMs) > Math.max(2,t.sampleIntervalMs)) return null;
  // No spoken interval may bridge an unobserved microphone gap.
  if (t.speechSegments.some(segment => !t.observedSegments.some(observed => segment.startMs >= observed.startMs - 2 && segment.endMs <= observed.endMs + 2))) return null;
  let gap = t.observedSegments[0]?.startMs || 0;
  for (let i=1;i<t.observedSegments.length;i++) gap = Math.max(gap,t.observedSegments[i].startMs-t.observedSegments[i-1].endMs);
  gap = Math.max(gap,t.durationMs-(t.observedSegments.at(-1)?.endMs||0));
  if (Math.abs(gap-t.coverage.maxGapMs)>Math.max(2,t.sampleIntervalMs)) return null;
  return t;
}
type TextHit = { text: string; count: number; offsets: number[] };
export type SpeechAnalysis = {
  version: string; status: 'measured' | 'partial' | 'not_measured';
  timing: null | { durationMs: number; observedMs: number; coverageRatio: number; voicedMs: number; silentMs: number; silenceRatio: number; speechSegments:SpeechInterval[]; observedSegments:SpeechInterval[]; pauses: Array<SpeechInterval & { durationMs: number; long: boolean }>; longPauseCount: number; leadingSilenceMs: number; trailingSilenceMs: number; source: 'microphone-rms'; resolutionMs: number; reliable: boolean };
  transcript: null | { source: string; text: string; eojeolCount: number; fillerCount: number; fillers: TextHit[]; repeatedWords: TextHit[]; repeatedPhrases: TextHit[]; countsAreLowerBounds: boolean; eojeolPerMinute: number | null };
  limitations: string[];
};
export function analyzeTranscript(text: string) {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({ text:match[0], normalized:match[0].toLocaleLowerCase('ko'), offset:match.index! }));
  const fillerMap = new Map<string,TextHit>();
  // Whole standalone sounds only: 어머니, 음악, 음성, 그니까요 are not silently truncated.
  const fillerPattern = /(?<![\p{L}\p{N}])(?:음+|어+|으음+|그니까|그러니까|그니깐|저기|뭐랄까)(?![\p{L}\p{N}])/gu;
  for (const match of text.matchAll(fillerPattern)) {
    const label=/^음+|^으음+/.test(match[0])?'음':/^어+$/.test(match[0])?'어':match[0];
    const hit = fillerMap.get(label) || {text:label,count:0,offsets:[]}; hit.count++;hit.offsets.push(match.index!);fillerMap.set(label,hit);
  }
  const stop = new Set(['저','제가','저는','그','이','것','것을','수','및','또','그리고','그래서','있는','있습니다','했습니다','합니다','the','a','and','i']);
  // A two-copy immediate echo is observable even when it is a one-eojeol sentence.
  const immediateRepeats=new Set(words.filter((word,index)=>index>0&&word.normalized===words[index-1].normalized&&/^[\s.,!?;:…·。！？、，：；]+$/u.test(text.slice(words[index-1].offset+words[index-1].text.length,word.offset))).map(word=>word.normalized));
  const wordMap = new Map<string,TextHit>();
  for (const word of words) {
    if (word.text.length < 2 || stop.has(word.normalized) || fillerMap.has(word.text)) continue;
    const hit=wordMap.get(word.normalized)||{text:word.text,count:0,offsets:[]};hit.count++;hit.offsets.push(word.offset);wordMap.set(word.normalized,hit);
  }
  const phraseMap = new Map<string,TextHit>();
  for (let n=4;n>=2;n--) for (let i=0;i<=words.length-n;i++) {
    const slice=words.slice(i,i+n); if(slice.every(word=>stop.has(word.normalized)))continue;
    const key=slice.map(word=>word.normalized).join(' '), hit=phraseMap.get(key)||{text:slice.map(word=>word.text).join(' '),count:0,offsets:[]};
    // Overlapping occurrences of a repeated word do not inflate a phrase count.
    const previous=hit.offsets.at(-1); if(previous===undefined||words.findIndex(word=>word.offset===previous)+n<=i){hit.count++;hit.offsets.push(slice[0].offset);phraseMap.set(key,hit);}
  }
  const repeatedPhrases=[...phraseMap.values()].filter(hit=>hit.count>=2).sort((a,b)=>b.text.length-a.text.length||b.count-a.count)
    .filter((hit,index,all)=>!all.slice(0,index).some(parent=>parent.text.includes(hit.text)&&parent.count===hit.count)).slice(0,8);
  const fillers=[...fillerMap.values()].sort((a,b)=>b.count-a.count);
  return {eojeolCount:text.trim()?text.trim().split(/\s+/).length:0,fillerCount:fillers.reduce((sum,hit)=>sum+hit.count,0),fillers,
    repeatedWords:[...wordMap.values()].filter(hit=>hit.count>=3||hit.count>=2&&immediateRepeats.has(hit.text.toLocaleLowerCase('ko'))).sort((a,b)=>b.count-a.count).slice(0,8),repeatedPhrases};
}
export function analyzeSpeech(input: {telemetry?: unknown; transcript?: string | null; transcriptSource?: string; durationMs?: number}): SpeechAnalysis {
  const telemetry=validateSpeechTelemetry(input.telemetry),raw=input.transcript?.trim();
  const hasAudio=!!telemetry;
  const limitations:string[]=[];
  let timing:SpeechAnalysis['timing']=null;
  if(telemetry) {
    const observedMs=length(telemetry.observedSegments),voicedMs=length(telemetry.speechSegments),coverageRatio=observedMs/telemetry.durationMs;
    const pauses:NonNullable<SpeechAnalysis['timing']>['pauses']=[];
    for(let i=1;i<telemetry.speechSegments.length;i++) {
      const startMs=telemetry.speechSegments[i-1].endMs,endMs=telemetry.speechSegments[i].startMs,durationMs=endMs-startMs;
      if(durationMs>=700&&telemetry.observedSegments.some(segment=>startMs>=segment.startMs&&endMs<=segment.endMs))pauses.push({startMs,endMs,durationMs,long:durationMs>=1500});
    }
    const reliable=coverageRatio>=.85&&!telemetry.coverage.truncated&&!telemetry.limitations.includes('high-background-level');
    const first=telemetry.speechSegments[0],last=telemetry.speechSegments.at(-1);
    timing={durationMs:telemetry.durationMs,observedMs,coverageRatio:Number(coverageRatio.toFixed(3)),voicedMs,silentMs:Math.max(0,observedMs-voicedMs),silenceRatio:observedMs?Number(((observedMs-voicedMs)/observedMs).toFixed(3)):0,speechSegments:telemetry.speechSegments,observedSegments:telemetry.observedSegments,pauses,longPauseCount:pauses.filter(p=>p.long).length,
      leadingSilenceMs:first&&telemetry.observedSegments.some(s=>s.startMs===0&&s.endMs>=first.startMs)?first.startMs:0,
      trailingSilenceMs:last&&telemetry.observedSegments.some(s=>s.endMs===telemetry.durationMs&&s.startMs<=last.endMs)?telemetry.durationMs-last.endMs:0,
      source:'microphone-rms',resolutionMs:telemetry.sampleIntervalMs,reliable};
    limitations.push('음량으로 구분한 발화·쉼 추정치이며 배경 소음과 작은 목소리의 영향을 받아요.');
    if(!reliable)limitations.push('수집 누락 또는 주변 소음이 있어 이번 시간 측정은 부분 기록이에요.');
  }
  const countsAreLowerBounds=input.transcriptSource!=='verbatim_manual';
  const transcript=raw?{source:input.transcriptSource||'stored_transcript',text:raw,...analyzeTranscript(raw),countsAreLowerBounds,
    eojeolPerMinute:hasAudio&&timing?.reliable&&timing.durationMs>=3000?Math.round(analyzeTranscript(raw).eojeolCount*60_000/timing.durationMs):null}:null;
  if(transcript&&countsAreLowerBounds)limitations.push('습관어·반복은 원전사에서 확인한 횟수예요. 음성 인식이 생략한 말은 집계되지 않아 실제보다 적을 수 있어요.');
  if(!timing)limitations.push('녹음의 시간 측정이 없어 쉼과 말하기 속도는 계산하지 않았어요.');
  return {version:SPEECH_ANALYSIS_VERSION,status:timing?(timing.reliable?'measured':'partial'):'not_measured',timing,transcript,limitations};
}
