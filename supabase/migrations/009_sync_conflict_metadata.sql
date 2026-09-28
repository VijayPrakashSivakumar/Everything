-- Per-item change timestamps, so two devices that were offline at the same time cannot
-- silently overwrite each other.
--
-- The `items` table is the one the app actually reads and writes, and unlike entries,
-- tasks, people and goals it had no updated_at at all. Without it the client had nothing
-- to compare and every conflict was resolved by "whoever synced last", which quietly threw
-- away the other person's edit.
--
-- Deliberately NO before-update trigger here, unlike the other tables. A trigger would stamp
-- the server's clock on every write and destroy the one piece of information conflict
-- resolution actually needs: when the edit was made. The client sends updated_at with the
-- write, and server-side writers (the notification cron) set it explicitly.
--
-- Safe to run more than once.

alter table if exists public.items
  add column if not exists updated_at timestamptz;

-- Backfill from the epoch-millisecond `created` so pre-existing rows get their real age.
-- default now() would have stamped every old row as "changed just now", making them all look
-- newer than any genuine edit made today.
update public.items
   set updated_at = to_timestamp(created / 1000.0)
 where updated_at is null
   and created is not null;

update public.items
   set updated_at = now()
 where updated_at is null;

alter table if exists public.items
  alter column updated_at set default now(),
  alter column updated_at set not null;

-- The pull is "everything in this household, newest first", so the index matches it.
create index if not exists items_household_updated_at_idx
  on public.items (household_id, updated_at desc);

comment on column public.items.updated_at is
  'When the item was last edited. Supplied by the client so conflict resolution compares edit times rather than sync times.';

-- Reminder: api/send-due-notifications.js is a server-side writer, so it must set
-- updated_at = now() on the rows it marks notified. Without that, a later push from any
-- device looks like it is still the newest edit and quietly undoes the delivery flag.
