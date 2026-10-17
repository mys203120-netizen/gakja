import 'server-only';
import {createHash} from 'node:crypto';
import {readAdmissionCalendar} from './admission-calendar-store';
import {buildSchoolCalendarPreview,type SchoolCalendarPreview} from './school-onboarding-calendar-model';
import type {AdmissionCalendarTarget} from './admission-calendar-model';

export async function previewSchoolAdmissionCalendar(target:AdmissionCalendarTarget):Promise<SchoolCalendarPreview>{
  const preview=buildSchoolCalendarPreview(await readAdmissionCalendar(),target);
  // Ties final confirmation to both the selected identity and the currently displayed evidence.
  const fingerprint=createHash('sha256').update(JSON.stringify(preview)).digest('hex');
  return {...preview,fingerprint};
}
