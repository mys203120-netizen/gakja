const KOREA_OFFSET_MS=9*60*60*1000;
const DAY_MS=24*60*60*1000;

export function millisecondsUntilNextKoreaDay(now=Date.now()):number {
  if(!Number.isFinite(now))return 60_000;
  return Math.max(1,(Math.floor((now+KOREA_OFFSET_MS)/DAY_MS)+1)*DAY_MS-KOREA_OFFSET_MS-now);
}

type RefreshClock={now:()=>number;setTimeout:(callback:()=>void,delay:number)=>ReturnType<typeof globalThis.setTimeout>;clearTimeout:(timer:ReturnType<typeof globalThis.setTimeout>)=>void};
/** One local timer per day. Its callback refreshes a plan; it never creates learning evidence. */
export function scheduleTrainingDayRefresh(refresh:()=>void,clock:RefreshClock={now:()=>Date.now(),setTimeout:(callback,delay)=>globalThis.setTimeout(callback,delay),clearTimeout:timer=>globalThis.clearTimeout(timer)}) {
  let active=true,timer:ReturnType<typeof globalThis.setTimeout>;
  function schedule(){timer=clock.setTimeout(()=>{if(!active)return;refresh();if(active)schedule();},millisecondsUntilNextKoreaDay(clock.now()));}
  schedule();
  return ()=>{active=false;clock.clearTimeout(timer);};
}
