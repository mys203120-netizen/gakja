-- University/department public snapshot is bundled with the server and refreshed
-- from the Ministry of Education and KCUE. Student targets retain the selected
-- public identifiers plus source year; old approved content stays immutable.
create index if not exists support_targets_school_reference_idx
  on support_targets(student_id,(data->>'school_reference_id'));
create index if not exists support_targets_public_department_idx
  on support_targets(student_id,(data->>'department_public_code'))
  where data->>'department_public_code' is not null;
