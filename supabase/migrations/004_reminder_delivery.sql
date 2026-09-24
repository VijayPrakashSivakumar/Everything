-- Reminder delivery: makes a reminder reach the user whether they are online or
-- offline and whether the app is open or closed.
--
-- Delivery chain after this migration:
--   * app open            -> script.js fires an exact timer and shows the notification
--                            through the service worker (works offline).
--   * app closed + online -> api/send-due-notifications.js sends a Web Push to every
--                            device the user (and their household) registered.
--   * app closed + offline-> sw.js re-arms its persisted schedule when it wakes up and
--                            shows the reminder itself.
--   * missed while offline-> the first client that comes back delivers it as "Missed".
--
-- Safe to run more than once.

/* ---------- items: when to deliver, and what was already delivered ---------- */

alter table if exists public.items
  add column if not exists reminder_at timestamptz,
  add column if not exists notified_at timestamptz,
  add column if not exists snoozed_until timestamptz;

-- Cheap lookup for the cron: open items whose reminder time has arrived.
create index if not exists items_reminder_due_idx
  on public.items (reminder_at)
  where done = false;

create index if not exists items_due_date_idx
  on public.items (due_date)
  where done = false;

comment on column public.items.reminder_at is
  'When the reminder should be delivered. Falls back to due_date when null.';
comment on column public.items.notified_at is
  'When a push or local notification was last delivered for this item.';
comment on column public.items.snoozed_until is
  'Reminder re-scheduled until this time (snooze from a notification).';

/* ---------- push_subscriptions: every device that can receive a push ---------- */

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  household_id uuid,
  endpoint text not null unique,
  subscription jsonb not null,
  platform text default '',
  user_agent text default '',
  timezone text default '',
  enabled boolean not null default true,
  created bigint default extract(epoch from now()) * 1000,
  last_seen_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* Upgrade a push_subscriptions table that an earlier prototype may have created by hand.
   The unique endpoint key is required for the client's ON CONFLICT (endpoint) upsert. */
alter table if exists public.push_subscriptions
  add column if not exists user_id uuid,
  add column if not exists household_id uuid,
  add column if not exists endpoint text,
  add column if not exists subscription jsonb,
  add column if not exists platform text default '',
  add column if not exists user_agent text default '',
  add column if not exists timezone text default '',
  add column if not exists enabled boolean not null default true,
  add column if not exists created bigint default extract(epoch from now()) * 1000,
  add column if not exists last_seen_at timestamptz default now(),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists push_subscriptions_endpoint_key
  on public.push_subscriptions (endpoint);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id)
  where enabled;

create index if not exists push_subscriptions_household_idx
  on public.push_subscriptions (household_id);

/* Kept here as well so this migration can be applied on its own. */
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists push_subscriptions_touch_updated_at on public.push_subscriptions;
create trigger push_subscriptions_touch_updated_at
before update on public.push_subscriptions
for each row
execute function public.touch_updated_at();

comment on table public.push_subscriptions is
  'One row per browser/device push endpoint. The cron uses it to reach a closed app.';

/* ---------- notification_log: audit trail of what was actually delivered ---------- */

create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  item_id uuid,
  user_id uuid,
  household_id uuid,
  channel text not null default 'local' check (channel in ('push', 'local', 'in_app')),
  status text not null default 'sent' check (status in ('sent', 'failed', 'missed', 'snoozed', 'skipped')),
  title text default '',
  body text default '',
  detail text default '',
  created_at timestamptz not null default now()
);

create index if not exists notification_log_item_idx
  on public.notification_log (item_id, created_at desc);

create index if not exists notification_log_user_idx
  on public.notification_log (user_id, created_at desc);

comment on table public.notification_log is
  'Audit of reminder deliveries (push/local) so a user can see when they were reached.';

/* ---------- Row level security ---------- */

alter table public.push_subscriptions enable row level security;
alter table public.notification_log enable row level security;

drop policy if exists push_subscriptions_access on public.push_subscriptions;
create policy push_subscriptions_access on public.push_subscriptions
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid());

drop policy if exists notification_log_access on public.notification_log;
create policy notification_log_access on public.notification_log
for all
using (user_id = auth.uid() or public.is_household_member(household_id))
with check (user_id = auth.uid() or public.is_household_member(household_id));
