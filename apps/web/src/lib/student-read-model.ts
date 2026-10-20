import 'server-only';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,transaction} from './db';

// Bump when a projection contract or its source-folding rules change.
const READ_MODEL_FORMAT='2026-10-21:4';

export async function studentModelRevision(db:PoolClient,studentId:string){
  const row=(await db.query("select coalesce((select revision from student_learning_revisions where student_id=$1),0)::text||':'||(select revision::text from learning_catalog_revision where singleton=true) as revision",[studentId])).rows[0];
  return row.revision as string;
}

/** Compact, reproducible aggregates. History bodies belong to paged/detail APIs, never this cache. */
export async function readStudentModel<T>(studentId:string,kind:string,scope:string,build:()=>Promise<T>,connection?:PoolClient):Promise<T>{
  // Callers may describe many saved targets. Keep advisory/index keys bounded, independently of that JSON.
  const cacheScope=createHash('sha256').update(READ_MODEL_FORMAT+'\n'+scope).digest('hex');
  const work=async(db:PoolClient)=>{
    const revision=()=>studentModelRevision(db,studentId);
    // Single-flight builds are separate from source writes; never hold an epoch row lock while folding facts.
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`read-model:${studentId}:${kind}:${cacheScope}`]);
    for(let attempt=0;attempt<3;attempt++){
      const before=await revision();
      const saved=(await db.query('select payload from student_read_models where student_id=$1 and kind=$2 and scope=$3 and source_revision=$4',[studentId,kind,cacheScope,before])).rows[0];
      if(saved)return saved.payload as T;
      const value=await build();
      if(await revision()!==before)continue;
      await db.query('insert into student_read_models(student_id,kind,scope,source_revision,payload) values($1,$2,$3,$4,$5::jsonb) on conflict(student_id,kind,scope) do update set source_revision=excluded.source_revision,payload=excluded.payload,computed_at=now()',[studentId,kind,cacheScope,before,JSON.stringify(value)]);
      await db.query("delete from student_read_models where student_id=$1 and computed_at<now()-interval '14 days'",[studentId]);
      return value;
    }
    throw new ApiError(409,'새 학습 기록을 반영하고 있어요. 잠시 후 다시 확인해 주세요.');
  };
  return connection?work(connection):transaction(work);
}
