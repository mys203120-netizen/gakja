import {after} from 'next/server';
import {refreshAdmissionCalendar} from '@/lib/admission-calendar-store';
import {requireUser,checkOrigin} from '@/lib/auth';
import {featureError,requireStudent} from '@/lib/ai';
import {ApiError} from '@/lib/db';
import {schoolRegistrationSchema} from '@/lib/school-learning';
import {normalizeSchoolSelection,SchoolSelectionError} from '@/lib/school-directory';
import {previewSchoolRegistrationCalendars} from '@/lib/school-onboarding-calendar';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  try{
    checkOrigin(request);const user=await requireUser();requireStudent(user);
    const text=await request.text();if(text.length>8000)throw new ApiError(413,'지원 정보를 짧게 입력해 주세요.');
    let raw;try{raw=JSON.parse(text);}catch{throw new ApiError(400,'지원 정보를 확인해 주세요.');}
    const input=schoolRegistrationSchema.parse(raw);
    let selection:ReturnType<typeof normalizeSchoolSelection>;
    try{selection=normalizeSchoolSelection(input);}catch(error){if(error instanceof SchoolSelectionError)throw new ApiError(400,error.message);throw error;}
    if(!selection.university)throw new ApiError(400,'지원 대학을 먼저 선택해 주세요.');
    const result=await previewSchoolRegistrationCalendars({university:selection.university,school_reference_id:selection.school?.id||null,
      admission_year:input.admissionYear,campus:selection.campus,department:selection.major,admission_type:input.track||'미정'});
    if(result.calendar.stale)after(()=>refreshAdmissionCalendar());
    return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){const result=featureError(error);return Response.json({error:result.error,code:result.code},{status:result.status,headers:{'Cache-Control':'private, no-store'}});}
}
