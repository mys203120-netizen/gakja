-- The overview reads a compact aggregate plus two bounded, immutable timestamp cursors.
create index if not exists study_session_history_student_cursor_idx on study_session_events(student_id,created_at desc,id desc);
create index if not exists study_session_history_session_cursor_idx on study_session_events(student_id,session_id,created_at desc,id desc);
create index if not exists study_imported_history_student_cursor_idx on study_imported_events(student_id,occurred_at desc,id desc);
create index if not exists study_session_report_cursor_idx on study_sessions(student_id,started_at desc,id desc)
  where state='finalized' and coalesce((report->>'eventCount')::int,0)>0;
