-- Adds a real completion timestamp to items.
--
-- Before this column existed the app only knew *that* an item was done (the boolean
-- `items.done`), so "when" was tracked in a per-device localStorage log. With this
-- column the completion time is stored with the item, which means:
--   * the Reports activity chart is accurate on every device, and
--   * household members see the same completion history.
--
-- Safe to run more than once.

alter table if exists public.items
  add column if not exists completed_at timestamptz;

create index if not exists items_completed_at_idx
  on public.items (completed_at)
  where completed_at is not null;

comment on column public.items.completed_at is
  'When the item was marked complete (null while it is still open).';
