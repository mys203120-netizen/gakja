export const MINUTE_WHEEL_MAX=480;
export const MINUTE_WHEEL_STEP=5;
export const MINUTE_WHEEL_ROW_HEIGHT=44;

export function minuteWheelOptions(exactValues:readonly number[]=[]):number[]{
  return [...new Set([...Array.from({length:MINUTE_WHEEL_MAX/MINUTE_WHEEL_STEP+1},(_,index)=>index*MINUTE_WHEEL_STEP),...exactValues.filter(value=>Number.isInteger(value)&&value>=0&&value<=MINUTE_WHEEL_MAX)])].sort((left,right)=>left-right);
}
export function minuteWheelIndex(scrollTop:number,count:number):number{
  return Math.max(0,Math.min(Math.max(0,count-1),Math.round((Number.isFinite(scrollTop)?scrollTop:0)/MINUTE_WHEEL_ROW_HEIGHT)));
}
export function minuteWheelKey(value:number,key:string,options:readonly number[]):number|null{
  if(!options.length)return null;
  const index=Math.max(0,options.indexOf(value));
  if(key==='ArrowUp'||key==='+')return options[Math.min(options.length-1,index+1)];
  if(key==='ArrowDown'||key==='-')return options[Math.max(0,index-1)];
  if(key==='Home')return options[0];
  if(key==='End')return options[options.length-1];
  if(key==='PageUp')return options.find(option=>option>=Math.min(MINUTE_WHEEL_MAX,value+30))??options[options.length-1];
  if(key==='PageDown')return [...options].reverse().find(option=>option<=Math.max(0,value-30))??options[0];
  return null;
}
export function minuteWheelLabel(value:number):string{
  return value>=60?`${Math.floor(value/60)}시간${value%60?` ${value%60}분`:''}`:`${value}분`;
}
