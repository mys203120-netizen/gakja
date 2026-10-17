-- Identity and OAuth attempts are server-owned; no browser-side insert/update policy.
create table if not exists social_identities (
  provider text not null check (provider in ('google','kakao')),
  provider_id text not null check (length(provider_id) between 1 and 255),
  user_id uuid not null references profiles(id) on delete cascade,
  auth_mode text not null check (auth_mode in ('local','supabase')),
  created_at timestamptz not null default now(),
  last_signed_in_at timestamptz not null default now(),
  primary key(provider,provider_id)
);
create index if not exists social_identities_user_idx on social_identities(user_id);
create table if not exists oauth_login_attempts (
  state_hash text primary key,
  browser_hash text not null,
  provider text not null check (provider in ('google','kakao')),
  auth_mode text not null check (auth_mode in ('local','supabase')),
  next_path text not null,
  code_verifier text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_login_attempts_expiry_idx on oauth_login_attempts(expires_at);
alter table social_identities enable row level security;
alter table oauth_login_attempts enable row level security;
