export type StudentSection = 'today' | 'preparation' | 'records';
export const STUDENT_NAVIGATION = [
  {id:'today',href:'/my',label:'오늘 훈련'},
  {id:'preparation',href:'/preparation',label:'준비 현황'},
  {id:'records',href:'/records',label:'내 기록'},
] as const;
/** The same three destinations are available on every screen size. */
export const MOBILE_STUDENT_NAVIGATION = STUDENT_NAVIGATION;
const within=(path:string,root:string)=>path===root||path.startsWith(root+'/');
export function mobileStudentActive(path:string,href:string) {
  return Boolean(studentSection(href)&&studentSection(path)===studentSection(href));
}
export function studentSection(path:string):StudentSection|null {
  if(['/records','/reports'].some(root=>within(path,root)))return 'records';
  if(['/preparation','/armory','/knowledge','/materials','/schools','/account/confirmations'].some(root=>within(path,root)))return 'preparation';
  if(['/my','/learn','/quiz','/interview','/practice','/chat/interviews','/on','/availability'].some(root=>within(path,root)))return 'today';
  return null;
}
export const RESOURCE_SECTIONS=[
  {href:'/preparation',label:'전체 준비 현황'},
  {href:'/armory',label:'내 경험'},
  {href:'/materials',label:'학생부·교재'},
  {href:'/knowledge',label:'지식한입'},
  {href:'/materials/briefings',label:'시사 브리핑'},
  {href:'/schools',label:'지원 학교'},
] as const;
export const PRACTICE_SECTIONS=[
  {href:'/my',label:'오늘 계획'},
  {href:'/learn',label:'자유 연습'},
  {href:'/on',label:'AI 비서'},
] as const;
export function resourceSectionHref(path:string) {
  if(studentSection(path)!=='preparation')return null;
  if(within(path,'/account/confirmations'))return '/account/confirmations';
  if(within(path,'/preparation'))return '/preparation';
  if(within(path,'/armory'))return '/armory';
  if(within(path,'/knowledge'))return '/knowledge';
  if(within(path,'/materials/briefings'))return '/materials/briefings';
  if(within(path,'/schools'))return '/schools';
  return '/materials';
}
export function practiceSectionHref(path:string) {
  if(within(path,'/my')||within(path,'/availability'))return '/my';
  if(within(path,'/on')&&!within(path,'/on/interviews'))return '/on';
  return '/learn';
}
/** Keep the primary navigation available; remove browsing tabs during an answer. */
export function isAnswerWorkspace(path:string) {
  return /^\/(?:my\/(?:train|diagnosis)|quiz\/(?:session|assignments)\/[^/]+|interview\/(?!new(?:\/|$)|chat(?:\/|$)|live(?:\/|$))[^/]+|practice\/video\/[^/]+|chat\/interviews\/[^/]+|on\/interviews\/(?!new(?:\/|$))[^/]+)(?:\/|$)/.test(path);
}
