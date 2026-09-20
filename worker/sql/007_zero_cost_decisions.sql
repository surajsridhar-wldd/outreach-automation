-- Applied to the live database on 2026-09-21 (safe to re-run).
-- The owner's permanent decisions about zero-cost-service cases: "exclude" (never nudge) or "nudge" (always nudge,
-- even if the note looks like an AI / Chiraiya case). Keyed by campaign + service.
create table if not exists public.zero_cost_decisions (
  id          uuid primary key default gen_random_uuid(),
  campaign_id text not null,
  service_id  text not null,
  campaign_name text,
  service     text,
  decision    text not null check (decision in ('exclude','nudge')),
  reason      text,
  note_at_decision text,
  decided_by  text,
  decided_at  timestamptz not null default now(),
  unique (campaign_id, service_id)
);
alter table public.zero_cost_decisions enable row level security;
revoke all on public.zero_cost_decisions from anon, authenticated;
grant select, insert, update, delete on public.zero_cost_decisions to service_role;
alter table public.review_items add column if not exists payload jsonb;
