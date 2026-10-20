type Value=Record<string,any>;

/** Ending a room preserves records; only every frozen root having a valid answer completes its lesson. */
export function interviewCompletion(data:Value,turns:Value[]){
  const planned=Array.isArray(data.questionQueue)?data.questionQueue:[];
  const ids=[...new Set(planned.map((root:Value)=>String(root.id||'')).filter(Boolean))];
  const answered=new Set(turns.filter(turn=>{
    const value=turn.data||turn;
    return value.invalidated!==true&&Number(value.followupDepth||0)===0&&typeof value.answer==='string'&&value.answer.trim();
  }).map(turn=>{const value=turn.data||turn;return String(value.rootQuestionId||turn.question_id||'');}));
  return {expectedRootCount:ids.length,answeredRootCount:ids.filter(id=>answered.has(id)).length,
    allRootsAnswered:planned.length>0&&ids.length===planned.length&&ids.every(id=>answered.has(id))};
}

/** Used by compact read models without trusting cached progress or loading historical answer bodies. */
export function allInterviewRootsAnsweredSql(alias='s'){
  if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error('Invalid SQL session alias');
  const queue=`case when jsonb_typeof(${alias}.data->'questionQueue')='array' then ${alias}.data->'questionQueue' else '[]'::jsonb end`;
  return `(jsonb_array_length(${queue})>0 and jsonb_array_length(${queue})=(select count(distinct root->>'id') from jsonb_array_elements(${queue}) root) and not exists(select 1 from jsonb_array_elements(${queue}) root where nullif(root->>'id','') is null or not exists(select 1 from interview_turns completion_turn where completion_turn.session_id=${alias}.id and completion_turn.student_id=${alias}.student_id and coalesce(completion_turn.data->>'invalidated','false')<>'true' and coalesce(completion_turn.data->>'followupDepth','0')='0' and nullif(btrim(completion_turn.data->>'answer'),'') is not null and coalesce(completion_turn.data->>'rootQuestionId',completion_turn.question_id)=root->>'id')))`;
}
