// Local HTTP / PostgreSQL calendar integration. Public snapshots are never changed by this test.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,projectRoot,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {calendarForTargets,type AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model';
import {validateCalendarSnapshot} from '../apps/web/src/lib/admission-calendar-storage';
import {OFFICIAL_SUPPLEMENT_SCHOOLS,overlayOfficialCalendar,officialDecisionForTarget,validateOfficialCalendarSupplement,type OfficialCalendarSupplement} from '../apps/web/src/lib/official-admission-calendar';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
import {isReferenceCalendarUrl,visibleCalendarSourceLabel,visibleCalendarSourceUrl} from '../apps/web/src/lib/calendar-source-presentation';

loadProjectEnv();
const base=process.env.TEST_BASE_URL||process.env.SMOKE_BASE_URL||JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||new URL(base).protocol!=='http:'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local synthetic fixtures only');
const bundled=JSON.parse(readFileSync(join(projectRoot,'apps/web/src/data/school-interview-calendar.json'),'utf8')) as AdmissionCalendarCatalogue;
const official=validateOfficialCalendarSupplement(JSON.parse(readFileSync(join(projectRoot,'apps/web/src/data/school-interview-official.json'),'utf8'))) as OfficialCalendarSupplement;
const combined=overlayOfficialCalendar(bundled,official);
const directory=JSON.parse(readFileSync(join(projectRoot,'apps/web/src/data/school-directory.json'),'utf8'));
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const runId=randomUUID(),owners:Record<string,string>={},tokens:Record<string,string>={},fixtureIds:string[]=[],targets:Record<string,any>={};
const observations:any[]=[];
let checks=0,failed:string|null=null,cleaned=false,matrixTuples=0,selectableTuples=0,aliasCases=0,checkedPublisherFingerprint:string|null=null,checkedContentHash:string|null=null;
function check(value:unknown,label:string):asserts value{assert.ok(value,label);checks++;}
const sourceRows=new Map(combined.schools.flatMap(school=>school.entries).map(entry=>[entry.id,entry]));
const runtimeSourceRows=new Map(sourceRows);
async function request(actor:string,path='/api/planner'){
  const response=await fetch(base+path,{headers:{Origin:base,...(tokens[actor]?{Cookie:'gakja_session='+tokens[actor]}:{})},signal:AbortSignal.timeout(120_000)});
  let body:any;try{body=await response.json();}catch{throw Error(`Calendar request returned non-JSON ${response.status}`);}
  return {status:response.status,body,headers:response.headers};
}
const get=(actor:string,targetId?:string,extra='')=>request(actor,'/api/planner'+(targetId?'?targetId='+encodeURIComponent(targetId)+(extra?'&'+extra:''):extra?'?'+extra:''));
function ownSchedules(response:any,allowedTargets:string[]){
  check(response.status===200&&Array.isArray(response.body.interviewSchedules),'planner exposes sourced school interview schedule array');
  check(response.headers.get('cache-control')?.includes('private')&&response.headers.get('cache-control')?.includes('no-store'),'calendar with owned targets is private and not shared-cacheable');
  for(const item of response.body.interviewSchedules){
    const entry=[...runtimeSourceRows.values()].find(entry=>item.id.startsWith(entry.id+':'));
    check(!!entry&&entry.kind==='interview'&&entry.schoolReferenceId===item.schoolReferenceId,'only interview rows belonging to one of the 88 registered school references are exposed');
    check(allowedTargets.includes(item.targetId),'schedule row belongs only to selected authenticated target');
    check(entry!.segments.some(segment=>segment.startDate===item.startDate&&segment.endDate===item.endDate),'DTO preserves original separate date segment without inventing a gap day');
    check(item.sourceUrl===visibleCalendarSourceUrl(entry!.sourceUrl)&&item.sourceLabel===visibleCalendarSourceLabel(entry!.sourceLabel||'',entry!.sourceUrl)&&item.admissionYear===2027,'each interview entry preserves official evidence and admission year while omitting reference-site attribution and links');
    check(!isReferenceCalendarUrl(item.sourceUrl)&&!/아컨|acon\.io\.kr/i.test(String(item.sourceLabel)),'student calendar never exposes reference-site attribution or outbound links');
    if(entry!.sourceKind==='official_admissions')check(Date.parse(item.checkedAt)===Date.parse(official.checkedAt),'official source verification time is retained separately from publisher feed time, regardless of PostgreSQL ISO serialization');
    if(entry!.format)check(item.format===entry!.format&&String(item.note).includes('영상'),'official video-submission dates retain format and instructions instead of implying an in-person appointment');
    check(['track_match','school_reference'].includes(item.applicability)&&(!Object.hasOwn(item,'note')||typeof item.note==='string'&&item.note.length>0),'public school dates explicitly distinguish exact target scope from school reference scope');
    check(!Object.hasOwn(item,'personal_date')&&!Object.hasOwn(item,'personal_at'),'public dates never claim a personal allocated interview appointment');
  }
}
async function addTarget(key:string,schoolName:string,overrides:Record<string,unknown>={},actor='student'){
  const school=bundled.schools.find(school=>school.canonicalName===schoolName||school.university===schoolName);
  assert.ok(school,`fixture school exists: ${schoolName}`);
  const target={id:'calendar_'+randomUUID(),school_reference_id:school.schoolReferenceId,university:school.university,admission_year:2027,campus:'본교',department:'미정',major:'미정',admission_type:'미정',...overrides};
  await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[target.id,owners[actor],JSON.stringify(target)]);
  targets[key]=target;return target;
}

