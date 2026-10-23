export type StudentSection = 'home' | 'today' | 'preparation';
export const STUDENT_NAVIGATION = [
  {id:'home',href:'/my',label:'홈'},
  {id:'today',href:'/training',label:'훈련하기'},
  {id:'preparation',href:'/preparation',label:'마이 대시보드'},
] as const;
/** The same three destinations are available on every screen size. */
export const MOBILE_STUDENT_NAVIGATION = STUDENT_NAVIGATION;
const within=(path:string,root:string)=>path===root||path.startsWith(root+'/');
export function mobileStudentActive(path:string,href:string) {
  return Boolean(studentSection(href)&&studentSection(path)===studentSection(href));
}
export function studentSection(path:string):StudentSection|null {
  if(path==='/my')return 'home';
  if(['/preparation','/records','/reports','/armory','/knowledge','/materials','/schools','/account','/availability'].some(root=>within(path,root)))return 'preparation';
  if(['/training','/my','/learn','/quiz','/interview','/practice','/chat/interviews','/on'].some(root=>within(path,root)))return 'today';
  return null;
}
export const RESOURCE_SECTIONS=[
  {href:'/preparation',label:'대시보드'},
  {href:'/records',label:'기록·리포트'},
  {href:'/armory',label:'내 경험'},
  {href:'/materials',label:'학생부·교재'},
  {href:'/knowledge',label:'지식한입'},
  {href:'/materials/briefings',label:'시사 브리핑'},
  {href:'/schools',label:'지원 학교'},
] as const;
export const PRACTICE_SECTIONS=[
  {href:'/training',label:'오늘 훈련'},
  {href:'/learn',label:'자유 연습'},
  {href:'/on',label:'AI 비서'},
] as const;
export function resourceSectionHref(path:string) {
  if(studentSection(path)!=='preparation')return null;
  if(within(path,'/account/confirmations'))return '/account/confirmations';
  if(within(path,'/preparation'))return '/preparation';
  if(within(path,'/records')||within(path,'/reports'))return '/records';
  if(within(path,'/armory'))return '/armory';
  if(within(path,'/knowledge'))return '/knowledge';
  if(within(path,'/materials/briefings'))return '/materials/briefings';
  if(within(path,'/schools'))return '/schools';
  return '/materials';
}
export function practiceSectionHref(path:string) {
  if(within(path,'/my')||within(path,'/training'))return '/training';
  if(within(path,'/on')&&!within(path,'/on/interviews'))return '/on';
  return '/learn';
}
/** Keep the primary navigation available; remove browsing tabs during an answer. */
export function isAnswerWorkspace(path:string) {
  return /^\/(?:my\/(?:train|diagnosis)|quiz\/(?:session|assignments)\/[^/]+|interview\/(?!new(?:\/|$)|chat(?:\/|$)|live(?:\/|$))[^/]+|practice\/video\/[^/]+|chat\/interviews\/[^/]+|on\/interviews\/(?!new(?:\/|$))[^/]+)(?:\/|$)/.test(path);
}

/** A known in-app parent also works when a detail URL was opened directly. */
export function mobileParent(path:string):{href:string;label:string}|null {
  if(['/my','/training','/preparation'].includes(path))return null;
  if(path==='/records')return {href:'/preparation',label:'마이 대시보드'};
  if(within(path,'/account')&&!within(path,'/account/confirmations'))return path==='/account'?{href:'/preparation',label:'마이 대시보드'}:{href:'/account',label:'내 계정'};
  if(within(path,'/reports')||within(path,'/records'))return {href:'/records',label:'내 기록'};
  if(within(path,'/schools')&&path!=='/schools')return {href:'/schools',label:'지원 학교'};
  if(within(path,'/knowledge')&&path!=='/knowledge')return {href:'/knowledge',label:'지식한입'};
  if(within(path,'/materials')&&path!=='/materials'&&path!=='/materials/briefings'){
    const section=path.split('/')[2],labels:Record<string,string>={activities:'활동',questions:'예상 질문',answers:'답변 초안',briefings:'시사 브리핑'};
    return path.split('/').length>3&&labels[section]?{href:'/materials/'+section,label:labels[section]}:{href:'/materials',label:'학생부·교재'};
  }
  if(studentSection(path)==='preparation')return {href:'/preparation',label:'마이 대시보드'};
  if(within(path,'/on')&&!within(path,'/on/interviews'))return {href:'/training',label:'훈련하기'};
  if(studentSection(path)==='today')return {href:path==='/learn'||within(path,'/my')?'/training':'/learn',label:path==='/learn'||within(path,'/my')?'훈련하기':'자유 연습'};
  return null;
}
