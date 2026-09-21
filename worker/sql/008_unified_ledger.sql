-- Unified ledger: `issues` now holds BOTH Mongo-detected issues (source 'mongo', resolved by DMS) and issues the
-- owner adds by hand (source 'manual', resolved by a person). Safe to re-run; additive except the two relaxed checks.

-- Categories are data now (any legacy tag / new category can be used); state gains 'draft' (imported, not yet sent).
alter table public.issues drop constraint if exists issues_category_check;
alter table public.issues drop constraint if exists issues_state_check;
alter table public.issues add constraint issues_state_check check (state in ('draft','open','cleared'));

alter table public.issues
  add column if not exists source            text not null default 'mongo' check (source in ('mongo','manual')),
  add column if not exists title             text,              -- manual: campaign / subject shown in the list
  add column if not exists issue_text        text,              -- manual: the text shown to the person in the nudge
  add column if not exists legacy_record_id  uuid unique,       -- link to the old tracker record this came from
  add column if not exists auto_followups    boolean not null default true,   -- false = parked: never nudged by the automation
  add column if not exists resolved_by       text,
  add column if not exists notes             text;

create index if not exists issues_source_state_idx on public.issues (source, state);