await db.connect();
try{
  check(validateCalendarSnapshot(bundled)===bundled,'bundled snapshot passes provenance / date consistency validation');
  check(bundled.schools.length===88&&new Set(bundled.schools.map(school=>school.schoolReferenceId)).size===88,'snapshot contains precisely the registered 88 distinct schools');
  check(bundled.schools.filter(school=>school.status==='available').length===80,'80 registered schools have date-confirmed interview rows');
  check(bundled.schools.filter(school=>school.status==='no_interview').length===2&&bundled.schools.filter(school=>school.status==='not_listed').length===6,'source-listed without interview rows and absent-from-source statuses remain distinct');
  check(bundled.schools.reduce((count,school)=>count+school.entries.length,0)===507&&bundled.audit.importedInterviewRows===507,'507 original Acon interview entries remain unchanged without non-interview exams');
  check(official.schools.length===8&&OFFICIAL_SUPPLEMENT_SCHOOLS.every(name=>official.schools.some(school=>school.university===name)),'all eight publisher-missing / empty-interview schools have separate scoped official evidence');
  check(combined.schools.length===88&&combined.audit.importedInterviewRows===507+official.schools.reduce((count,school)=>count+school.entries.length,0),'official evidence augments the same 88 schools without replacing publisher entries');
  check(bundled.schools.every(school=>school.entries.every(entry=>JSON.stringify(sourceRows.get(entry.id))===JSON.stringify(entry))),'every original Acon entry remains byte-equivalent after the official overlay');
  const [state]=(await db.query('select v.data,v.content_hash,s.checked_at,s.last_error from admission_calendar_sync_state s join admission_calendar_versions v on v.id=s.latest_version_id where s.source_key=$1',['acon-susi'])).rows;
  check(!!state,'PostgreSQL stores a latest successful public calendar snapshot');
  check(state.data.schools.length===88&&state.data.schools.reduce((count:number,school:any)=>count+school.entries.length,0)===507,'PostgreSQL imported snapshot preserves all 88 references / 507 entries');
  const storedCalendar=validateCalendarSnapshot(state.data);
  checkedPublisherFingerprint=storedCalendar.source.sha256;checkedContentHash=state.content_hash;
  check(/^[a-f0-9]{64}$/.test(storedCalendar.source.sha256)&&/^[a-f0-9]{64}$/.test(state.content_hash)&&storedCalendar.source.url===bundled.source.url&&storedCalendar.source.admissionYear===bundled.source.admissionYear,'current stored snapshot retains a valid versioned publisher fingerprint and the audited source/year');
  check(!state.last_error&&Number.isFinite(new Date(state.checked_at).getTime()),'latest successful synchronization has a valid check time');
  const [officialState]=(await db.query('select v.data,s.checked_at,v.source_key,v.content_hash from admission_calendar_sync_state s join admission_calendar_versions v on v.id=s.latest_version_id where s.source_key=$1',['official-susi-supplement'])).rows;
  check(!!officialState&&officialState.source_key==='official-susi-supplement','PostgreSQL stores official supplement under a separate versioned source key');
  check(validateOfficialCalendarSupplement(officialState.data).schools.length===8&&officialState.data.schools.reduce((count:number,school:any)=>count+school.entries.length,0)===official.schools.reduce((count,school)=>count+school.entries.length,0),'saved official version preserves the reviewed eight-school entries');
  check(officialState.data.checkedAt===official.checkedAt&&officialState.content_hash.length===64,'saved official version preserves evidence verification time and content fingerprint');
  // A scheduled publisher refresh may legitimately supersede the bundled feed.
  // Every runtime DTO below must match the currently persisted snapshot instead.
  const storedCombined=overlayOfficialCalendar(storedCalendar,validateOfficialCalendarSupplement(officialState.data));
  runtimeSourceRows.clear();for(const school of storedCombined.schools)for(const entry of school.entries)runtimeSourceRows.set(entry.id,entry);

  const directoryIds=new Set(directory.schools.map((school:any)=>school.id));
  check(bundled.schools.every(school=>directoryIds.has(school.schoolReferenceId)),'publisher schools outside the registered catalogue are excluded');
  for(const school of directory.schools){
    const source=combined.schools.find(row=>row.schoolReferenceId===school.id);assert.ok(source);
    const schoolProjection=calendarForTargets(combined,[{id:school.id,school_reference_id:school.id,university:school.university,admission_year:2027}]);
    assert.equal(schoolProjection.schools[0].school?.schoolReferenceId,school.id);
    for(const department of school.departments){
      matrixTuples++;
      const result=calendarForTargets(combined,[{id:school.id+':'+department.id,school_reference_id:school.id,university:school.university,admission_year:2027,campus:school.campusLabel||department.campus,department:department.name,admission_type:'미정'}]);
      assert.ok(result.schools[0].entries.every(entry=>entry.kind==='interview'&&entry.schoolReferenceId===school.id&&sourceRows.has(entry.id)));
      assert.ok(result.schools[0].entries.every(entry=>entry.segments.every(segment=>segment.startDate<=segment.endDate)));
    }
  }
  check(matrixTuples===3934,'all 3,934 raw public disclosure tuples project only their own interview dates');
  selectableTuples=schoolDirectory.reduce((count,school)=>count+school.departments.length,0);
  check(selectableTuples===3884&&schoolDirectory.every(school=>school.departments.every(department=>department.name!=='기타모집단위')),'3,884 selectable departments exclude 50 aggregate statistical labels from the raw source');

  for(const [actor,role] of [['student','student'],['other','student'],['staff','staff'],['admin','admin']]){
    const id=randomUUID(),token=randomUUID();
    await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[id,`calendar-${actor}-${runId}@gakja.test`,'면접 달력 격리 검증',role]);
    fixtureIds.push(id);owners[actor]=id;tokens[actor]=token;
    await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),id]);
  }
  check((await get('anonymous')).status===401,'anonymous calendar read denied');
  for(const role of ['staff','admin'])check((await get(role)).status===403,`${role} cannot read a student calendar`);
  const uos=await addTarget('uos','서울시립대학교',{department:'환경공학부',major:'환경공학부',admission_type:'학생부종합전형Ⅰ(면접형)',schedule:{period_start:'2026-11-28',period_end:'2026-11-29',personal_date:'2026-11-29',personal_at:'2026-11-29T10:30:00+09:00',location:'합성 검증 면접실',status:'reviewed'}});
  const persistedProjection=await get('student',uos.id);
  check(persistedProjection.status===200&&persistedProjection.body.interviewScheduleCoverage.source.sha256===storedCalendar.source.sha256&&persistedProjection.body.interviewScheduleCoverage.source.url===visibleCalendarSourceUrl(storedCalendar.source.url),'runtime calendar keeps the persisted fingerprint while omitting reference-site outbound links');
  const foreign=await addTarget('foreign','한국외국어대학교',{department:'중국어문화학과'},'other');
  check((await get('student',foreign.id)).status===404,'another student target ID cannot be used to read its calendar');
  check((await get('student','calendar_missing_'+randomUUID())).status===404,'unknown target does not fallback to another school');
  check((await get('student','x'.repeat(201))).status===400,'unbounded target identifier rejected');
  const noTargets=await get('other',undefined,'studentId='+owners.student);
  ownSchedules(noTargets,[foreign.id]);
  check(noTargets.body.interviewScheduleCoverage.targets.every((row:any)=>row.targetId===foreign.id),'forged studentId is ignored in favour of the signed-in owner');
  const before=(await db.query('select data from support_targets where id=$1',[uos.id])).rows[0].data;
  const exact=await get('student',uos.id);
  ownSchedules(exact,[uos.id]);
  check(exact.body.interviewSchedules.length===1&&exact.body.interviewSchedules[0].startDate==='2026-11-29'&&exact.body.interviewSchedules[0].endDate==='2026-11-29','Harin-shaped UOS environment / 2027 / 종합Ⅰ 면접형 selects November 29, 2026 only');
  check(exact.body.interviewSchedules[0].applicability==='track_match','Roman numeral and spacing normalization identify the exact selected track');
  check(exact.body.interviewScheduleCoverage.targets[0].status==='available'&&exact.body.interviewScheduleCoverage.targets[0].entryCount===1,'selected known target reports one applicable interview date');
  const after=(await db.query('select data from support_targets where id=$1',[uos.id])).rows[0].data;
  check(JSON.stringify(before)===JSON.stringify(after)&&after.schedule.personal_at==='2026-11-29T10:30:00+09:00'&&after.schedule.personal_date==='2026-11-29','reading shared dates preserves manually assigned personal date / time and all target fields');
  observations.push({case:'UOS environment 2027 interview track',dates:exact.body.interviewSchedules.map((row:any)=>({startDate:row.startDate,endDate:row.endDate,applicability:row.applicability})),personalAppointmentPreserved:true});

  const disjointSource=bundled.schools.flatMap(school=>school.entries).find(entry=>entry.segments.length>1)!;
  const disjointSchool=bundled.schools.find(school=>school.schoolReferenceId===disjointSource.schoolReferenceId)!;
  const split=await addTarget('split',disjointSchool.canonicalName,{admission_type:disjointSource.trackLabel});
  const separated=await get('student',split.id);ownSchedules(separated,[split.id]);
  const matching=separated.body.interviewSchedules.filter((row:any)=>row.id.startsWith(disjointSource.id+':'));
  check(matching.length===disjointSource.segments.length,'one source entry with disjoint dates becomes separate calendar segments');
  check(!matching.some((row:any)=>row.startDate<='2026-10-04'&&row.endDate>='2026-10-04'),'October 4 gap in the October 2–3 and October 5 source never appears as an interview');
  observations.push({case:'disjoint source dates',rawDate:disjointSource.rawDate,segments:matching.map((row:any)=>({startDate:row.startDate,endDate:row.endDate}))});
  for(const [key,name,campus] of [['wise','동국대학교','WISE'],['erica','한양대학교','ERICA'],['glocal','건국대학교','글로컬']]){
    const target=await addTarget(key,name,{campus});
    const response=await get('student',target.id);ownSchedules(response,[target.id]);
    check(response.body.interviewSchedules.length===0&&response.body.interviewScheduleCoverage.targets[0].status==='campus_mismatch',`${campus} never borrows the other registered campus schedule`);
  }
  const future=await addTarget('future','서울시립대학교',{admission_year:2028,department:'환경공학부',admission_type:'학생부종합전형Ⅰ(면접형)'});
  const wrongYear=await get('student',future.id);ownSchedules(wrongYear,[future.id]);
  check(wrongYear.body.interviewSchedules.length===0&&wrongYear.body.interviewScheduleCoverage.targets[0].status==='year_mismatch'&&wrongYear.body.interviewScheduleCoverage.targets[0].note.includes('2027학년도'),'2028 target receives no 2027 dates and a clear source year warning');
  for(const school of official.schools){
    const target=await addTarget('official-overview-'+school.schoolReferenceId,school.university);
    const response=await get('student',target.id);ownSchedules(response,[target.id]);
    const coverage=response.body.interviewScheduleCoverage.targets[0];
    check(coverage.officialSources.length===school.sources.length&&school.sources.every(source=>coverage.officialSources.some((row:any)=>row.url===source.url&&row.title===source.title)),`${school.university}: selected school exposes its own reviewed official sources`);
    check(coverage.officialDecisions.length===school.decisions.length,`${school.university}: scoped undated / no-interview decisions remain visible without fabricated dates`);
    observations.push({school:school.university,status:coverage.status,entries:response.body.interviewSchedules.length,officialSources:coverage.officialSources.map((source:any)=>source.url)});
    for(let index=0;index<school.entries.length;index++){
      const entry=school.entries[index],major=entry.departments[0]||'미정';
      const exactTarget=await addTarget(`official-entry-${school.schoolReferenceId}-${index}`,school.university,{admission_type:entry.trackLabel,department:major,major});
      const response=await get('student',exactTarget.id);ownSchedules(response,[exactTarget.id]);
      const entryId=`official:${school.schoolReferenceId}:${index}`;
      const selected=response.body.interviewSchedules.filter((row:any)=>row.id.startsWith(entryId+':'));
      const expected=runtimeSourceRows.get(entryId)!;
      check(selected.length===expected.segments.length&&selected.every((row:any)=>row.sourceLabel==='입학처'&&row.sourceUrl===entry.sourceUrl),`${school.university} / ${entry.trackLabel}: exact scoped official dates appear with their own source`);
      check(selected.every((row:any)=>row.applicability===(entry.departments.length?'track_match':'school_reference')),`${school.university} / ${entry.trackLabel}: scoped department evidence is distinguished from school-level dates`);
      observations.push({school:school.university,track:entry.trackLabel,major,kind:'official_date',dates:selected.map((row:any)=>({startDate:row.startDate,endDate:row.endDate,applicability:row.applicability}))});
      const aliasSelections=[...(entry.trackAliases||[]).map(track=>({track,major})),...(entry.departmentAliases||[]).map(major=>({track:entry.trackLabel,major}))];
      for(let aliasIndex=0;aliasIndex<aliasSelections.length;aliasIndex++){
        const alias=aliasSelections[aliasIndex];aliasCases++;
        const aliasTarget=await addTarget(`official-alias-${school.schoolReferenceId}-${index}-${aliasIndex}`,school.university,{admission_type:alias.track,department:alias.major,major:alias.major});
        const response=await get('student',aliasTarget.id);ownSchedules(response,[aliasTarget.id]);
        const selected=response.body.interviewSchedules.filter((row:any)=>row.id.startsWith(entryId+':'));
        check(selected.length===expected.segments.length&&selected.every((row:any)=>row.applicability===(entry.departments.length?'track_match':'school_reference')),`${school.university}: verified track / department alias selects its own exact official dates`);
        check(selected.every((row:any)=>row.departmentCount===entry.departments.length||!entry.departments.length&&row.departmentCount===null),`${school.university}: aliases do not inflate the official admitted department count`);
      }
    }
    for(let index=0;index<school.decisions.length;index++){
      const decision=school.decisions[index],major=decision.departments[0]||'미정';
      const decisionTarget=await addTarget(`official-decision-${school.schoolReferenceId}-${index}`,school.university,{admission_type:decision.trackLabel==='*'?'미정':decision.trackLabel,department:major,major});
      const selectedDecision=officialDecisionForTarget(school,decisionTarget)!;
      const response=await get('student',decisionTarget.id);ownSchedules(response,[decisionTarget.id]);
      const coverage=response.body.interviewScheduleCoverage.targets[0];
      check(!!selectedDecision&&response.body.interviewSchedules.length===0&&coverage.status===selectedDecision.status,`${school.university} / ${decision.trackLabel}: explicitly scoped ${selectedDecision.status} cannot borrow another track's dates`);
      check(coverage.decisionSourceUrl===selectedDecision.sourceUrl&&coverage.note===selectedDecision.reason,`${school.university} / ${decision.trackLabel}: decision cites its actual source and reason`);
      observations.push({school:school.university,track:decision.trackLabel,major,kind:'official_decision',status:coverage.status,sourceUrl:coverage.decisionSourceUrl});
    }
    if(school.entries.length){
      const unknown=await addTarget('unknown-track-'+school.schoolReferenceId,school.university,{admission_type:'검증용 미확인 전형',department:school.entries[0].departments[0]||'미정'});
      const response=await get('student',unknown.id);ownSchedules(response,[unknown.id]);
      check(response.body.interviewSchedules.every((row:any)=>row.applicability==='school_reference'),`${school.university}: unknown track never upgrades school-reference dates into exact matched applicant dates`);
      check(response.body.interviewScheduleCoverage.targets[0].status==='unverified',`${school.university}: an unknown selected track is explicitly unverified even when school-reference dates exist`);
    }
  }
  const all=await get('student');ownSchedules(all,Object.values(targets).filter(target=>target.id!==foreign.id).map(target=>target.id));
  check(all.body.interviewScheduleCoverage.registeredSchools===88&&all.body.interviewScheduleCoverage.availableSchools===combined.audit.availableSchools&&all.body.interviewScheduleCoverage.totalInterviewEntries===combined.audit.importedInterviewRows&&all.body.interviewScheduleCoverage.officialSchools===8,'coverage DTO distinguishes combined source totals / eight official evidence schools from user target-specific dates');
  check(!all.body.interviewSchedules.some((row:any)=>row.targetId===foreign.id),'unfiltered calendar still excludes another student school');
  const [baseAfter]=(await db.query('select v.data,v.content_hash,s.latest_version_id from admission_calendar_sync_state s join admission_calendar_versions v on v.id=s.latest_version_id where s.source_key=$1',['acon-susi'])).rows;
  check(baseAfter.content_hash===checkedContentHash&&baseAfter.data.source.sha256===checkedPublisherFingerprint&&JSON.stringify(baseAfter.data)===JSON.stringify(storedCalendar),'official supplement and private calendar reads preserve every field of the currently stored Acon source snapshot and its version hash');
  check((await db.query('select count(*)::int n from usage_records where student_id=any($1::uuid[])',[fixtureIds])).rows[0].n===0,'calendar integration uses no paid AI calls');
}catch(error){failed=redactEnvironmentSecrets(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally{
  try{
    await db.query('begin');
    await db.query('delete from support_targets where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from sessions where user_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from profiles where id=any($1::uuid[])',[fixtureIds]);
    await db.query('commit');
    cleaned=(await db.query('select count(*)::int n from profiles where id=any($1::uuid[])',[fixtureIds])).rows[0].n===0;
    check(cleaned,'all owned synthetic fixture profiles / targets / sessions cleaned');
  }catch(error){await db.query('rollback');failed=[failed,'Fixture cleanup: '+redactEnvironmentSecrets(error instanceof Error?error.message:String(error))].filter(Boolean).join('; ');process.exitCode=1;}
  await db.end();
  const evidence={status:failed?'failed':'passed',checkedAt:new Date().toISOString(),checks,matrixTuples,matrixScope:'Raw 2026 public disclosure tuples, including 50 excluded aggregate statistical labels',selectableTuples,aliasCases,sourceUrl:bundled.source.url,sourceFingerprint:checkedPublisherFingerprint,bundledSourceFingerprint:bundled.source.sha256,versionContentHash:checkedContentHash,admissionYear:2027,calendarYear:2026,schools:88,availableSchools:combined.audit.availableSchools,aconSourceListedWithoutInterviewRows:2,aconSourceMissingSchools:6,aconInterviewEntries:507,officialEvidenceSchools:8,officialInterviewEntries:official.schools.reduce((count,school)=>count+school.entries.length,0),officialDateOccurrences:official.schools.reduce((count,school)=>count+school.entries.reduce((count,entry)=>count+entry.dates.length,0),0),officialDecisions:official.schools.reduce((count,school)=>count+school.decisions.length,0),combinedInterviewEntries:combined.audit.importedInterviewRows,combinedDateOccurrences:combined.audit.importedDateOccurrences,combinedStatuses:Object.fromEntries(['available','needs_review','no_interview','not_listed'].map(status=>[status,combined.schools.filter(school=>school.status===status).length])),fixturesCreated:fixtureIds.length,fixturesCleaned:cleaned,originalStudentRecordsChanged:0,publicSnapshotChanged:false,paidAiCalls:0,observations,error:failed};
  writeFileSync(join(projectRoot,'.local/admission-calendar-api-check.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(failed?`Admission calendar integration failed: ${failed}`:`Admission calendar API checks passed: ${checks}; ${matrixTuples} department projections; synthetic fixtures cleaned.`);
}
