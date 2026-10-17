import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from './load-env.mjs';
import {cleanupStudentRecordFixtures} from '../tests/student-record-fixture-cleanup.mts';
loadProjectEnv();
const url=new URL(process.env.DATABASE_URL!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Local fixture cleanup only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{const rows=(await db.query("select id from profiles where name='학생부형 검증 임시 학생' and email ~ '^student-record-[a-f0-9-]{36}-[ab]@gakja[.]test$'")).rows;await cleanupStudentRecordFixtures(db,rows.map(row=>row.id));console.log(JSON.stringify({syntheticProfilesRemoved:rows.length}));}
catch(error){console.error(redactEnvironmentSecrets(error instanceof Error?error.message:String(error)));process.exitCode=1;}
finally{await db.end();}
