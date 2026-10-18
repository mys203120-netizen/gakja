export type StudentSection = 'today' | 'practice' | 'assistant' | 'resources' | 'reports' | 'armory';
export const STUDENT_NAVIGATION = [
  {id:'today',href:'/my',label:'오늘'},
  {id:'practice',href:'/learn',label:'연습'},
  {id:'assistant',href:'/on',label:'AI 비서'},
  {id:'armory',href:'/armory',label:'무기고',description:'내 경험 정리'},
  {id:'resources',href:'/knowledge',label:'자료'},
  {id:'reports',href:'/records',label:'내 리포트'},
] as const;
/** Mobile keeps five destinations; personal experience preparation opens from 연습. */
export const MOBILE_STUDENT_NAVIGATION = STUDENT_NAVIGATION.filter(item=>item.id!=='armory');
export function mobileStudentActive(path:string,href:string) {
  if(href==='/on')return within(path,'/on')&&!within(path,'/on/interviews');
  if(href==='/learn'&&within(path,'/armory'))return true;
  return Boolean(studentSection(href)&&studentSection(path)===studentSection(href));
}
const within=(path:string,root:string)=>path===root||path.startsWith(root+'/');
export function studentSection(path:string):StudentSection|null {
  if(within(path,'/armory'))return 'armory';
  if(within(path,'/my'))return 'today';
  if(['/learn','/quiz','/interview','/practice','/chat/interviews','/on/interviews'].some(root=>within(path,root)))return 'practice';
  if(within(path,'/on'))return 'assistant';
  if(['/knowledge','/materials','/schools','/account/confirmations'].some(root=>within(path,root)))return 'resources';
  if(['/records','/reports'].some(root=>within(path,root)))return 'reports';
  return null;
}
export const RESOURCE_SECTIONS=[
  {href:'/knowledge',label:'지식한입'},
  {href:'/materials/briefings',label:'시사 브리핑'},
  {href:'/materials',label:'내 교재'},
  {href:'/schools',label:'지원 학교'},
] as const;
export const PRACTICE_SECTIONS=[
  {href:'/learn',label:'연습 홈'},
  {href:'/quiz',label:'퀴즈'},
  {href:'/interview',label:'모의면접'},
  {href:'/quiz/assignments',label:'과제'},
] as const;
export function resourceSectionHref(path:string) {
  if(studentSection(path)!=='resources')return null;
  if(within(path,'/account/confirmations'))return '/account/confirmations';
  if(within(path,'/knowledge'))return '/knowledge';
  if(within(path,'/materials/briefings'))return '/materials/briefings';
  if(within(path,'/schools'))return '/schools';
  return '/materials';
}
export function practiceSectionHref(path:string) {
  if(within(path,'/learn'))return '/learn';
  if(within(path,'/quiz/assignments'))return '/quiz/assignments';
  if(['/interview','/chat/interviews','/practice/video','/on/interviews'].some(root=>within(path,root)))return '/interview';
  return '/quiz';
}
/** Keep the primary rail available; hide the browsing tabs only during an actual answer. */
export function isAnswerWorkspace(path:string) {
  return /^\/(?:quiz\/session\/[^/]+|interview\/(?!new(?:\/|$)|chat(?:\/|$)|live(?:\/|$))[^/]+|practice\/video\/[^/]+|chat\/interviews\/[^/]+|on\/interviews\/(?!new(?:\/|$))[^/]+)(?:\/|$)/.test(path);
}
