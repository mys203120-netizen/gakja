create index if not exists quiz_assignments_student_created_cursor_idx on quiz_assignments(student_id,created_at desc,id desc);
create index if not exists quiz_assignments_student_state_created_cursor_idx on quiz_assignments(student_id,state,created_at desc,id desc);
create index if not exists quiz_submissions_assignment_item_latest_idx on quiz_submissions(student_id,assignment_id,memory_item_id,submitted_at desc,id desc);
create index if not exists quiz_assignment_events_assignment_cursor_idx on quiz_assignment_events(student_id,assignment_id,created_at desc,id desc);
