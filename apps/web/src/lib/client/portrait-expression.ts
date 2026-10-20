import type {InterviewerAvatarState} from './interviewer-avatar';
export const PORTRAIT_EYES:Readonly<Record<string,readonly [number,number,number,number][]>>={
  'clay-a':[[535,485,58,27],[737,464,57,29]],'clay-b':[[535,438,49,22],[708,427,49,22]],
  'clay-c':[[540,500,51,23],[711,488,49,23]],'clay-d':[[542,434,49,21],[713,424,48,22]],
  'clay-e':[[550,503,50,23],[721,485,48,23]],
};
/** Subtle, deterministic motion; it never drives mouth opening or changes the person's identity. */
export function portraitExpressionFrame(state:InterviewerAvatarState,timeMs:number,seed:number,reduced=false){
  if(reduced||state==='idle')return {tilt:0,y:0,gaze:0,blink:0};
  const t=Math.max(0,timeMs)/1000,offset=seed*.73,cycle=(t+offset)%5.2;
  const blink=cycle<.18?Math.sin(cycle/.18*Math.PI):0;
  return {tilt:state==='thinking'?Math.sin(t*.7+offset)*1.1:Math.sin(t*.75+offset)*.32,
    y:state==='listening'?Math.sin(t*2.2+offset)*.65:Math.sin(t*.9+offset)*.25,
    gaze:state==='thinking'?Math.sin(t*.55+offset)*1.6:Math.sin(t*.35+offset)*.45,blink};
}
