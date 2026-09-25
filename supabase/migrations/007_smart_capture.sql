-- Phase 3 smart capture support.
--
-- The app keeps public.items as its reminder-compatible source of truth. These
-- columns preserve the original capture text and the result of the local
-- smart-capture parser without changing the existing item workflow.
-- Safe to run more than once.

alter table if exists public.items
  add column if not exists source_type text not null default 'manual',
  add column if not exists raw_text text not null default '',
  add column if not exists capture_metadata jsonb not null default '{}'::jsonb,
  add column if not exists capture_fingerprint text;

create index if not exists items_capture_fingerprint_idx
  on public.items (household_id, capture_fingerprint)
  where capture_fingerprint is not null;

do $$
begin
  if to_regclass('public.items') is not null then
    execute 'comment on column public.items.source_type is ''How the capture was entered: manual, voice, image, file, link, or ai.''';
    execute 'comment on column public.items.raw_text is ''The original user text before smart extraction or formatting.''';
    execute 'comment on column public.items.capture_metadata is ''Phase 3 smart-capture suggestions, source, and optional tags.''';
    execute 'comment on column public.items.capture_fingerprint is ''Normalized title fingerprint used for duplicate-capture detection.''';
  end if;
end
$$;
