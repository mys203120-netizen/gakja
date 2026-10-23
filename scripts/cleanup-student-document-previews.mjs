import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from './load-env.mjs';
loadProjectEnv();
const apply=process.argv.includes('--apply');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try{
  // This table contains only unconfirmed staging files, never locked originals or text versions.
  const result=apply?await client.query('delete from student_document_previews where expires_at<=now() returning id'):await client.query('select id from student_document_previews where expires_at<=now()');
  console.log(JSON.stringify({mode:apply?'deleted_expired_previews':'dry_run',count:result.rowCount}));
}catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.message:String(error)));process.exitCode=1;}finally{await client.end();}
