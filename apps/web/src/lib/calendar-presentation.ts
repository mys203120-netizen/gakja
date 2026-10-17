export type CalendarSchoolTone={background:string;foreground:string;accent:string};
const schoolTones:CalendarSchoolTone[]=[
  {background:'#eaf6ef',foreground:'#24573d',accent:'#36966a'},
  {background:'#edf3ff',foreground:'#294e88',accent:'#537fca'},
  {background:'#f4effc',foreground:'#684184',accent:'#9a71b9'},
  {background:'#fff2e6',foreground:'#814c22',accent:'#c48b4e'},
  {background:'#fceef3',foreground:'#873e60',accent:'#bd7394'},
  {background:'#e8f5f7',foreground:'#24616a',accent:'#4095a4'},
  {background:'#f2f5df',foreground:'#56602a',accent:'#8b9b4b'},
  {background:'#faeee9',foreground:'#824c3e',accent:'#bb7a66'},
];
function hashSchool(key:string){let hash=2166136261;for(const char of key){hash^=char.codePointAt(0)!;hash=Math.imul(hash,16777619);}return hash>>>0;}
/** Stable across selection/order changes; avoid palette collisions among registered schools. */
export function calendarSchoolTones(keys:string[]):Record<string,CalendarSchoolTone>{
  const used=new Set<number>(),extraHues=new Set<number>(),tones:Record<string,CalendarSchoolTone>={};
  for(const key of [...new Set(keys)].sort()){
    if(used.size===schoolTones.length){
      let hue=hashSchool(key)%3600;while(extraHues.has(hue))hue=(hue+1375)%3600;extraHues.add(hue);
      tones[key]={background:`hsl(${hue/10} 52% 95%)`,foreground:'#263a31',accent:`hsl(${hue/10} 42% 45%)`};continue;
    }
    let index=hashSchool(key)%schoolTones.length;
    if(used.size<schoolTones.length)while(used.has(index))index=(index+1)%schoolTones.length;
    used.add(index);tones[key]=schoolTones[index];
  }
  return tones;
}
/** Date-only entries must never acquire a made-up midnight appointment. */
export function calendarInterviewTime(personalAt?:string,format?:string):string{
  if(format==='video_submission')return '제출기간';
  if(!personalAt?.includes('T'))return '시간 미정';
  const date=new Date(personalAt);
  if(!Number.isFinite(date.getTime()))return '시간 미정';
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
}
