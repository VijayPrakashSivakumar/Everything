-- Adds the household/workspace model for shared family data.
-- Safe to run multiple times.

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Household',
  invite_code text unique,
  created_by uuid,
  created bigint default extract(epoch from now()) * 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner', 'member', 'admin')),
  created_at timestamptz not null default now(),
  unique (household_id, user_id)
);

create index if not exists households_invite_code_idx
  on public.households (invite_code);

create index if not exists household_members_user_idx
  on public.household_members (user_id);

create or replace function public.touch_household_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists households_touch_updated_at on public.households;
create trigger households_touch_updated_at
before update on public.households
for each row
execute function public.touch_household_updated_at();

comment on table public.households is
  'Workspace or household that owns shared family data.';

comment on table public.household_members is
  'Membership relationship between a user and a household.';

alter table if exists public.household_members
  add column if not exists household_id uuid,
  add column if not exists user_id uuid;

-- Upgrade tables that may have been created by an earlier prototype schema.
alter table if exists public.entries
  add column if not exists household_id uuid,
  add column if not exists user_id uuid;

alter table if exists public.tasks
  add column if not exists household_id uuid,
  add column if not exists user_id uuid;

alter table if exists public.people
  add column if not exists household_id uuid,
  add column if not exists user_id uuid;

alter table if exists public.projects
  add column if not exists household_id uuid,
  add column if not exists user_id uuid;

alter table if exists public.goals
  add column if not exists household_id uuid,
  add column if not exists user_id uuid;

alter table if exists public.items
  add column if not exists household_id uuid,
  add column if not exists owner_id uuid;

-- Keep browser access limited to the signed-in user's household. Supabase's
-- service-role client used by the API bypasses these policies.
create or replace function public.is_household_member(h_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members
    where household_id = h_id
      and user_id = auth.uid()
  );
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.entries enable row level security;
alter table public.tasks enable row level security;
alter table public.people enable row level security;
alter table public.projects enable row level security;
alter table public.goals enable row level security;
alter table if exists public.items enable row level security;

drop policy if exists households_access on public.households;
create policy households_access on public.households
for all
using (created_by = auth.uid() or public.is_household_member(id))
with check (created_by = auth.uid());

drop policy if exists household_members_access on public.household_members;
create policy household_members_access on public.household_members
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid());

drop policy if exists entries_access on public.entries;
create policy entries_access on public.entries
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid() or public.is_household_member(household_id));

drop policy if exists tasks_access on public.tasks;
create policy tasks_access on public.tasks
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid() or public.is_household_member(household_id));

drop policy if exists people_access on public.people;
create policy people_access on public.people
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid() or public.is_household_member(household_id));

drop policy if exists projects_access on public.projects;
create policy projects_access on public.projects
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid() or public.is_household_member(household_id));

drop policy if exists goals_access on public.goals;
create policy goals_access on public.goals
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid() or public.is_household_member(household_id));

drop policy if exists items_household_access on public.items;
create policy items_household_access on public.items
for all
using (owner_id = auth.uid() or public.is_household_member(household_id))
with check (owner_id = auth.uid() or public.is_household_member(household_id));
