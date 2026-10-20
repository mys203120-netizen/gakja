// Real route handlers + real calendar SQL in an isolated schema; no existing account or provider writes.
// node --import tsx tests/school-registration-read-api.mts
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import * as directory from '../apps/web/src/lib/school-directory';
import * as storage from '../apps/web/src/lib/admission-calendar-storage';
import * as officialModel from '../apps/web/src/lib/official-admission-calendar';
import * as adminModel from '../apps/web/src/lib/admin-admission-calendar-model';
import * as projection from '../apps/web/src/lib/admission-calendar-projection';
import * as previewModel from '../apps/web/src/lib/school-onboarding-calendar-model';
import {z} from 'zod';
import * as workflows from '@gakja/content-contracts';

loadProjectEnv();const address=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(address.hostname))throw Error('Local PostgreSQL only.');
const schema='school_read_qa_'+randomBytes(8).toString('hex');assert.match(schema,/^school_read_qa_[a-f0-9]{16}$/);
const client=new pg.Client({connectionString:process.env.DATABASE_URL}),require=createRequire(import.meta.url);
const bundled=JSON.parse(readFileSync('apps/web/src/data/school-interview-calendar.json','utf8')),official=JSON.parse(readFileSync('apps/web/src/data/school-interview-official.json','utf8'));
const initial=JSON.parse(readFileSync('apps/web/src/data/school-registration-summary.json','utf8'));
const owner=randomUUID(),foreign=randomUUID();let actor:any={id:owner,role:'student'},afterCalls=0;
let traces:{sql:string;rows:number;bytes:number}[]=[],tail=Promise.resolve();
const query=(sql:string,params:unknown[]=[])=>{const pending=tail.then(async()=>{const result=await client.query(sql,params);traces.push({sql,rows:result.rows.length,bytes:Buffer.byteLength(JSON.stringify(result.rows))});return result.rows;});tail=pending.then(()=>{},()=>{});return pending;};
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
const database={ApiError,query,transaction:()=>{throw Error('Read-only route test.');}};
function load(file:string,mocks:Record<string,any>){const module={exports:{} as any};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Request,Response,Date,Buffer,URL,console,require:(name:string)=>name in mocks?mocks[name]:require(name)});return module.exports;}
const store=load('apps/web/src/lib/admission-calendar-store.ts',{'server-only':{},'../data/school-interview-calendar.json':{default:bundled},'../data/school-interview-official.json':{default:official},'./db':database,'./acon-calendar-source':{},'./admission-calendar-storage':storage,'./official-admission-calendar':officialModel,'./admin-admission-calendar-model':adminModel,'./admission-calendar-projection':projection});
const preview=load('apps/web/src/lib/school-onboarding-calendar.ts',{'server-only':{},'./admission-calendar-store':store,'./school-onboarding-calendar-model':previewModel});
const schoolLearning=load('apps/web/src/lib/school-learning.ts',{'server-only':{},zod:{z},'@gakja/content-contracts':workflows,'@/lib/db':database,'@/lib/school-directory':directory,'@/lib/official-school-profiles':{},'@/lib/school-talent-model':{},'@/lib/school-quiz':{},'@/lib/school-onboarding-calendar':preview,'@/lib/school-onboarding-calendar-model':previewModel,'./school-interview-scope':{},'./department-learning':{},'./training-availability':{}});
const auth={requireUser:async()=>{if(!actor)throw new ApiError(401,'Sign in');return actor;},checkOrigin:(request:Request)=>{if(request.headers.get('origin')!=='http://fixture.test')throw new ApiError(403,'Origin');}};
const ai={requireStudent:(user:any)=>{if(user.role!=='student')throw new ApiError(403,'Student only');},featureError:(error:any)=>({status:error.status||400,error:error.message})};
const calendarRoute=load('apps/web/src/app/api/schools/onboarding-calendar/route.ts',{'next/server':{after:()=>{afterCalls++;}},'@/lib/admission-calendar-store':store,'@/lib/auth':auth,'@/lib/ai':ai,'@/lib/db':database,'@/lib/school-learning':schoolLearning,'@/lib/school-directory':directory,'@/lib/school-onboarding-calendar':preview});
const catalogRoute=load('apps/web/src/app/api/schools/catalog/route.ts',{'@/lib/school-directory':directory});
const schoolsRoute=load('apps/web/src/app/api/schools/route.ts',{'@/lib/auth':auth,'@/lib/ai':ai,'@/lib/school-learning':schoolLearning});
const uos=directory.schoolDirectory.find(school=>school.canonicalName==='서울시립대학교')!,department=uos.departments.find(row=>row.name==='환경공학부')!;
const input={referenceId:uos.id,departmentId:department.id,admissionYear:2027,track:'미정'};
const request=(data:any)=>new Request('http://fixture.test/api/schools/onboarding-calendar',{method:'POST',headers:{origin:'http://fixture.test'},body:JSON.stringify(data)});
let created=false,failure:unknown;
await client.connect();
try{
 await client.query(`create schema "${schema}"`);created=true;await client.query(`set search_path to "${schema}",public`);
 await client.query('create table admission_calendar_versions(id uuid primary key,data jsonb);create table admission_calendar_sync_state(source_key text primary key,latest_version_id uuid,checked_at timestamptz,retry_after timestamptz,last_error text);create table admission_calendar_admin_edits(id text primary key,admission_year int,data jsonb,revision int,deleted boolean,updated_at timestamptz);create table support_targets(id text,student_id uuid,data jsonb,created_at timestamptz default now());');
 const source=randomUUID(),supplement=randomUUID();
 const singleTrackBundle={...bundled,schools:bundled.schools.map((school:any)=>school.schoolReferenceId===uos.id?{...school,entries:school.entries.filter((entry:any)=>entry.trackLabel.includes('면접형'))}:school)};
 await client.query('insert into admission_calendar_versions values($1,$2),($3,$4)',[source,JSON.stringify(singleTrackBundle),supplement,JSON.stringify(official)]);
 await client.query("insert into admission_calendar_sync_state values('acon-susi',$1,now(),null,null),('official-susi-supplement',$2,now(),null,null)",[source,supplement]);
 await client.query('insert into support_targets(id,student_id,data) values($1,$2,$3),($4,$5,$3)',['owned',owner,JSON.stringify({school_reference_id:uos.id,university:uos.university,department:department.name}), 'foreign',foreign]);
 const whole=await catalogRoute.GET(new Request('http://fixture.test/api/schools/catalog?schoolId='+uos.id)),compact=await catalogRoute.GET(new Request('http://fixture.test/api/schools/catalog?schoolId='+uos.id+'&view=registration'));
 const wholeText=await whole.text(),compactText=await compact.text();assert.ok(Buffer.byteLength(compactText)<Buffer.byteLength(wholeText)*0.55);
 assert.equal(initial.length,80);assert.equal(initial.find((school:any)=>school.canonicalName==='울산과학기술원').logoUrl,directory.schoolDirectory.find(school=>school.canonicalName==='울산과학기술원')!.logoUrl);
 traces=[];const selections=await schoolsRoute.GET(new Request('http://fixture.test/api/schools?scope=registration')),selected=await selections.json();
 assert.equal(selected.targets.length,1);assert.equal(selected.targets[0].id,'owned');assert.equal(traces.length,1);assert.ok(!('catalog'in selected)&&!('commonQuestions'in selected));
 traces=[];const coldStart=performance.now(),cold=await calendarRoute.POST(request(input)),coldData=await cold.json(),coldMs=performance.now()-coldStart;
 assert.equal(cold.status,200);assert.equal(coldData.calendar.canReview,false);assert.ok(coldData.suggestedCalendar.canReview);assert.equal(coldData.suggestedCalendar.matched[0].startDate,'2026-11-29');
 const coldQueries=traces.length,coldBytes=traces.reduce((sum,row)=>sum+row.bytes,0),times:number[]=[];
 for(let n=0;n<7;n++){traces=[];const start=performance.now(),response=await calendarRoute.POST(request({...input,track:coldData.suggestedCalendar.track}));const value=await response.json();times.push(performance.now()-start);assert.equal(response.status,200);assert.equal(value.calendar.fingerprint,coldData.suggestedCalendar.fingerprint);assert.equal(traces.length,2);assert.ok(!traces.some(row=>row.sql.includes('select id,data')||row.sql.includes('select id,data,revision')));}
 const warmBytes=traces.reduce((sum,row)=>sum+row.bytes,0);assert.ok(warmBytes<1000&&warmBytes<coldBytes/100);
 // An admin correction changes metadata, removes this track immediately, and changes its review fingerprint.
 const managed=await store.readAdmissionCalendar(),row=adminModel.buildCalendarAdminRows(managed.catalogue,managed.official).find(row=>row.schoolReferenceId===uos.id&&row.departments.includes(department.name)&&row.trackLabel.includes('면접형'))!;
 await client.query('insert into admission_calendar_admin_edits values($1,2027,$2,1,false,now())',[row.id,JSON.stringify({...row,status:'no_interview',dates:[],note:'격리 시험의 면접 미실시 정정'})]);
 traces=[];const corrected=await calendarRoute.POST(request({...input,track:coldData.suggestedCalendar.track})),correctedData=await corrected.json();assert.equal(correctedData.calendar.status,'no_interview');assert.equal(correctedData.calendar.canReview,false);assert.ok(!correctedData.calendar.tracks.includes(coldData.suggestedCalendar.track));assert.notEqual(correctedData.calendar.fingerprint,coldData.suggestedCalendar.fingerprint);assert.ok(traces.some(row=>row.sql.includes('select id,data from admission_calendar_versions')));
 assert.equal((await store.readAdmissionCalendar()).officialSchools,8,'an administrator-added school does not become another verified official source school');
 await client.query('update admission_calendar_admin_edits set deleted=true,revision=revision+1,updated_at=now()');const hidden=await calendarRoute.POST(request(input));assert.equal((await hidden.json()).calendar.tracks.length,0,'hiding a source row cannot keep a cached selectable track');
 await client.query('delete from admission_calendar_admin_edits');const restored=await calendarRoute.POST(request(input));assert.equal((await restored.json()).suggestedCalendar.canReview,true,'removing the fixture override restores the underlying source, not a stale no-interview result');
 actor={id:owner,role:'admin'};assert.equal((await calendarRoute.POST(request(input))).status,403);actor=null;assert.equal((await calendarRoute.POST(request(input))).status,401);assert.equal(afterCalls,0,'a fresh fixture never launches an external refresh');
 times.sort((a,b)=>a-b);console.log(JSON.stringify({isolatedSchema:true,existingAccountsChanged:false,publicSchoolCount:80,instantListBytes:Buffer.byteLength(JSON.stringify(initial)),schoolDetailBytes:{full:Buffer.byteLength(wholeText),registration:Buffer.byteLength(compactText)},calendar:{coldQueries,coldDatabaseBytes:coldBytes,coldMs:+coldMs.toFixed(2),warmQueries:2,warmDatabaseBytes:warmBytes,warmP50Ms:+times[3].toFixed(2),warmMaxMs:+times[6].toFixed(2)},suggestedTrackAvoidsSecondRequest:true,adminNoInterviewCorrectionInvalidates:true,ownerScopedRegistrationRead:true}));
}catch(error){failure=error;}finally{if(created){assert.match(schema,/^school_read_qa_[a-f0-9]{16}$/);await client.query('set search_path to public');await client.query(`drop schema "${schema}" cascade`);}await client.end();}
if(failure){console.error(redactEnvironmentSecrets((failure as Error).stack||failure));process.exitCode=1;}
