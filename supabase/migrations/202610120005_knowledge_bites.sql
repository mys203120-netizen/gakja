-- External-video completion is explicitly self reported, not player telemetry.
create table if not exists knowledge_bite_progress (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id),
  video_id text not null check(video_id ~ '^[a-zA-Z0-9_-]{11}$'),
  saved boolean not null default false,
  completed_at timestamptz,
  reflection text not null default '' check(length(reflection)<=4000),
  revision integer not null check(revision>0),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(student_id,video_id)
);
create index if not exists knowledge_bite_progress_student_updated on knowledge_bite_progress(student_id,updated_at desc);
create table if not exists knowledge_bite_revisions (
  id uuid primary key default gen_random_uuid(),
  progress_id uuid not null references knowledge_bite_progress(id) on delete cascade,
  student_id uuid not null references profiles(id),
  video_id text not null check(video_id ~ '^[a-zA-Z0-9_-]{11}$'),
  saved boolean not null,
  completed_at timestamptz,
  reflection text not null check(length(reflection)<=4000),
  revision integer not null check(revision>0),
  created_at timestamptz not null default now(),
  unique(progress_id,revision)
);
alter table knowledge_bite_progress enable row level security;
alter table knowledge_bite_revisions enable row level security;
do $$ begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy own_student_read on knowledge_bite_progress for select to authenticated using (student_id=auth.uid())';
    execute 'create policy own_student_read on knowledge_bite_revisions for select to authenticated using (student_id=auth.uid())';
  end if;
end $$;
