-- Phase 2 task workflow support.
--
-- The live app still treats public.items as the source of truth for reminders,
-- realtime updates, and offline compatibility.  Checklist steps therefore live
-- beside the existing item fields rather than in a second client-only store.
-- Existing rows receive an empty checklist and remain valid.
-- Safe to run more than once.

alter table if exists public.items
  add column if not exists household_id uuid,
  add column if not exists status text,
  add column if not exists due_date timestamptz,
  add column if not exists kind text not null default 'text',
  add column if not exists done boolean not null default false,
  add column if not exists checklist jsonb not null default '[]'::jsonb,
  add column if not exists recurrence_key text,
  add column if not exists archived_at timestamptz;

alter table if exists public.tasks
  add column if not exists checklist jsonb not null default '[]'::jsonb,
  add column if not exists recurrence_key text,
  add column if not exists archived_at timestamptz;

do $$
begin
  if to_regclass('public.items') is not null then
    execute 'comment on column public.items.checklist is ''Task checklist steps stored as an array of {id, text, done} objects.''';
    execute 'comment on column public.items.recurrence_key is ''Stable series key used to prevent duplicate recurring occurrences across devices.''';
    execute 'comment on column public.items.archived_at is ''Timestamp when an item was reversibly archived.'';';
    execute 'drop index if exists public.items_task_status_due_idx';
    execute 'create index items_task_status_due_idx on public.items (household_id, status, due_date) where kind = ''task'' and done = false and archived_at is null';
  end if;
  if to_regclass('public.tasks') is not null then
    execute 'comment on column public.tasks.checklist is ''Task checklist steps stored as an array of {id, text, done} objects.''';
    execute 'comment on column public.tasks.recurrence_key is ''Stable series key used to prevent duplicate recurring occurrences across devices.''';
    execute 'comment on column public.tasks.archived_at is ''Timestamp when a task was reversibly archived.'';';
  end if;
end
$$;
