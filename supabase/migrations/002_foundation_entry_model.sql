-- Phase 1 foundation for Everything.
-- Adds the core entry/task model so capture and planning are built on a single
-- source of truth instead of browser-only objects.
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  user_id uuid,
  kind text not null default 'text' check (
    kind in (
      'text', 'task', 'event', 'memory', 'waiting', 'openloop', 'voice',
      'image', 'file', 'link', 'reminder'
    )
  ),
  source_type text not null default 'manual' check (
    source_type in ('manual', 'voice', 'image', 'file', 'link', 'ai', 'import')
  ),
  title text not null default '',
  description text default '',
  raw_text text default '',
  status text not null default 'inbox' check (
    status in ('inbox', 'planned', 'today', 'in_progress', 'waiting', 'completed', 'cancelled', 'someday')
  ),
  visibility text not null default 'shared' check (
    visibility in ('private', 'shared', 'shared_with_family', 'shared_with_selected')
  ),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(raw_text, ''))
  ) stored
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid references public.entries(id) on delete cascade,
  household_id uuid,
  user_id uuid,
  title text not null,
  description text default '',
  status text not null default 'inbox' check (
    status in ('inbox', 'planned', 'today', 'in_progress', 'waiting', 'completed', 'cancelled', 'someday')
  ),
  priority text not null default 'normal' check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  due_at timestamptz,
  start_at timestamptz,
  duration_minutes integer,
  recurrence_rule text,
  project_id uuid,
  person_id uuid,
  goal_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  user_id uuid,
  name text not null,
  notes text default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  user_id uuid,
  name text not null,
  description text default '',
  status text not null default 'active' check (
    status in ('active', 'paused', 'completed', 'archived')
  ),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  user_id uuid,
  title text not null,
  description text default '',
  status text not null default 'active' check (
    status in ('active', 'paused', 'completed', 'archived')
  ),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists entries_household_created_idx
  on public.entries (household_id, created_at desc);

create index if not exists entries_search_idx
  on public.entries using gin (search_vector);

create index if not exists tasks_household_due_idx
  on public.tasks (household_id, due_at);

create index if not exists tasks_status_idx
  on public.tasks (status);

comment on table public.entries is
  'Base capture object; all input eventually becomes an entry before being structured.';

comment on table public.tasks is
  'Structured task objects derived from entries and user workflow.';

comment on table public.people is
  'People and relationships discovered from captured content.';

comment on table public.projects is
  'Projects that group tasks, notes, files, and people.';

comment on table public.goals is
  'Long-term goals for planning and reflection.';

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists entries_touch_updated_at on public.entries;
create trigger entries_touch_updated_at
before update on public.entries
for each row
execute function public.touch_updated_at();

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
before update on public.tasks
for each row
execute function public.touch_updated_at();

drop trigger if exists people_touch_updated_at on public.people;
create trigger people_touch_updated_at
before update on public.people
for each row
execute function public.touch_updated_at();

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
before update on public.projects
for each row
execute function public.touch_updated_at();

drop trigger if exists goals_touch_updated_at on public.goals;
create trigger goals_touch_updated_at
before update on public.goals
for each row
execute function public.touch_updated_at();
