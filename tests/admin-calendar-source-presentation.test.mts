import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCalendarAdminRows} from '../apps/web/src/lib/admin-admission-calendar-model.ts';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar.ts';
import {isReferenceCalendarUrl,visibleCalendarSourceUrl} from '../apps/web/src/lib/calendar-source-presentation.ts';

const base=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8'));
const official=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-official.json',import.meta.url),'utf8'));
const snapshot={catalogue:overlayOfficialCalendar(base,official),official,officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false};
const sourceRows=buildCalendarAdminRows(snapshot.catalogue,snapshot.official);
const imported=sourceRows.find(row=>isReferenceCalendarUrl(row.sourceUrl))!;
const state={snapshot,edits:[{id:imported.id,revision:2,deleted:false,data:{...imported,note:'아컨 https://www.acon.io.kr/susi/calendar 2026-11-29 입학처 확인'},updated_at:'2026-10-16T00:00:00Z',updated_by:'fixture-admin',editor_name:'검증 관리자',editor_email:'fixture-admin@example.test'}],queries:[] as string[]};
(globalThis as any).__adminSourceTest=state;
const modules:Record<string,string>={
  'server-only':'module.exports={};',
  './db':`exports.ApiError=class ApiError extends Error{constructor(status,message){super(message);this.status=status;}};exports.query=async sql=>{const s=globalThis.__adminSourceTest;s.queries.push(sql);if(sql.includes('pg_advisory_xact_lock'))return [];if(sql.startsWith('select')&&sql.includes('admission_calendar_admin_edits'))return structuredClone(s.edits);if(sql.startsWith('select')&&sql.includes('support_targets'))return [];throw Error('No writes permitted in source presentation test');};exports.transaction=async fn=>fn({query:async(sql,args)=>({rows:await exports.query(sql,args)})});`,
  './admission-calendar-store':`exports.readAdmissionCalendar=async()=>globalThis.__adminSourceTest.snapshot;`,
};
const folder=mkdtempSync(join(tmpdir(),'admin-calendar-source-')),keys=Object.keys(modules),files=keys.map((key,index)=>{const path=join(folder,`${index}.cjs`);writeFileSync(path,modules[key]);return path;});
registerHooks({resolve(specifier,context,next){if(modules[specifier])return {url:pathToFileURL(files[keys.indexOf(specifier)]).href,shortCircuit:true};return next(specifier,context);}});
after(()=>{files.forEach(unlinkSync);rmdirSync(folder);delete (globalThis as any).__adminSourceTest;});
const {getAdminAdmissionCalendar,editAdminAdmissionCalendar}=await import('../apps/web/src/lib/admin-admission-calendar.ts');

test('admin response hides reference attribution in existing rows without losing edit identities or official links',async()=>{
  const before=JSON.stringify(state.snapshot),savedBefore=JSON.stringify(state.edits);
  const result=await getAdminAdmissionCalendar({id:'fixture-admin',role:'admin'} as any);
  assert.equal(result.schools.length,80);assert.equal(result.rows.length,sourceRows.length);
  assert.deepEqual(result.rows.map(row=>row.id).sort(),sourceRows.map(row=>row.id).sort());
  for(const row of result.rows){
    const raw=sourceRows.find(item=>item.id===row.id)!;
    assert.deepEqual(row.dates,raw.dates);assert.equal(row.schoolReferenceId,raw.schoolReferenceId);assert.equal(row.trackLabel,raw.trackLabel);
    assert.equal(row.sourceUrl,visibleCalendarSourceUrl(raw.sourceUrl));assert.equal(isReferenceCalendarUrl(row.sourceUrl),false);assert.doesNotMatch(row.sourceLabel,/아컨|\bacon\b/i);
    assert.doesNotMatch(row.note||'',/아컨|acon\.io\.kr/i);assert.doesNotMatch(row.rawDate||'',/아컨|acon\.io\.kr/i);
  }
  const modified=result.rows.find(row=>row.id===imported.id)!;
  assert.equal(modified.revision,2);assert.equal(modified.modified,true);assert.ok(modified.note?.includes('2026-11-29'));assert.ok(modified.note?.includes('입학처'));
  assert.equal(JSON.stringify(state.snapshot),before);assert.equal(JSON.stringify(state.edits),savedBefore);
  assert.ok(state.queries.every(sql=>sql.startsWith('select')),'Reading sanitized admin rows performs no source or edit writes');
});

test('an unchanged admin date edit with hidden source fields omitted is a true no-op under the row lock',async()=>{
  const before=JSON.stringify(state.edits),queriesBefore=state.queries.length;
  const {sourceUrl:_hiddenUrl,note:_hiddenNote,...input}=state.edits[0].data;
  const result=await editAdminAdmissionCalendar({id:'fixture-admin',role:'admin'} as any,{action:'update',id:imported.id,expectedRevision:2,data:input});
  assert.equal(result.ok,true);assert.ok('row' in result);
  if(!('row' in result))return;
  assert.equal(result.row.revision,2);assert.equal(result.row.sourceUrl,'');assert.doesNotMatch(result.row.note||'',/아컨|acon\.io\.kr/i);
  assert.ok(result.row.note?.includes('2026-11-29'));assert.equal(JSON.stringify(state.edits),before);
  assert.ok(state.queries.slice(queriesBefore).some(sql=>sql.includes('for update')));
  assert.ok(state.queries.slice(queriesBefore).every(sql=>sql.startsWith('select')),'No-op edit does not write a revision, public source, audit or event');
});
