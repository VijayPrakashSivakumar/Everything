-- Some older deployments created these tables before the foundation migration.
-- Normalize the columns used by the API and RLS policies before referencing them.
alter table if exists public.entries
  add column if not exists household_id uuid,
  add column if not exists user_id uuid,
  add column if not exists visibility text not null default 'shared',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.tasks
  add column if not exists household_id uuid,
  add column if not exists user_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.projects
  add column if not exists household_id uuid,
  add column if not exists user_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.people
  add column if not exists household_id uuid,
  add column if not exists user_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.goals
  add column if not exists household_id uuid,
  add column if not exists user_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table if exists public.items
  add column if not exists household_id uuid,
  add column if not exists owner_id uuid,
  add column if not exists scope text not null default 'shared';

-- Phase 1 persistence hardening.
--
-- The client generates a stable client_id before it sends a record.  The API
-- uses it for idempotent creates, so a retry or double tap cannot create two
-- rows.  Existing rows remain valid because the column is nullable.
-- Safe to run more than once.

alter table if exists public.entries
  add column if not exists client_id text;

alter table if exists public.tasks
  add column if not exists client_id text;

alter table if exists public.projects
  add column if not exists client_id text;

alter table if exists public.people
  add column if not exists client_id text;

alter table if exists public.goals
  add column if not exists client_id text;

create unique index if not exists entries_household_client_id_key
  on public.entries (household_id, client_id)
  where client_id is not null;

create unique index if not exists tasks_household_client_id_key
  on public.tasks (household_id, client_id)
  where client_id is not null;

create unique index if not exists projects_household_client_id_key
  on public.projects (household_id, client_id)
  where client_id is not null;

create unique index if not exists people_household_client_id_key
  on public.people (household_id, client_id)
  where client_id is not null;

create unique index if not exists goals_household_client_id_key
  on public.goals (household_id, client_id)
  where client_id is not null;

comment on column public.entries.client_id is
  'Stable client-generated identifier used for idempotent capture writes.';
comment on column public.tasks.client_id is
  'Stable client-generated identifier used for idempotent task writes.';

-- Private records are readable/writable only by their owner. Household members can
-- still collaborate on shared records, but browser RLS must enforce this too --
-- not only the service-role API layer.
drop policy if exists entries_access on public.entries;
create policy entries_access on public.entries
  for all
  using (
    user_id = auth.uid()
    or (
      public.is_household_member(household_id)
      and coalesce(visibility, 'shared') <> 'private'
      and coalesce(metadata->>'scope', 'shared') <> 'private'
    )
  )
  with check (
    user_id = auth.uid()
    or (
      public.is_household_member(household_id)
      and coalesce(visibility, 'shared') <> 'private'
      and coalesce(metadata->>'scope', 'shared') <> 'private'
    )
  );

drop policy if exists tasks_access on public.tasks;
create policy tasks_access on public.tasks
  for all
  using (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  )
  with check (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  );

drop policy if exists projects_access on public.projects;
create policy projects_access on public.projects
  for all
  using (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  )
  with check (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  );

drop policy if exists people_access on public.people;
create policy people_access on public.people
  for all
  using (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  )
  with check (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  );

drop policy if exists goals_access on public.goals;
create policy goals_access on public.goals
  for all
  using (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  )
  with check (
    user_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(metadata->>'scope', 'shared') <> 'private')
  );

drop policy if exists items_household_access on public.items;
create policy items_household_access on public.items
  for all
  using (
    owner_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(scope, 'shared') <> 'private')
  )
  with check (
    owner_id = auth.uid()
    or (public.is_household_member(household_id) and coalesce(scope, 'shared') <> 'private')
  );

