import {z} from 'zod';
export const NONVERBAL_VERSION='sampled-movement-2026-10-23';
export const NONVERBAL_NOTICE='영상에서 추출한 일부 정지 화면의 관찰이에요. 표본 사이의 움직임, 반복 횟수, 시선·감정·태도는 판단하지 않아요.';
export type VideoSample={id:number;atMs:number;dataUrl:string};
export function nonverbalSampleTimes(durationMs:number){
  if(!Number.isFinite(durationMs)||durationMs<500||durationMs>1_200_000)return [];
  const count=Math.min(6,Math.max(2,Math.floor(durationMs/1000)));
  const start=Math.min(250,durationMs/10),end=Math.max(start,durationMs-250);
  return Array.from({length:count},(_,index)=>Math.round(start+(end-start)*index/(count-1)));
}
const sampleSchema=z.object({id:z.number().int().min(1).max(6),atMs:z.number().int().nonnegative(),dataUrl:z.string().max(280_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)}).strict();
export const nonverbalRequestSchema=z.object({mediaId:z.string().uuid(),samples:z.array(sampleSchema).min(2).max(6)}).strict();
export const nonverbalOutputSchema=z.object({status:z.enum(['observed','insufficient']),observations:z.array(z.object({category:z.enum(['head','hands','posture']),sampleIds:z.array(z.number().int().min(1).max(6)).min(1).max(6),description:z.string().trim().min(5).max(400),checkNext:z.string().trim().min(5).max(300)}).strict()).max(8),limitations:z.array(z.string().trim().min(3).max(400)).min(1).max(8)}).strict();
export function validateVideoSamples(value:unknown,durationMs:number){
  const samples=z.array(sampleSchema).min(2).max(6).parse(value),expected=nonverbalSampleTimes(durationMs);
  if(samples.length!==expected.length||samples.some((sample,index)=>sample.id!==index+1||Math.abs(sample.atMs-expected[index])>150||sample.atMs>=durationMs))throw Error('영상 길이와 표본 시간이 맞지 않아요. 다시 추출해 주세요.');
  return samples;
}
export function validateNonverbalOutput(value:unknown,samples:VideoSample[]){
  const parsed=nonverbalOutputSchema.parse(value);
  if(parsed.status==='observed'&&!parsed.observations.length||parsed.status==='insufficient'&&parsed.observations.length)throw Error('관찰 상태와 근거가 맞지 않습니다.');
  const prohibited=/시선|눈맞춤|감정|성격|태도|불안|긴장|자신감|소극|적극적|진실|거짓|집중력|산만|자주|반복|계속|항상|내내|빈도|횟수|합격|점수/;
  const observations=parsed.observations.map(item=>{
    if(prohibited.test(item.description+' '+item.checkNext))throw Error('표본에서 판단할 수 없는 평가가 포함되어 있습니다.');
    const ids=[...new Set(item.sampleIds)].sort((a,b)=>a-b);
    if(ids.length!==item.sampleIds.length||ids.some(id=>!samples.some(sample=>sample.id===id)))throw Error('존재하지 않는 표본을 참조했습니다.');
    return {...item,sampleIds:ids,timestampsMs:ids.map(id=>samples.find(sample=>sample.id===id)!.atMs)};
  });
  return {...parsed,observations,limitations:parsed.limitations.filter(item=>!prohibited.test(item)),notice:NONVERBAL_NOTICE,source:'browser_sampled_frames' as const,version:NONVERBAL_VERSION};
}
