import {writeFileSync,readFileSync} from 'node:fs';
import pg from 'pg';
import {loadProjectEnv} from './load-env.mjs';
import {applyCalendarAdminEdits} from '../apps/web/src/lib/admin-admission-calendar-model';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
import {schoolTalentCoverage,schoolTalentQuestionRows} from '../apps/web/src/lib/school-talent-model';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar';
import {validateCalendarSnapshot} from '../apps/web/src/lib/admission-calendar-storage';
let base=validateCalendarSnapshot(JSON.parse(readFileSync('apps/web/src/data/school-interview-calendar.json','utf8')));
let official=JSON.parse(readFileSync('apps/web/src/data/school-interview-official.json','utf8'));
let calendar=overlayOfficialCalendar(base,official);
let deployedQuestions:any[]|null=null;
if(process.argv.includes('--database')){
 loadProjectEnv();const db=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
 try{await db.connect();await db.query('begin read only');
 deployedQuestions=(await db.query("select id,revision,school_reference_id from (select distinct on(id) * from common_interview_questions order by id,revision desc) q where status='published'")).rows;
 const snapshots=(await db.query('select s.source_key,v.data from admission_calendar_sync_state s join admission_calendar_versions v on v.id=s.latest_version_id')).rows;
 base=validateCalendarSnapshot(snapshots.find(row=>row.source_key==='acon-susi')?.data||base);
 official=snapshots.find(row=>row.source_key==='official-susi-supplement')?.data||official;
 const edits=(await db.query('select id,data,revision,deleted,updated_at as "updatedAt" from admission_calendar_admin_edits where admission_year=$1',[base.source.admissionYear])).rows;
 const managed=applyCalendarAdminEdits(overlayOfficialCalendar(base,official),official,edits.map(row=>({...row,updatedAt:new Date(row.updatedAt).toISOString()})));
 calendar=managed.catalogue;official=managed.official;await db.query('rollback');
 }finally{await db.end();}
}
const talent=schoolTalentCoverage(),questions=schoolTalentQuestionRows();
const ids=new Set(schoolDirectory.map(s=>s.id));
const errors:string[]=[];
if(deployedQuestions)for(const q of questions)if(!deployedQuestions.some(row=>row.id===q.id&&row.revision===q.revision&&row.school_reference_id===q.school_reference_id))errors.push(`missing published question revision:${q.id}`);
const rows=schoolDirectory.map(s=>{const c=calendar.schools.find(c=>c.schoolReferenceId===s.id);if(!c)errors.push(`missing calendar:${s.id}`);for(const e of c?.entries||[]){if(e.schoolReferenceId!==s.id)errors.push(`foreign calendar:${e.id}`);if(e.dates.some(d=>!d.startsWith('2026-')))errors.push(`wrong year:${e.id}`);}return {id:s.id,school:s.university,departments:s.departments.length,calendarStatus:c?.status,calendarEntries:c?.entries.length||0,unresolved:c?.unresolved.length||0,talentQuestions:questions.filter(q=>q.school_reference_id===s.id).length};});
for(const c of calendar.schools)if(!ids.has(c.schoolReferenceId))errors.push(`unknown school:${c.schoolReferenceId}`);
for(const q of questions)if(!ids.has(q.school_reference_id))errors.push(`unknown question school:${q.id}`);
const status=Object.fromEntries([...new Set(rows.map(r=>r.calendarStatus))].map(s=>[s,rows.filter(r=>r.calendarStatus===s).length]));
const result={checkedAt:new Date().toISOString(),source:process.argv.includes('--database')?'database snapshots and admin edits':'bundled snapshots',schools:rows.length,departments:rows.reduce((n,r)=>n+r.departments,0),officialUniversityProfiles:talent.officialSourceSchools,officialDepartmentProfiles:talent.rows.reduce((n,r)=>n+r.departmentProfileCount,0),talentQuestions:questions.length,calendarStatuses:status,calendarEntries:rows.reduce((n,r)=>n+r.calendarEntries,0),officialCalendarSchools:official.schools.length,errors,rows};
writeFileSync(process.argv.includes('--database')?'.local/school-calendar-db-audit.json':'.local/school-technical-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined},null,2));if(errors.length)process.exitCode=1;
