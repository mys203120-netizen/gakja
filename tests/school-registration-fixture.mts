import assert from 'node:assert/strict';

type ApiResult={status:number;body:any};
type SchoolRequest=(path:string,body:Record<string,unknown>)=>Promise<ApiResult>;

/** Use the same evidence review and final acknowledgement as student onboarding. */
export async function registerReviewedSchool(request:SchoolRequest,input:Record<string,unknown>){
  const preview=await request('/api/schools/onboarding-calendar',input);
  assert.equal(preview.status,200,'fixture school calendar preview succeeds');
  const calendar=preview.body.calendar;
  assert.equal(calendar.canReview,true,'fixture has a chosen department and track');
  assert.match(calendar.fingerprint,/^[a-f0-9]{64}$/,'review uses the server evidence fingerprint');
  assert.ok(['registered','school_reference','no_interview','date_pending','unpublished','unverified','needs_review','year_mismatch','campus_mismatch','source_missing','not_listed'].includes(calendar.status),'calendar state is explicit, including unresolved and no-interview states');
  assert.equal(calendar.calendarYear,Number(input.admissionYear)-1,'admission year retains the preceding actual calendar year');
  if(calendar.status==='no_interview'||calendar.status==='date_pending'){
    assert.equal(calendar.matched.length,0,'no-interview and pending states do not manufacture confirmed interview dates');
  }
  const registered=await request('/api/schools',{...input,onboarding:true,calendarReview:{fingerprint:calendar.fingerprint,acknowledged:true}});
  assert.equal(registered.status,200,`reviewed school fixture registers: ${JSON.stringify(registered.body)}`);
  const saved=registered.body.target.admission_calendar_registration;
  assert.equal(saved.fingerprint,calendar.fingerprint,'registration retains the actually reviewed evidence');
  assert.equal(saved.status,calendar.status,'registration preserves confirmed, pending, reference, or no-interview status');
  assert.equal(saved.personal_appointment_confirmed,false,'public school dates do not become personal appointments');
  return registered;
}
