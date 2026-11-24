-- 012_calendar_events.sql — Calendar events for two-way Google Calendar sync
-- Run: supabase db push or execute in Supabase SQL editor
-- Safe to run multiple times.

create extension if not exists "pgcrypto";

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete set null,

  -- Google Calendar event ID (for two-way sync)
  google_event_id text unique,

  -- Event details from capture or sync
  title text not null,
  description text,
  start_time timestamptz not null,
  end_time timestamptz,

  -- Recurrence
  recurrence text default 'none', -- none, daily, weekly, monthly, yearly
  recurrence_id text, -- for recurring series

  -- Sync status
  synced_to_google boolean not null default false,
  sync_error text,
  last_sync_at timestamptz,

  -- Timestamps
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

/* ---------- Touch updated_at trigger ---------- */

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger on_calendar_events_updated_at
  before update on public.calendar_events
  for each row
  execute function public.touch_updated_at();

/* ---------- Indexes for performance ---------- */

create index if not exists idx_calendar_events_user_id on public.calendar_events(user_id);
create index if not exists idx_calendar_events_household_id on public.calendar_events(household_id);
create index if not exists idx_calendar_events_start_time on public.calendar_events(start_time);
create index if not exists idx_calendar_events_google_id on public.calendar_events(google_event_id);
create index if not exists idx_calendar_events_recurrence on public.calendar_events(recurrence);

comment on table public.calendar_events is 'Google Calendar events synced two-way with Everything captures';
comment on column public.calendar_events.google_event_id is 'Google Calendar event ID for two-way sync (null if not synced)';
comment on column public.calendar_events.synced_to_google is 'Whether this event has been created in Google Calendar';