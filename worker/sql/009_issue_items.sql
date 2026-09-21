-- Applied to the live database on 2026-09-21 (safe to re-run).
-- One row per INDIVIDUAL pending item (each invoice, each creator link, each screenshot upload), so the nudge ladder
-- (and the manager copy from the 4th nudge) counts per item, not per campaign or per person.
create table if not exists public.issue_items (
  id              uuid primary key default gen_random_uuid(),
  issue_id        uuid not null references public.issues(id) on delete cascade,
  item_key        text not null,
  item_created_at timestamptz,
  first_seen_at   timestamptz not null default now(),
  nudge_count     int not null default 0,
  last_nudged_at  timestamptz,
  state           text not null default 'open' check (state in ('open','cleared')),
  cleared_at      timestamptz,
  unique (issue_id, item_key)
);
create index if not exists issue_items_open_idx on public.issue_items (issue_id) where state = 'open';
alter table public.issue_items enable row level security;
revoke all on public.issue_items from anon, authenticated;
grant select, insert, update, delete on public.issue_items to service_role;
