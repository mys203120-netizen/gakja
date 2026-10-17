import {readFileSync} from 'node:fs';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from './load-env.mjs';
import {saveOfficialCalendarSupplement} from '../apps/web/src/lib/official-admission-calendar-storage';
import type {OfficialCalendarSupplement} from '../apps/web/src/lib/official-admission-calendar';

loadProjectEnv();
const supplement=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-official.json',import.meta.url),'utf8')) as OfficialCalendarSupplement;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
await db.connect();
try{
  await db.query('begin');
  const result=await saveOfficialCalendarSupplement(db,supplement);
  await db.query('commit');
  console.log(JSON.stringify(result));
}catch(error){
  await db.query('rollback');
  console.error(redactEnvironmentSecrets(error instanceof Error?error.message:String(error)));
  process.exitCode=1;
}finally{await db.end();}
