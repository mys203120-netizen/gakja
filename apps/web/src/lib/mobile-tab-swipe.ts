import {STUDENT_NAVIGATION} from './app-navigation';

/** Only the three overview screens can be swiped; an answer is never abandoned. */
export function swipeDestination(path:string,dx:number,dy:number,elapsed:number) {
  const index=STUDENT_NAVIGATION.findIndex(item=>item.href===path);
  if(index<0||elapsed<0||elapsed>850||Math.abs(dx)<64||Math.abs(dx)<Math.abs(dy)*1.6)return null;
  return STUDENT_NAVIGATION[index+(dx<0?1:-1)]?.href||null;
}
