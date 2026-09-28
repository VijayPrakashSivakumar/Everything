-- Morning digest opt-in.
--
-- The client already knows whether someone wants the digest; this table is how the
-- server learns it, which is what lets the digest reach a phone with the app closed.
--
-- The important property is what happens when this table is missing or empty: no rows
-- means no digests, ever. A feature that must never appear uninvited has to fail
-- towards silence, not towards a query error on every cron run.
--
-- Safe to run more than once.
create table if not exists public.digest_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  timezone text not null default 'UTC',
  -- The local calendar day the last digest actually went out on. Compared in the user's
  -- own timezone, so the digest is once a day for them rather than once a day for UTC.
  last_sent_on text,
  last_sent_at timestamptz,
  created timestamptz not null default now()
);

-- A missing row and a disabled row must behave identically, so the read is "enabled = true".
create index if not exists digest_preferences_enabled_idx
  on public.digest_preferences (enabled)
  where enabled;

alter table public.digest_preferences enable row level security;

-- A person may read and write their own preference, and nobody else's. The cron uses the
-- service role, which bypasses RLS, so this grants nothing to the server path.
drop policy if exists digest_preferences_own on public.digest_preferences;
create policy digest_preferences_own on public.digest_preferences
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

do $$
begin
  if to_regclass('public.digest_preferences') is not null then
    execute 'comment on table public.digest_preferences is ''Opt-in for the daily morning digest. No row means off.''';
  end if;
end
$$;
