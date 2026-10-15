-- 011_tickets.sql — Support tickets.
--
-- Users report issues; the development team triages, tracks and resolves them.
-- Status moves forward only: open -> in_progress -> resolved.
-- Priority (low | normal | high | urgent) sets the queue order.
--
-- This file is safe to run more than once in the Supabase SQL editor: every
-- object is created "if not exists" and every policy is dropped before it is
-- re-created, so a second paste cannot fail halfway and leave half a schema.

create extension if not exists "pgcrypto";

create table if not exists tickets (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  title            text not null,
  description      text not null default '',
  category         text not null default 'question'
    check (category in ('bug', 'feature', 'question', 'other')),
  priority         text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  status           text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved')),
  resolution_note  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Backfill the two columns in case a table from an earlier paste exists without
-- them. `add column if not exists` is a no-op when they are already present.
alter table tickets add column if not exists description     text not null default '';
alter table tickets add column if not exists resolution_note text;
alter table tickets add column if not exists updated_at      timestamptz not null default now();

alter table tickets enable row level security;

-- Drop-then-create so a re-run replaces the policies instead of erroring on the
-- duplicate name. Each person sees and changes only their own tickets.
drop policy if exists "Users can insert their own tickets" on tickets;
drop policy if exists "Users can read their own tickets"   on tickets;
drop policy if exists "Users can update their own tickets" on tickets;

create policy "Users can insert their own tickets"
  on tickets for insert
  with check (auth.uid()::text = user_id);

create policy "Users can read their own tickets"
  on tickets for select
  using (auth.uid()::text = user_id);

create policy "Users can update their own tickets"
  on tickets for update
  using (auth.uid()::text = user_id);

-- Keep updated_at honest even if a row is changed outside the API. The function
-- is replaced with the same body, so re-running is safe too.
create or replace function tickets_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tickets_set_updated_at on tickets;
create trigger tickets_set_updated_at
  before update on tickets
  for each row
  execute function tickets_touch_updated_at();

create index if not exists tickets_user_created on tickets (user_id, created_at desc);
create index if not exists tickets_user_status  on tickets (user_id, status);
