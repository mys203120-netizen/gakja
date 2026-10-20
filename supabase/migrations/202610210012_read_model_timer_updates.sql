-- Future answer metadata and legacy assistance aliases must also invalidate projections.
-- Only the editable draft is excluded; source identity and every saved answer fact remain authoritative.
create or replace function bump_student_learning_revision() returns trigger language plpgsql as $$
declare row_data jsonb; previous_data jsonb; item jsonb; owner uuid; owners uuid[]='{}'; changed boolean;
begin
 row_data=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 previous_data=case when tg_op='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 if tg_op='UPDATE' and previous_data->'student_id' is not distinct from row_data->'student_id' then
  if tg_table_name='student_preferences' then
   select exists(select 1 from unnest(array['answer_meaning_checks','trainingDiagnostics','trainingAvailability','automaticPractice','trainingActivityNotes','selectedTargetId']) k where previous_data->'data'->k is distinct from row_data->'data'->k) into changed;
   if not changed then return new; end if;
  elsif tg_table_name='study_sessions' then
   if previous_data->'state' is not distinct from row_data->'state' and previous_data->'report' is not distinct from row_data->'report' then return new; end if;
  elsif tg_table_name='interview_sessions' then
   if (previous_data - array['updated_at','data']) is not distinct from (row_data - array['updated_at','data']) and ((previous_data->'data') - array['elapsedMs','activeSince','timerLeaseUntil','paused']) is not distinct from ((row_data->'data') - array['elapsedMs','activeSince','timerLeaseUntil','paused']) then return new; end if;
  elsif tg_table_name='interview_turns' and previous_data->'session_id' is not distinct from row_data->'session_id' and previous_data->'question_id' is not distinct from row_data->'question_id' then
   if ((previous_data->'data')-'draft') is not distinct from ((row_data->'data')-'draft') then return new; end if;
  end if;
 end if;
 foreach item in array case when tg_op='UPDATE' then array[row_data,previous_data] else array[row_data] end loop
  owner=nullif(item->>'student_id','')::uuid;
  if owner is null and tg_table_name='answer_revisions' then
   execute format('select student_id from %I.user_answers where id=$1::uuid',tg_table_schema) into owner using item->>'answer_id';
  elsif owner is null and tg_table_name='content_versions' then
   execute format('select student_id from %I.content_packages where id=$1',tg_table_schema) into owner using item->>'package_id';
  end if;
  if owner is not null and not(owner=any(owners)) then owners=array_append(owners,owner); end if;
 end loop;
 if cardinality(owners)>0 then
  foreach owner in array owners loop
   execute format('select exists(select 1 from %I.profiles where id=$1)',tg_table_schema) into changed using owner;
   if changed then execute format('insert into %I.student_learning_revisions(student_id,revision) values($1,1) on conflict(student_id) do update set revision=student_learning_revisions.revision+1',tg_table_schema) using owner; end if;
  end loop;
 else
  execute format('update %I.learning_catalog_revision set revision=revision+1 where singleton=true',tg_table_schema);
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
