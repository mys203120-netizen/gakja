import 'server-only';
import type {PoolClient} from 'pg';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {learningScopeIdentity} from './learning-target-scope';
import {reconcileTrainingReviews,type ReviewQuestion,type ReviewState} from './training-review';

type Value=Record<string,any>;

/** Only identity fields participate: a display setting must not change a review's school scope. */
export function reviewDiagnostics(diagnostics:Value={}){
  return Object.fromEntries(Object.entries(diagnostics).map(([targetId,value]:[string,any])=>[targetId,{...value,
    targetKey:value.targetSnapshot?knowledgeTargetKey(learningScopeIdentity(value.targetSnapshot)):'unverified-target',
  }]));
}

/** Called under the student's shared planner lock. Recomputing never increments a completion counter. */
export async function synchronizeTrainingReviews(db:PoolClient,studentId:string,preferences:Value,questions:ReviewQuestion[],now=new Date().toISOString()){
  const result=reconcileTrainingReviews({state:preferences.trainingReview,questions,diagnostics:reviewDiagnostics(preferences.trainingDiagnostics),now});
  await saveTrainingReviewState(db,studentId,preferences.trainingReview,result.state);
  return result;
}

export async function saveTrainingReviewState(db:PoolClient,studentId:string,previous:unknown,state:ReviewState){
  if(knowledgeTargetKey(previous as Value)===knowledgeTargetKey(state as unknown as Value))return;
  await db.query("insert into student_preferences(student_id,data) values($1,jsonb_build_object('trainingReview',$2::jsonb)) on conflict(student_id) do update set data=jsonb_set(student_preferences.data,'{trainingReview}',$2::jsonb),updated_at=now()",[studentId,JSON.stringify(state)]);
}
