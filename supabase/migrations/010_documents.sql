-- Documents, warranties and receipts.
--
-- A document is a *kind of item*, not a table of its own. The reminder engine, offline
-- queue, realtime sync, RLS, search, backup and household sharing are all built around
-- public.items, so reusing it is what makes documents work on a phone with no network
-- and cost nothing to sync. A separate table would have needed all seven again.
--
-- Every column is nullable on purpose. An item that is not a document must never carry
-- these, and a document with no expiry date (a receipt) is the common case, not a
-- special one.
--
-- Safe to run more than once.

alter table if exists public.items
  add column if not exists doc_type text,
  add column if not exists issuer text,
  add column if not exists doc_number text,
  add column if not exists issued_on text,
  add column if not exists expires_on text;

do $$
begin
  if to_regclass('public.items') is not null then
    execute 'comment on column public.items.doc_type is ''Free-text kind of document: warranty, receipt, insurance, licence, passport, manual.''';
    execute 'comment on column public.items.issuer is ''Who issued it: a shop, a bank, a government office.''';
    execute 'comment on column public.items.doc_number is ''Policy, receipt or document number, when the paper carries one.''';
    execute 'comment on column public.items.issued_on is ''Date of issue, stored as YYYY-MM-DD text.''';
    execute 'comment on column public.items.expires_on is ''Date of expiry, stored as YYYY-MM-DD text. Drives the expiry reminder.''';
    -- Partial: only documents with an expiry are ever looked up by this column, and it is the
    -- one that decides who gets reminded. A plain index would carry every task and event.
    execute 'create index if not exists items_expiry_idx on public.items (household_id, expires_on) where kind = ''document'' and expires_on is not null and archived_at is null';
  end if;
end
$$;