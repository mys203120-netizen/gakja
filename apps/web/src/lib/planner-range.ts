import {koreaToday,monthDays,planWeek,validPlanDay} from './planner-model';
export function plannerMonthRange(value:string|null|undefined){
 const month=value||koreaToday().slice(0,7);
 if(!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)||!validPlanDay(month+'-01'))throw new Error('계획표의 월을 확인해 주세요.');
 const grid=monthDays(month);
 return {month,startDate:planWeek(grid[0])[0],endDate:planWeek(grid.at(-1)!)[6]};
}
