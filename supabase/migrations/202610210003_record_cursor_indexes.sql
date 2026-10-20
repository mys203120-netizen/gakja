-- Created-time cursors are immutable under edits, with UUID ties and student scope.
create index if not exists user_answers_student_created_cursor_idx on user_answers(student_id,created_at desc,id desc);
create index if not exists interview_sessions_student_created_cursor_idx on interview_sessions(student_id,created_at desc,id desc);
create index if not exists interview_sessions_student_target_created_cursor_idx on interview_sessions(student_id,target_id,created_at desc,id desc);
create index if not exists interview_sessions_student_active_resume_idx on interview_sessions(student_id,target_id,kind,created_at desc,id desc) where state='active';
create index if not exists interview_reports_student_created_cursor_idx on interview_reports(student_id,created_at desc,id desc);
create index if not exists memory_attempts_student_created_cursor_idx on memory_attempts(student_id,created_at desc,id desc);
create index if not exists chat_threads_student_created_cursor_idx on chat_threads(student_id,created_at desc,id desc);
create index if not exists notifications_student_created_cursor_idx on notifications(student_id,created_at desc,id desc);
create index if not exists notifications_student_unread_idx on notifications(student_id) where read_at is null;
create index if not exists student_confirmations_student_created_cursor_idx on student_confirmations(student_id,created_at desc,id desc);
create index if not exists briefings_published_created_cursor_idx on briefings(created_at desc,id desc) where status='published';
create index if not exists answer_revisions_created_cursor_idx on answer_revisions(created_at desc,id desc);
