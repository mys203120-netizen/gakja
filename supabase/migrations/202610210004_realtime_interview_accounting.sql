-- Realtime call lifecycle is independent of request quota accounting.
alter table ai_usage_logs add column if not exists realtime_usage jsonb not null default '{}';
alter table ai_usage_logs add column if not exists realtime_issued_at timestamptz;
alter table ai_usage_logs add column if not exists realtime_closed_at timestamptz;
create index if not exists ai_realtime_cleanup_idx on ai_usage_logs(feature,status,created_at)
  where feature='interview_realtime' and status in ('issued','connected','cleanup_pending','failed');
create table if not exists interview_realtime_usage_events (
  usage_id uuid not null references ai_usage_logs(id) on delete cascade,
  response_id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key(usage_id,response_id)
);
alter table interview_realtime_usage_events enable row level security;
-- No client policies: only authenticated, server-owned provider observations may write.
