import type pg from 'pg';
/** Cleanup is restricted to this suite's synthetic email namespace and supplied UUIDs. */
export async function cleanupStudentRecordFixtures(db:pg.Client,ids:string[]){
  if(!ids.length)return;
  const owned=(await db.query('select id,email from profiles where id=any($1::uuid[])',[ids])).rows;
  if(owned.some(row=>!/^student-record-[a-f0-9-]{36}-[ab]@gakja\.test$/.test(row.email)))throw new Error('Refusing to clean a non-fixture profile');
  await db.query('begin');
  try{
    await db.query('delete from learning_requests where actor_id=any($1::uuid[])',[ids]);
    for(const table of ['quiz_assignments','quiz_sessions','interview_sessions','student_plans','knowledge_bite_progress','study_sessions','study_imported_events','school_profiles','student_preferences'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[ids]);
    await db.query('delete from audit_logs where student_id=any($1::uuid[]) or actor_id=any($1::uuid[])',[ids]);
    await db.query('delete from support_targets where student_id=any($1::uuid[])',[ids]);
    await db.query('delete from sessions where user_id=any($1::uuid[])',[ids]);
    await db.query('delete from profiles where id=any($1::uuid[])',[ids]);
    await db.query('commit');
  }catch(error){await db.query('rollback');throw error;}
}
