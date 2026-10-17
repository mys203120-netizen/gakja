import 'server-only';
import { ApiError, query } from './db';
import type { Profile } from './auth';
import { enrichSchoolTarget } from './school-directory';

export const emptyLearning = { activities: [], questions: [], memory_items: [], source_refs: [], answer_scripts: [], support_targets: [], student_context: { core_keywords: [], representative_activity_ids: [], confirmed_goals: [] } };
export async function getLearning(studentId: string, version?: number) {
  const [pack] = await query('select * from content_packages where student_id=$1', [studentId]);
  if (!pack || (!pack.active_version && !version)) return { package: null, learning: emptyLearning, documents: [] };
  const [content] = await query('select * from content_versions where package_id=$1 and version=$2 and status=\'published\'', [pack.id, version ?? pack.active_version]);
  if (!content) throw new ApiError(404, '발행된 자료를 찾을 수 없어요.');
  const documents = (await query('select id,kind,data,content_version from documents where package_id=$1 and content_version=$2 order by kind', [pack.id, content.version])).map((r) => ({ ...r.data, id: r.id, content_version: r.content_version, kind: r.kind }));
  return { package: { ...pack, active_version: content.version }, learning: content.data, documents };
}
export async function getAdminData(user: Profile) {
  if (user.role === 'student') throw new ApiError(403, '접근 권한이 없어요.');
  const guard = user.role === 'admin' ? '' : ' and p.id in (select student_id from staff_assignments where staff_id=$1)';
  const params = user.role === 'admin' ? [] : [user.id];
  const students = await query(`select p.id,p.email,p.name,p.role,p.active,p.created_at,c.id as package_id,c.active_version from profiles p left join content_packages c on c.student_id=p.id where p.role='student'${guard} order by p.name`, params);
  const ids = students.map((s) => s.id);
  const [imports, confirmations, assignments, targets, productionLinks, audit, staff, usageLogs, briefings, knowledge, notifications, answers] = await Promise.all([
    query('select v.*,p.student_id,u.name as student_name from content_versions v join content_packages p on p.id=v.package_id join profiles u on u.id=p.student_id where p.student_id=any($1::uuid[]) order by v.created_at desc', [ids]),
    query('select c.*,p.name as student_name from student_confirmations c join profiles p on p.id=c.student_id where student_id=any($1::uuid[]) order by c.created_at desc', [ids]),
    query('select a.*,p.name as staff_name from staff_assignments a join profiles p on p.id=a.staff_id where student_id=any($1::uuid[])', [ids]),
    query('select * from support_targets where student_id=any($1::uuid[])', [ids]),
    query('select * from production_links where student_id=any($1::uuid[])', [ids]),
    query('select id,actor_id,student_id,action,data,created_at from audit_logs where student_id=any($1::uuid[]) order by created_at desc limit 30', [ids]),
    query('select id,email,name,role,active from profiles where role in (\'staff\',\'admin\') and active=true order by name'),
    query('select a.*,p.name as student_name from ai_usage_logs a join profiles p on p.id=a.student_id where a.student_id=any($1::uuid[]) order by a.created_at desc limit 100', [ids]),
    user.role === 'admin'
      ? query('select * from briefings order by created_at desc')
      : query("select * from briefings where data->>'owner_student_id' is null or data->>'owner_student_id'=any($1::text[]) order by created_at desc", [ids]),
    query('select * from knowledge_releases order by created_at desc'),
    query('select n.*,p.name as student_name from notifications n join profiles p on p.id=n.student_id where n.student_id=any($1::uuid[]) order by n.created_at desc limit 100', [ids]),
    query('select a.*,p.name as student_name from user_answers a join profiles p on p.id=a.student_id where a.student_id=any($1::uuid[]) order by a.updated_at desc limit 100', [ids]),
  ]);
  const totals = usageLogs.reduce((acc, row) => ({ requests: acc.requests + 1, input_tokens: acc.input_tokens + row.input_tokens, output_tokens: acc.output_tokens + row.output_tokens }), { requests: 0, input_tokens: 0, output_tokens: 0 });
  return { students, imports, confirmations, assignments, targets: targets.map((r) => ({ id: r.id, student_id: r.student_id, ...r.data })), productionLinks, audit, staff, usage: { totals, logs: usageLogs }, briefings, knowledge, notifications, answers };
}
export async function bootstrap(user: Profile) {
  if (user.role !== 'student') return { user, targets: [], package: null, documents: [], learning: emptyLearning, answers: [], memoryAttempts: [], memoryHistory: [], threads: [], interviews: [], reports: [], confirmations: [], notifications: [], admin: await getAdminData(user) };
  const [content, targets, answers, memoryAttempts, threads, interviews, reports, confirmations, notifications, preferences, readingProgress, briefings, preparationStates, memoryHistory] = await Promise.all([
    getLearning(user.id), query("select * from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id", [user.id]),
    query('select * from user_answers where student_id=$1 order by updated_at desc', [user.id]),
    query('select distinct on(memory_item_id) * from memory_attempts where student_id=$1 order by memory_item_id,created_at desc', [user.id]),
    // The shell only needs history metadata. Frozen resources and message bodies
    // remain available through the owning student's existing detail endpoints.
    query('select id,student_id,target_id,content_version,title,created_at,updated_at,archived_at,deleted_at from chat_threads where student_id=$1 and archived_at is null and deleted_at is null order by updated_at desc', [user.id]),
    query(`select id,student_id,kind,mode,target_id,content_version,state,created_at,updated_at,completed_at,
      jsonb_build_object(
        'context',jsonb_build_object(
          'target',data->'context'->'target','targetId',data->'context'->'targetId',
          'activities',coalesce((select jsonb_agg(jsonb_build_object('id',value->'id','title',value->'title','source_ref_ids',value->'source_ref_ids'))
            from jsonb_array_elements(case when state='active' and jsonb_typeof(data->'context'->'activities')='array' then data->'context'->'activities' else '[]'::jsonb end) as saved_activity(value)
            where current_question->'activity_ids' ? (value->>'id')),'[]'::jsonb)),
        'index',coalesce(data->'index','0'::jsonb),
        'questionCount',case when jsonb_typeof(data->'questionQueue')='array' then jsonb_array_length(data->'questionQueue') else 0 end,
        'currentQuestion',case when state='active' and jsonb_typeof(current_question)='object' then jsonb_build_object(
          'id',current_question->'id','prompt',current_question->'prompt','activity_ids',current_question->'activity_ids',
          'common_revision',current_question->'common_revision','source_type',current_question->'source_type',
          'source_kind',current_question->'source_kind','sourceKind',current_question->'sourceKind') else null end,
        'experienceCard',case when data->'experienceCard'->>'id' is not null then jsonb_build_object('id',data->'experienceCard'->'id') else null end,
        'targetName',data->'targetName'
      ) as data
      from interview_sessions cross join lateral (select jsonb_extract_path(data,'questionQueue',coalesce(nullif(data->>'index',''),'0')) as current_question) as overview
      where student_id=$1 order by created_at desc`, [user.id]),
    query('select * from interview_reports where student_id=$1 order by created_at desc', [user.id]),
    query('select * from student_confirmations where student_id=$1 order by created_at desc', [user.id]),
    query('select * from notifications where student_id=$1 order by created_at desc limit 50', [user.id]),
    query('select data from student_preferences where student_id=$1', [user.id]),
    query('select * from reading_progress where student_id=$1', [user.id]),
    query("select * from briefings where status='published' and (data->>'owner_student_id' is null or data->>'owner_student_id'=$1) order by created_at desc", [user.id]),
    query('select * from preparation_states where student_id=$1 order by updated_at desc', [user.id]),
    query('select * from memory_attempts where student_id=$1 order by created_at desc,id desc limit 100', [user.id]),
  ]);
  return { user, ...content, targets: targets.map((r) => enrichSchoolTarget({ id: r.id, student_id: r.student_id, ...r.data })), answers, memoryAttempts, memoryHistory, threads, interviews, reports, confirmations, notifications, preferences: preferences[0]?.data ?? {}, readingProgress, briefings, preparationStates };
}
