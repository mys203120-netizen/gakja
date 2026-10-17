import {createHash} from 'node:crypto';
import {parse,type DefaultTreeAdapterMap} from 'parse5';
import directory from '../data/school-directory.json';
import type {AdmissionCalendarCatalogue,AdmissionCalendarEntry,AdmissionCalendarSchool,AdmissionCalendarUnresolved} from './admission-calendar-model';

export const ACON_CALENDAR_URL='https://www.acon.io.kr/susi/calendar';
export const ACON_CALENDAR_MAX_BYTES=8*1024*1024;
type Node=DefaultTreeAdapterMap['node'];
const attr=(node:Node,key:string)=>'attrs' in node?node.attrs.find(item=>item.name===key)?.value:undefined;
const children=(node:Node):Node[]=>'childNodes' in node?node.childNodes:[];
const tag=(node:Node,name:string)=>'tagName' in node&&node.tagName===name;
const text=(node:Node):string=>node.nodeName==='#text'?(node as DefaultTreeAdapterMap['textNode']).value:children(node).map(text).join('');
const tidy=(value:string)=>value.replace(/\s+/g,' ').trim();
const cellText=(node:Node)=>tidy(children(node).map(text).join(' '));
function all(node:Node,predicate:(node:Node)=>boolean,result:Node[]=[]):Node[]{if(predicate(node))result.push(node);for(const child of children(node))all(child,predicate,result);return result;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const key=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();

const aliases:Record<string,string>={
  '공주대학교':'국립공주대학교','창원대학교':'국립창원대학교','한밭대학교':'국립한밭대학교',
  '부경대학교':'국립부경대학교','한국해양대학교':'국립한국해양대학교','한국교통대학교':'국립한국교통대학교','한경대학교':'한경국립대학교',
  '지스트(GIST)':'광주과학기술원 GIST','디지스트(DGIST)':'대구경북과학기술원 DGIST',
  '유니스트(UNIST)':'울산과학기술원 UNIST','포스텍(POSTECH)':'포항공과대학교 POSTECH',
  '카이스트(KAIST)':'한국과학기술원 KAIST','켄텍(KENTECH)':'한국에너지공과대학교 KENTECH',
};
const separateAdmissions=/^(건국대학교\(글로컬\)|동국대학교\(WISE\)|고려대학교\(세종\)|연세대학교\(미래\)|한양대학교\(ERICA\))$/i;
const internalCampuses:Record<string,{canonical:string;campus:string}>={
  '단국대학교(천안)':{canonical:'단국대학교',campus:'천안'},
  '홍익대학교(세종)':{canonical:'홍익대학교',campus:'세종'},
  '상명대학교(천안)':{canonical:'상명대학교',campus:'천안'},
  '강원대학교(강릉)':{canonical:'강원대학교',campus:'강릉'},
  '강원대학교(도계)':{canonical:'강원대학교',campus:'도계'},
  '강원대학교(삼척)':{canonical:'강원대학교',campus:'삼척'},
  '경북대학교(상주)':{canonical:'경북대학교',campus:'상주'},
  '부산대학교(밀양)':{canonical:'부산대학교',campus:'밀양'},
  '부산대학교(양산)':{canonical:'부산대학교',campus:'양산'},
};
const mainCampus:Record<string,string>={'단국대학교':'죽전','홍익대학교':'서울','상명대학교':'서울','강원대학교':'춘천','경북대학교':'대구','부산대학교':'부산'};
export function matchAconUniversity(sourceUniversity:string) {
  if(separateAdmissions.test(sourceUniversity))return null;
  const branch=internalCampuses[sourceUniversity],canonical=branch?.canonical||aliases[sourceUniversity]||sourceUniversity;
  const school=directory.schools.find(school=>key(school.canonicalName)===key(canonical)||key(school.university)===key(canonical));
  return school?{schoolReferenceId:school.id,university:school.university,canonicalName:school.canonicalName,
    sourceCampus:branch?.campus||mainCampus[canonical]||null}:null;
}

export type ParsedCalendarDates={dates:string[];segments:Array<{startDate:string;endDate:string}>;reason:string|null};
/** Parses the publisher's validated Korean date cells, including separated ranges. No weekday or date guesses. */
export function parseAconDateCell(raw:string,calendarYear:number):ParsedCalendarDates {
  const value=tidy(raw);
  if(/원문 확인|미공개|미정|추후|확정하지|없음/.test(value))return {dates:[],segments:[],reason:'원문 확인이 필요한 일정'};
  if(!Number.isInteger(calendarYear)||calendarYear<2024||calendarYear>2040)return {dates:[],segments:[],reason:'일정 연도 확인 필요'};
  const matches=[...value.matchAll(/(\d{1,2})월\s*(\d{1,2})일\s*\(([일월화수목금토])\)/g)];
  if(!matches.length)return {dates:[],segments:[],reason:'날짜를 읽을 수 없음'};
  const dates:string[]=[],segments:Array<{startDate:string;endDate:string}>=[];
  const iso=(month:number,day:number,weekday:string)=>{
    const date=new Date(Date.UTC(calendarYear,month-1,day));
    if(date.getUTCFullYear()!==calendarYear||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||'일월화수목금토'[date.getUTCDay()]!==weekday)return null;
    return date.toISOString().slice(0,10);
  };
  const tokens=matches.map(match=>({date:iso(Number(match[1]),Number(match[2]),match[3]),start:match.index!,end:match.index!+match[0].length}));
  if(tokens.some(token=>!token.date))return {dates:[],segments:[],reason:'요일 또는 날짜 불일치'};
  if(value.slice(0,tokens[0].start).trim()||value.slice(tokens.at(-1)!.end).trim())return {dates:[],segments:[],reason:'추가 조건을 원문에서 확인해야 함'};
  const gaps=tokens.slice(0,-1).map((token,index)=>value.slice(token.end,tokens[index+1].start).trim());
  const rangeGap=(gap:string)=>/^[~∼〜–—-]$/.test(gap);
  if(gaps.some(gap=>!rangeGap(gap)&&!/^[,·/\s]*$/.test(gap))||gaps.some((gap,index)=>index>0&&rangeGap(gap)&&rangeGap(gaps[index-1])))return {dates:[],segments:[],reason:'날짜 사이 조건을 읽을 수 없음'};
  for(let index=0;index<tokens.length;index++){
    const current=tokens[index],next=tokens[index+1];let end=current.date!;
    const gap=next?value.slice(current.end,next.start).trim():'';
    if(next&&/^[~∼〜–—-]$/.test(gap)){end=next.date!;index++;}
    else if(next&&!/^[,·/\s]*$/.test(gap))return {dates:[],segments:[],reason:'날짜 사이 조건을 읽을 수 없음'};
    if(end<current.date!||(Date.parse(end)-Date.parse(current.date!))/86400000>31)return {dates:[],segments:[],reason:'날짜 범위 확인 필요'};
    segments.push({startDate:current.date!,endDate:end});
    for(let day=Date.parse(current.date!);day<=Date.parse(end);day+=86400000)dates.push(new Date(day).toISOString().slice(0,10));
  }
  return {dates:[...new Set(dates)].sort(),segments,reason:null};
}

function departmentHints(block:Node,calendarYear:number){
  return all(block,node=>tag(node,'li')).flatMap(li=>{
    const bold=children(li).find(node=>tag(node,'b'));if(!bold)return [];
    const header=tidy(text(bold)),match=header.match(/^(.*?)\s*·\s*(면접|논술|실기|기타)\s+(.+)$/);if(!match||match[2]!=='면접')return [];
    const rawDate=match[3].replace(/\s+외$/,'').trim(),parsed=parseAconDateCell(rawDate,calendarYear),label=tidy(text(li).slice(text(bold).length));
    return label&&parsed.dates.length?[{trackLabel:match[1].trim(),dates:parsed.dates,firstOnly:/\s+외$/.test(match[3]),label}]:[];
  });
}
const count=(node:Node)=>{const value=cellText(node).match(/^(\d+)\s*개/);return value?Number(value[1]):null;};
export function splitAdmissionDepartments(label:string) {
  const result:string[]=[];let start=0,depth=0;
  for(let index=0;index<label.length;index++){
    if(label[index]==='(')depth++;
    else if(label[index]===')')depth=Math.max(0,depth-1);
    else if(label[index]===','&&depth===0){result.push(label.slice(start,index).trim());start=index+1;}
  }
  result.push(label.slice(start).trim());return result.filter(Boolean);
}

export function parseAconInterviewCalendar(html:string,options:{checkedAt?:string}={}):AdmissionCalendarCatalogue {
  if(Buffer.byteLength(html,'utf8')>ACON_CALENDAR_MAX_BYTES)throw new Error('면접 일정 원문이 허용 크기를 넘었습니다.');
  const document=parse(html),titleNode=all(document,node=>tag(node,'title'))[0],title=titleNode?tidy(text(titleNode)):'';
  const yearMatch=title.match(/(20\d{2})\s*수시/),admissionYear=Number(yearMatch?.[1]);
  if(!yearMatch||!title.includes('고사 일정'))throw new Error('면접 수시 일정 페이지 형식을 확인해 주세요.');
  const calendarYear=admissionYear-1;
  if(!html.includes(`${calendarYear}년`)||admissionYear<2024||admissionYear>2040)throw new Error('모집 연도와 실제 고사 연도를 확인할 수 없습니다.');
  const checkedAt=options.checkedAt||new Date().toISOString();if(!Number.isFinite(Date.parse(checkedAt)))throw new Error('확인 시각이 올바르지 않습니다.');
  const universitySection=all(document,node=>attr(node,'id')==='universities')[0];
  if(!universitySection)throw new Error('대학별 일정 원문이 없습니다.');
  const blocks=all(universitySection,node=>tag(node,'details')&&!!attr(node,'data-exam-univ'));
  if(blocks.length<100||blocks.length>400)throw new Error('대학별 일정 개수가 예상 범위를 벗어났습니다.');
  const names=blocks.map(block=>attr(block,'data-exam-univ')!);
  if(new Set(names).size!==names.length)throw new Error('대학별 일정이 중복되었습니다.');
  const schools:AdmissionCalendarSchool[]=directory.schools.map(school=>({schoolReferenceId:school.id,university:school.university,canonicalName:school.canonicalName,sourceUniversities:[],status:'not_listed',entries:[],unresolved:[]}));
  let sourceRows=0,sourceInterviewRows=0,excludedNonInterviewRows=0,matchedSourceUniversities=0;
  const excludedUniversityNames:string[]=[];
  for(const block of blocks){
    const sourceUniversity=attr(block,'data-exam-univ')!,match=matchAconUniversity(sourceUniversity);
    const school=match?schools.find(school=>school.schoolReferenceId===match.schoolReferenceId)!:null;
    if(school){school.sourceUniversities.push(sourceUniversity);matchedSourceUniversities++;}else excludedUniversityNames.push(sourceUniversity);
    const hints=departmentHints(block,calendarYear);
    for(const row of all(block,node=>tag(node,'tr')&&attr(node,'data-exam-entry')==='true')){
      sourceRows++;const kind=attr(row,'data-kind');if(kind!=='면접'){excludedNonInterviewRows++;continue;}sourceInterviewRows++;
      if(!school||!match)continue;
      const cells=children(row).filter(node=>tag(node,'td'));if(cells.length!==4)throw new Error(`${sourceUniversity} 면접 일정 열을 읽을 수 없습니다.`);
      const trackLabel=cellText(cells[1]),rawDate=cellText(cells[2]),parsed=parseAconDateCell(rawDate,calendarYear);
      const id=`acon_${hash([school.schoolReferenceId,sourceUniversity,trackLabel,rawDate].join('|')).slice(0,24)}`;
      if(!parsed.dates.length){school.unresolved.push({id,sourceUniversity,kind:'interview',trackLabel,rawDate,reason:parsed.reason||'날짜 확인 필요',departmentCount:count(cells[3]),sourceUrl:ACON_CALENDAR_URL});continue;}
      const hint=hints.find(hint=>key(hint.trackLabel)===key(trackLabel)&&(hint.firstOnly?hint.dates[0]===parsed.dates[0]:hint.dates.join('|')===parsed.dates.join('|')));
      const departmentLabel=hint?.label||null;
      const entry:AdmissionCalendarEntry={id,kind:'interview',schoolReferenceId:school.schoolReferenceId,sourceUniversity,sourceCampus:match.sourceCampus,
        startDate:parsed.dates[0],endDate:parsed.dates.at(-1)!,dates:parsed.dates,segments:parsed.segments,trackLabel,departmentLabel,
        departments:departmentLabel?splitAdmissionDepartments(departmentLabel):[],departmentCount:count(cells[3]),rawDate,
        note:'전형·모집단위별 학교 고사 일정이며 개인별 배정일은 아닙니다.',sourceUrl:ACON_CALENDAR_URL};
      if(school.entries.some(other=>other.id===entry.id))throw new Error(`${sourceUniversity} 면접 일정 식별자가 중복되었습니다.`);
      school.entries.push(entry);
    }
  }
  const needsSection=all(document,node=>attr(node,'id')==='needs-check')[0];
  if(needsSection)for(const row of all(needsSection,node=>tag(node,'tr'))){
    const cells=children(row).filter(node=>tag(node,'td')||tag(node,'th'));if(cells.length!==4||!tag(cells[0],'th'))continue;
    const universityText=children(cells[0]).filter(node=>node.nodeName==='#text').map(text).join('');
    const sourceUniversity=tidy(universityText),match=matchAconUniversity(sourceUniversity);if(!match)continue;
    const school=schools.find(school=>school.schoolReferenceId===match.schoolReferenceId)!;
    const trackLabel=cellText(cells[1]),rawDate=cellText(cells[3]);
    // Unpublished rows do not expose a category. Preserve that uncertainty rather than label them interviews.
    const kind=/면접/.test(rawDate)?'interview':/미공개|날짜 없음/.test(rawDate)?'unclassified':null;if(!kind)continue;
    const id=`acon_unresolved_${hash([school.schoolReferenceId,sourceUniversity,trackLabel,rawDate].join('|')).slice(0,24)}`;
    if(!school.unresolved.some(entry=>entry.sourceUniversity===sourceUniversity&&entry.trackLabel===trackLabel&&entry.rawDate===rawDate))school.unresolved.push({id,sourceUniversity,kind,trackLabel,rawDate,reason:'날짜 확인 필요: 입학처 원문 확인 필요',departmentCount:count(cells[2]),sourceUrl:ACON_CALENDAR_URL});
  }
  if(sourceInterviewRows<100||matchedSourceUniversities<70)throw new Error('면접 일정 원문이 크게 누락되어 기존 자료를 교체하지 않습니다.');
  for(const school of schools){
    school.entries.sort((a,b)=>a.startDate.localeCompare(b.startDate)||a.trackLabel.localeCompare(b.trackLabel,'ko'));
    school.status=school.entries.length?'available':school.unresolved.length?'needs_review':school.sourceUniversities.length?'no_interview':'not_listed';
  }
  const importedInterviewRows=schools.reduce((total,school)=>total+school.entries.length,0);
  if(importedInterviewRows<100)throw new Error('등록 대학 면접 일정이 크게 누락되어 기존 자료를 교체하지 않습니다.');
  return {schemaVersion:1,source:{url:ACON_CALENDAR_URL,title,admissionYear,calendarYear,checkedAt,sha256:hash(html),kind:'third_party_calendar',season:'susi'},schools,
    audit:{registeredSchools:schools.length,sourceUniversities:blocks.length,matchedSourceUniversities,excludedSourceUniversities:excludedUniversityNames.length,
      sourceRows,sourceInterviewRows,importedInterviewRows,importedDateOccurrences:schools.reduce((total,school)=>total+school.entries.reduce((sum,entry)=>sum+entry.dates.length,0),0),
      availableSchools:schools.filter(school=>school.status==='available').length,needsReviewSchools:schools.filter(school=>school.status==='needs_review').length,
      notListedSchools:schools.filter(school=>school.status==='not_listed').length,noInterviewSchools:schools.filter(school=>school.status==='no_interview').length,
      unresolvedInterviewRows:schools.reduce((total,school)=>total+school.unresolved.filter(entry=>entry.kind==='interview').length,0),unclassifiedUnresolvedRows:schools.reduce((total,school)=>total+school.unresolved.filter(entry=>entry.kind==='unclassified').length,0),
      excludedNonInterviewRows,missingSchools:schools.filter(school=>school.status==='not_listed').map(school=>school.university),noInterviewSchoolNames:schools.filter(school=>school.status==='no_interview').map(school=>school.university),excludedUniversityNames}};
}

/** Public fetch only. Caller owns persistence so a failed refresh never replaces the last good snapshot. */
export async function fetchAconInterviewCalendar(options:{checkedAt?:string;signal?:AbortSignal}={}) {
  const timeout=AbortSignal.timeout(25_000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
  const response=await fetch(ACON_CALENDAR_URL,{signal,headers:{accept:'text/html', 'user-agent':'GakjaON admissions-calendar/1.0'},redirect:'error',cache:'no-store'});
  if(!response.ok)throw new Error(`면접 일정 조회 실패 (HTTP ${response.status})`);
  if(!response.headers.get('content-type')?.includes('text/html'))throw new Error('면접 일정 응답 형식이 올바르지 않습니다.');
  const announced=Number(response.headers.get('content-length'));if(announced>ACON_CALENDAR_MAX_BYTES)throw new Error('면접 일정 응답이 너무 큽니다.');
  const reader=response.body?.getReader();if(!reader)throw new Error('면접 일정 응답이 비어 있습니다.');
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>ACON_CALENDAR_MAX_BYTES){await reader.cancel();throw new Error('면접 일정 응답이 너무 큽니다.');}chunks.push(value);}
  return parseAconInterviewCalendar(Buffer.concat(chunks).toString('utf8'),options);
}
