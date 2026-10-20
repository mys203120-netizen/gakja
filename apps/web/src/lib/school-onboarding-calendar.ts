import 'server-only';
import {createHash} from 'node:crypto';
import {readAdmissionCalendar} from './admission-calendar-store';
import {buildSchoolCalendarPreview,type SchoolCalendarPreview} from './school-onboarding-calendar-model';
import type {AdmissionCalendarTarget} from './admission-calendar-model';

function fingerprintPreview(snapshot:Awaited<ReturnType<typeof readAdmissionCalendar>>,target:AdmissionCalendarTarget):SchoolCalendarPreview{
  const preview=buildSchoolCalendarPreview(snapshot,target);
  // Ties final confirmation to both the selected identity and the currently displayed evidence.
  const fingerprint=createHash('sha256').update(JSON.stringify(preview)).digest('hex');
  return {...preview,fingerprint};
}
export async function previewSchoolAdmissionCalendar(target:AdmissionCalendarTarget):Promise<SchoolCalendarPreview>{
  return fingerprintPreview(await readAdmissionCalendar(),target);
}
/** A single supported track can be selected without a second network round trip. */
export async function previewSchoolRegistrationCalendars(target:AdmissionCalendarTarget){
  const snapshot=await readAdmissionCalendar(),calendar=fingerprintPreview(snapshot,target);
  const noTrack=!target.admission_type||target.admission_type==='미정';
  const suggestedCalendar=noTrack&&calendar.tracks.length===1?fingerprintPreview(snapshot,{...target,admission_type:calendar.tracks[0]}):undefined;
  return {calendar,...(suggestedCalendar?{suggestedCalendar}:{})};
}
