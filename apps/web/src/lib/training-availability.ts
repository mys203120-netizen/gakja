import {z} from 'zod';

/** Calendar days are stored in Korea time; never infer them from the host timezone. */
export function validAvailabilityDate(value:string):boolean {
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export const availabilityToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const day=z.string().refine(validAvailabilityDate),minutes=z.number().int().min(0).max(480);
const editable={weekdayMinutes:minutes,weekendMinutes:minutes,blockedDates:z.array(day).max(730).refine(value=>new Set(value).size===value.length),overrides:z.record(day,minutes).refine(value=>Object.keys(value).length<=730)};

/** Dates and revisions belong to the server. New settings have one daily time only. */
export const availabilityInputSchema=z.object(editable).strict();
export type TrainingAvailabilityInput=z.infer<typeof availabilityInputSchema>;
const legacyInputSchema=z.object({...editable,csatDate:day.nullable(),beforeCsatWeekdayMinutes:minutes,beforeCsatWeekendMinutes:minutes}).strict();
const metadata={startDate:day,revision:z.number().int().positive(),savedAt:z.string().datetime({offset:true})};
const currentSchema=availabilityInputSchema.extend({...metadata,version:z.literal(2)}).strict();
const legacySchema=legacyInputSchema.extend({...metadata,version:z.literal(1)}).strict();
export const trainingAvailabilitySchema=z.union([currentSchema,legacySchema]);
export type TrainingAvailability=z.infer<typeof trainingAvailabilitySchema>;
export type CurrentTrainingAvailability=z.infer<typeof currentSchema>;

/** A legacy split is projected from its current period without changing the stored record. */
export function availabilityInput(value:TrainingAvailability|z.infer<typeof legacyInputSchema>|TrainingAvailabilityInput,at=availabilityToday()):TrainingAvailabilityInput {
  const before='csatDate' in value&&Boolean(value.csatDate&&at<value.csatDate);
  return {weekdayMinutes:before&&'beforeCsatWeekdayMinutes' in value?value.beforeCsatWeekdayMinutes:value.weekdayMinutes,weekendMinutes:before&&'beforeCsatWeekendMinutes' in value?value.beforeCsatWeekendMinutes:value.weekendMinutes,blockedDates:[...value.blockedDates].sort(),overrides:{...value.overrides}};
}
/** Old clients may still send a legacy shape; every explicit save writes the single-period contract. */
export const availabilityWriteSchema=z.union([availabilityInputSchema,legacyInputSchema]).transform(value=>availabilityInput(value));

export function normalizeTrainingAvailability(value:unknown,at=availabilityToday()):CurrentTrainingAvailability|null {
  const parsed=trainingAvailabilitySchema.safeParse(value);
  if(!parsed.success)return null;
  return {...availabilityInput(parsed.data,at),version:2,startDate:parsed.data.startDate,revision:parsed.data.revision,savedAt:parsed.data.savedAt};
}

/** Priority: before joining / blocked day -> 0; explicit date override; weekday/weekend. */
export function availabilityMinutesForDate(value:unknown,date:string,at=availabilityToday()):number {
  const availability=normalizeTrainingAvailability(value,at);
  if(!availability||!validAvailabilityDate(date)||date<availability.startDate||availability.blockedDates.includes(date))return 0;
  if(Object.prototype.hasOwnProperty.call(availability.overrides,date))return availability.overrides[date];
  const weekday=new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday===0||weekday===6?availability.weekendMinutes:availability.weekdayMinutes;
}