import {readFileSync} from 'node:fs';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from './load-env.mjs';
import {saveCalendarSnapshot} from '../apps/web/src/lib/admission-calendar-storage';
import type {AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model';
loadProjectEnv();
const catalogue=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8')) as AdmissionCalendarCatalogue;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
await db.connect();
try{
  await db.query('begin');
  const result=await saveCalendarSnapshot(db,catalogue);
  await db.query('commit');
  console.log(JSON.stringify(result));
}catch(error){
  await db.query('rollback');
  console.error(redactEnvironmentSecrets(error instanceof Error?error.message:String(error)));
  process.exitCode=1;
}finally{await db.end();}
