/** Imported reference-site attribution is internal; dates and admissions evidence remain visible. */
export function isReferenceCalendarUrl(value:unknown):boolean {
  if(typeof value!=='string'||!value.trim())return false;
  try {
    const url=new URL(value.trim().startsWith('//')?`https:${value.trim()}`:value.trim());
    const host=url.hostname.toLowerCase().replace(/\.$/,'');
    return ['http:','https:'].includes(url.protocol)&&(host==='acon.io.kr'||host.endsWith('.acon.io.kr'));
  }catch{return false;}
}
export function visibleCalendarSourceUrl(value:unknown):string {
  return typeof value==='string'&&!isReferenceCalendarUrl(value)?value:'';
}
export function visibleCalendarSourceLabel(value:unknown,url?:unknown):string {
  if(isReferenceCalendarUrl(url)||typeof value!=='string'||/아컨|아콘|\bacon\b/i.test(value))return '';
  return value;
}
export function visibleCalendarSourceText(value:unknown):string {
  if(typeof value!=='string')return '';
  return value.replace(/(?:https?:)?\/\/[^\s<>"'()]+/gi,url=>isReferenceCalendarUrl(url)?'':url)
    .replace(/(?:아컨|아콘|\bacon\b)(?:에서|에)?\s*/gi,'').trim();
}
/** Scrub only presentation metadata, leaving IDs, dates, revisions and internal source origin intact. */
export function presentCalendarSource<T extends {sourceUrl?:unknown;sourceLabel?:unknown;note?:unknown;rawDate?:unknown}>(row:T) {
  return {...row,
    ...('sourceUrl' in row?{sourceUrl:visibleCalendarSourceUrl(row.sourceUrl)}:{}),
    ...('sourceLabel' in row?{sourceLabel:visibleCalendarSourceLabel(row.sourceLabel,row.sourceUrl)}:{}),
    ...('note' in row?{note:row.note==null?row.note:visibleCalendarSourceText(row.note)}:{}),
    ...('rawDate' in row?{rawDate:visibleCalendarSourceText(row.rawDate)}:{})};
}
/** Hidden attribution must survive a date-only edit; an explicitly cleared field still wins. */
export function retainCalendarSourceFields(input:Record<string,unknown>,previous:Record<string,unknown>,fields:readonly string[]=['sourceUrl','note']) {
  return {...Object.fromEntries(fields.filter(key=>!Object.hasOwn(input,key)&&Object.hasOwn(previous,key)).map(key=>[key,previous[key]])),...input};
}
